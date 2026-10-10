/**
 * WorkBuddy LLM adapter: OpenAI Chat Completions over the WorkBuddy gateway.
 *
 * Wire facts (verified against the installed CodeBuddy CLI):
 *   baseURL  = `<endpoint>/v2`          (endpoint = https://www.workbuddy.cn)
 *   path     = `/chat/completions`
 *   auth     = `Authorization: Bearer <accessToken>` (+ `X-User-Id`)
 *   identity = the gateway verifies the caller looks like an official client, so
 *              the official-client `User-Agent` is required (see `identityHeaders`)
 *   protocol = OpenAI Chat Completions with SSE streaming and `tool_calls`
 *
 * This module deliberately imports nothing from the host: a plugin loaded by
 * absolute path resolves its bare specifiers from its own directory, and the
 * runtime couples to adapters by duck typing rather than by class identity.
 * Failures are therefore reported as terminal `finish` chunks carrying a stable
 * code, which the runtime accepts in place of a thrown `LlmError`.
 */
import { effectiveContextWindow } from './ctx-window.js';

/** A failure with a stable, runtime-routable code. */
export class WorkBuddyError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'WorkBuddyError';
    this.code = code;
    Object.assign(this, extra);
  }
}

const EFFORT_LABELS = {
  minimal: '最小',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '很高',
  max: '最高',
};

/** Coarse visual-token estimate, mirroring the runtime's neutral fallback. */
function estimateVisualTokens(width, height) {
  return Math.max(1, Math.ceil((width * height) / 750));
}

/** Join the text blocks of one message. */
function textOf(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

/** The modalities one WorkBuddy model accepts. */
function modalitiesFor(model) {
  return model?.supportsImages === true ? ['text', 'image'] : ['text'];
}

/** Map a WorkBuddy model record to the runtime's model-catalog shape. */
function toModelInfo(provider, model, options) {
  const name = options.multiplierInName === false ? model.name : (model.displayName ?? model.name);
  return {
    provider,
    id: model.id,
    name,
    ...(typeof model.description === 'string' && model.description.length > 0 ? { description: model.description } : {}),
    // The WorkBuddy catalog reports `supportsImages` per model (all 20 currently
    // do). Claiming text-only on an image-capable model makes the runtime
    // silently replace every attachment with an "[image omitted…]" placeholder,
    // so this must track the catalog rather than be hardcoded.
    inputModalities: modalitiesFor(model),
  };
}

/**
 * The context window to advertise for one model.
 *
 * The user's per-model selection wins when the model offers that choice;
 * otherwise the catalog's own budget stands. See `lib/ctx-window.js` for why the
 * selection is a reported budget rather than a request field.
 */
function contextWindowFor(model, selection) {
  return effectiveContextWindow(model, selection);
}

/** Map a WorkBuddy model record to the runtime's exact-model shape. */
function toResolvedInfo(provider, model, options, selection) {
  const base = toModelInfo(provider, model, options);
  const efforts = Array.isArray(model.efforts) && model.efforts.length > 0 ? model.efforts : undefined;
  const reasoning = efforts === undefined
    ? undefined
    : {
        efforts: efforts.map((id) => ({ id, name: EFFORT_LABELS[id] ?? id })),
        ...(typeof model.defaultEffort === 'string' && efforts.includes(model.defaultEffort)
          ? { defaultEffort: model.defaultEffort }
          : {}),
      };
  const contextWindow = contextWindowFor(model, selection);
  return {
    ...base,
    ...(typeof contextWindow === 'number' && contextWindow > 0
      ? { context: { contextWindow } }
      : {}),
    ...(typeof model.maxTokens === 'number' && model.maxTokens > 0 ? { defaultMaxTokens: model.maxTokens } : {}),
    ...(reasoning === undefined ? {} : { reasoning }),
  };
}

/** Convert harness request messages into OpenAI `messages`. */
/**
 * Build one user message's `content` array from text, file, and image blocks.
 *
 * DSH never hands an adapter image bytes: an image block carries only a
 * durable reference (`attachmentId`, media type, dimensions), so the adapter
 * resolves the stored bytes itself. Files likewise arrive as a reference, and
 * the runtime's own convention is to give the model a read-only path to read
 * on demand rather than the contents.
 */
async function toUserContent(message, resolveImage) {
  const parts = [];
  for (const block of message.content ?? []) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
      parts.push({ type: 'text', text: block.text });
    } else if (block?.type === 'file') {
      const label = block.file?.name ?? block.file?.attachmentId ?? 'file';
      parts.push({
        type: 'text',
        text: `[attached file ${label}; read it with a filesystem tool if you need its contents]`,
      });
    } else if (block?.type === 'image' && block.offloaded !== true) {
      const encoded = await resolveImage(block.attachment);
      if (encoded !== undefined) parts.push(encoded);
    }
  }
  if (parts.length === 0) return '';
  const textOnly = parts.every((part) => part.type === 'text');
  return textOnly ? parts.map((part) => part.text).join('') : parts;
}

async function toOpenAiMessages(options, resolveImage) {
  const out = [];
  if (typeof options.system === 'string' && options.system.length > 0) {
    out.push({ role: 'system', content: options.system });
  }
  for (const message of options.messages ?? []) {
    if (message === null || typeof message !== 'object') continue;
    const role = message.role;
    const text = textOf(message.content);
    if (role === 'system' || role === 'developer') {
      if (text.length > 0) out.push({ role: 'system', content: text });
      continue;
    }
    if (role === 'user') {
      const content = await toUserContent(message, resolveImage);
      if (typeof content === 'string' ? content.length > 0 : content.length > 0) {
        out.push({ role: 'user', content });
      }
      continue;
    }
    if (role === 'assistant') {
      const toolCalls = (message.content ?? [])
        .filter((block) => block?.type === 'tool-call')
        .map((block) => ({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: block.arguments ?? '{}' },
        }));
      const entry = { role: 'assistant', content: text.length > 0 ? text : null };
      if (toolCalls.length > 0) entry.tool_calls = toolCalls;
      if (entry.content !== null || toolCalls.length > 0) out.push(entry);
      continue;
    }
    if (role === 'tool') {
      out.push({
        role: 'tool',
        tool_call_id: message.toolCallId,
        content: message.isError === true ? `ERROR: ${text}` : text,
      });
    }
  }
  return out;
}

/** Convert harness tool schemas into OpenAI `tools`. */
function toOpenAiTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description ?? '',
      parameters: tool.parameters ?? { type: 'object', properties: {} },
    },
  }));
}

function mapFailureCode(status) {
  if (status === 401 || status === 403) return 'AUTH';
  if (status === 402) return 'QUOTA';
  if (status === 404) return 'NO_ADAPTER';
  if (status === 429) return 'RATE_LIMIT';
  if (status >= 500) return 'TRANSPORT';
  return 'TRANSPORT';
}

/** Parse one SSE body into `data:` payload strings. */
async function* sseLines(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (line.startsWith('data:')) yield line.slice(5).trim();
    }
  }
  buffer += decoder.decode();
  for (const line of buffer.split('\n')) {
    const trimmed = line.replace(/\r$/, '');
    if (trimmed.startsWith('data:')) yield trimmed.slice(5).trim();
  }
}

export class WorkBuddyAdapter {
  /**
   * @param options.provider - the registered route id.
   * @param options.displayName - picker group heading.
   * @param options.getCatalog - () => catalog snapshot.
   * @param options.resolveConnection - async () => { baseURL, token, userId }.
   * @param options.identityHeaders - () => the client-identity header set.
   * @param options.multiplierInName - whether the 倍率 is appended to the model name.
   * @param options.requestTimeoutMs - per-request timeout.
   */
  constructor(options) {
    this.options = options;
    this.provider = options.provider;
  }

  providerInfo(provider) {
    return { id: provider, name: this.options.displayName };
  }

  /** No adapter-owned retry policy; the default normal policy applies. */
  providerRetryPolicy() {
    return undefined;
  }

  /** No adapter-owned image pricing: the runtime falls back to its own neutral estimate. */
  imageRequestPricing() {
    return undefined;
  }

  /**
   * Turn one durable image reference into an OpenAI `image_url` part.
   *
   * The runtime supplies only a reference (`attachmentId`), never bytes, so the
   * host attachment store is asked for a readable path; that path is read here
   * and inlined as a data URL. A reference that cannot be resolved contributes
   * a placeholder instead of being dropped silently, so an image the user
   * attached is always accounted for in the request the model sees.
   */
  async resolveImage(ref) {
    if (ref === undefined || ref === null) return undefined;
    const provider = this.options.attachments;
    const dataUrl = provider === undefined ? undefined : await provider.imageDataUrl(ref).catch(() => undefined);
    if (typeof dataUrl === 'string' && dataUrl.length > 0) {
      return { type: 'image_url', image_url: { url: dataUrl } };
    }
    const label = ref.name ?? String(ref.attachmentId ?? 'image');
    return { type: 'text', text: `[image ${label} could not be read from local attachment storage]` };
  }

  findModel(modelId) {
    const catalog = this.options.getCatalog();
    return catalog.models.find((model) => model.id === modelId);
  }

  /**
   * The stored context-length choice for one model, or undefined when unset.
   * Read through the adapter so a stored value survives a plugin reload without
   * the caller needing to know how persistence works.
   */
  selectionFor(modelId) {
    const store = this.options.selections;
    if (store === undefined || typeof store.get !== 'function') return undefined;
    return store.get(modelId);
  }

  listModels(provider) {
    const catalog = this.options.getCatalog();
    return Promise.resolve(catalog.models.map((model) => toModelInfo(provider, model, this.options)));
  }

  resolveModel(provider, model) {
    const found = this.findModel(model);
    if (found === undefined) {
      // Core routing accepts unlisted ids; describe it with neutral defaults.
      return Promise.resolve({
        provider,
        id: model,
        name: model,
        inputModalities: ['text'],
        // An unknown id carries no catalog record, so no image capability can
        // be claimed for it.
        ...(this.options.defaultContextWindow > 0
          ? { context: { contextWindow: this.options.defaultContextWindow } }
          : {}),
        ...(this.options.defaultMaxTokens > 0 ? { defaultMaxTokens: this.options.defaultMaxTokens } : {}),
      });
    }
    return Promise.resolve(toResolvedInfo(provider, found, this.options, this.selectionFor(found.id)));
  }

  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options),
    };
  }

  /** Every failure becomes one terminal `finish` chunk with a stable code. */
  async *stream(options) {
    try {
      yield* this.run(options);
    } catch (error) {
      const code = typeof error?.code === 'string' && error.code.length > 0 ? error.code : 'UNKNOWN';
      const aborted = code === 'ABORTED' || options?.signal?.aborted === true;
      yield {
        type: 'finish',
        reason: {
          kind: aborted ? 'aborted' : 'error',
          failure: {
            message: String(error?.message ?? error),
            code: aborted ? 'ABORTED' : code,
            ...(typeof error?.status === 'number' ? { status: error.status } : {}),
          },
        },
      };
    }
  }

  async *run(options) {
    const connection = await this.options.resolveConnection();
    const url = `${connection.baseURL.replace(/\/+$/, '')}/chat/completions`;
    const body = {
      model: options.model,
      messages: await toOpenAiMessages(options, (ref) => this.resolveImage(ref)),
      stream: true,
      stream_options: { include_usage: true },
    };
    const tools = toOpenAiTools(options.tools);
    if (tools !== undefined) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    if (typeof options.temperature === 'number') body.temperature = options.temperature;
    if (typeof options.maxTokens === 'number' && options.maxTokens > 0) body.max_tokens = options.maxTokens;
    if (typeof options.reasoningEffort === 'string' && options.reasoningEffort.length > 0) {
      body[this.options.reasoningEffortField] = options.reasoningEffort;
    }

    const headers = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      authorization: `Bearer ${connection.token}`,
      ...this.options.identityHeaders(),
      // Channel verification inspects the user-agent, so attribution cannot ride
      // there; it is carried in its own header instead.
      'x-dsh-attribution': 'deepseek-harness (+https://github.com/deepseek-ai/deepseek-harness)',
    };
    if (typeof connection.userId === 'string' && connection.userId.length > 0) {
      headers['x-user-id'] = connection.userId;
    }

    const timeoutMs = this.options.requestTimeoutMs;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined;

    let response;
    try {
      response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
    } catch (error) {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (options.signal?.aborted === true) {
        throw new WorkBuddyError('request aborted by the caller', 'ABORTED');
      }
      throw new WorkBuddyError(`workbuddy: request to ${url} failed: ${error?.message ?? error}`, 'TRANSPORT');
    }

    if (!response.ok) {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      const detail = await response.text().catch(() => '');
      const trimmed = detail.length > 600 ? `${detail.slice(0, 600)}…` : detail;
      const code = mapFailureCode(response.status);
      const hint = code === 'AUTH'
        ? ' (the WorkBuddy token is missing, expired, or the caller failed channel verification)'
        : '';
      throw new WorkBuddyError(
        `workbuddy "${options.model}" failed with HTTP ${response.status}${hint}: ${trimmed}`,
        code,
        { status: response.status },
      );
    }

    try {
      yield* this.consume(response.body, options);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  /** Translate one OpenAI SSE stream into runtime chunks. */
  async *consume(body, options) {
    const blocks = new Map();
    const opened = [];
    let nextIndex = 0;
    let usage;
    let finishReason;
    let sawAny = false;

    const ensure = (key, blockType) => {
      let entry = blocks.get(key);
      if (entry === undefined) {
        entry = { index: nextIndex++, blockType, text: '', id: undefined, name: undefined, args: '' };
        blocks.set(key, entry);
        opened.push(entry);
      }
      return entry;
    };

    for await (const payload of sseLines(body)) {
      if (payload.length === 0) continue;
      if (payload === '[DONE]') break;
      let parsed;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }
      if (parsed.usage !== undefined && parsed.usage !== null) {
        usage = {
          inputTokens: parsed.usage.prompt_tokens ?? 0,
          outputTokens: parsed.usage.completion_tokens ?? 0,
          ...(typeof parsed.usage.total_tokens === 'number' ? { totalTokens: parsed.usage.total_tokens } : {}),
          ...(typeof parsed.usage.prompt_tokens_details?.cached_tokens === 'number'
            ? { cacheReadTokens: parsed.usage.prompt_tokens_details.cached_tokens }
            : {}),
          ...(typeof parsed.usage.completion_tokens_details?.reasoning_tokens === 'number'
            ? { reasoningTokens: parsed.usage.completion_tokens_details.reasoning_tokens }
            : {}),
        };
      }
      const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : undefined;
      if (choice === undefined) continue;

      const thinking = choice.delta?.reasoning_content ?? choice.delta?.reasoning;
      if (typeof thinking === 'string' && thinking.length > 0) {
        const entry = ensure('reasoning', 'reasoning');
        if (entry.text.length === 0) yield { type: 'block-start', index: entry.index, blockType: 'reasoning' };
        entry.text += thinking;
        sawAny = true;
        yield { type: 'reasoning-delta', index: entry.index, text: thinking };
      }

      const content = choice.delta?.content;
      if (typeof content === 'string' && content.length > 0) {
        const entry = ensure('text', 'text');
        if (entry.text.length === 0) yield { type: 'block-start', index: entry.index, blockType: 'text' };
        entry.text += content;
        sawAny = true;
        yield { type: 'text-delta', index: entry.index, text: content };
      }

      for (const [position, call] of (choice.delta?.tool_calls ?? []).entries()) {
        const key = `tool:${call.index ?? position}`;
        const entry = ensure(key, 'tool-call');
        if (entry.id === undefined) {
          entry.id = typeof call.id === 'string' && call.id.length > 0 ? call.id : `call_${key}`;
          entry.name = call.function?.name;
          yield { type: 'block-start', index: entry.index, blockType: 'tool-call' };
        } else if (entry.name === undefined && typeof call.function?.name === 'string') {
          entry.name = call.function.name;
        }
        const delta = call.function?.arguments;
        entry.args += typeof delta === 'string' ? delta : '';
        sawAny = true;
        yield {
          type: 'tool-call-delta',
          index: entry.index,
          id: entry.id,
          ...(entry.name === undefined ? {} : { name: entry.name }),
          argumentsDelta: typeof delta === 'string' ? delta : '',
        };
      }

      if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason;
    }

    for (const entry of [...opened].sort((a, b) => a.index - b.index)) {
      if (entry.blockType === 'text') {
        yield { type: 'block-end', index: entry.index, block: { type: 'text', text: entry.text } };
      } else if (entry.blockType === 'reasoning') {
        yield { type: 'block-end', index: entry.index, block: { type: 'reasoning', text: entry.text } };
      } else {
        yield {
          type: 'block-end',
          index: entry.index,
          block: { type: 'tool-call', id: entry.id, name: entry.name ?? 'unknown_tool', arguments: entry.args },
        };
      }
    }

    if (usage !== undefined) yield { type: 'usage', usage };

    const hasToolCalls = opened.some((entry) => entry.blockType === 'tool-call');
    const reason = finishReason === 'tool_calls' || (finishReason === undefined && hasToolCalls)
      ? { kind: 'tool-calls' }
      : finishReason === 'length'
        ? { kind: 'max-tokens' }
        : { kind: 'stop' };
    if (!sawAny && options.signal?.aborted === true) {
      yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'request aborted', code: 'ABORTED' } } };
      return;
    }
    yield { type: 'finish', reason };
  }
}
