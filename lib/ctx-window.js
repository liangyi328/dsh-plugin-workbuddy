/**
 * Per-model context-length selection: durable storage and effective-budget
 * resolution.
 *
 * Why this exists — the WorkBuddy catalogue marks some models adjustable via
 * `contextWindow.supportedLengths` (two or more lengths), while the rest have a
 * fixed window. In WorkBuddy itself the chosen length is a *client-side budget*:
 * it never appears in the HTTP request (verified against the shipped CLI), and
 * only moves the auto-compaction trigger and the usage denominator. So here the
 * selection does the one thing that is real and observable: it decides the
 * `context.contextWindow` this plugin advertises to the runtime, which is what
 * the runtime uses to schedule compaction and truncation.
 *
 * The contract with the CLI is reproduced exactly (see `resolveEffectiveContextBudget`
 * in `codebuddy-lite-wb.mjs`): an override counts only when it is one of the
 * model's surviving supported lengths; otherwise the model's own
 * `defaultLength` stands, falling back to the first length, then `maxInputTokens`.
 *
 * Selection is stored per model id, so switching models never carries a stale
 * override across to a model that cannot honour it — the same reconciliation the
 * CLI performs on model change.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Bump when the on-disk shape changes, so a stale file is discarded, not misread. */
export const CONTEXT_STORE_STAMP = 'wb-ctx-v1';

/** Version marker of an accepted store file. */
const STORE_VERSION = 1;

/** The lengths a model offers, or undefined when it is not adjustable. */
export function optionsFor(model) {
  return Array.isArray(model?.supportedContextLengths) && model.supportedContextLengths.length >= 2
    ? [...model.supportedContextLengths]
    : undefined;
}

/**
 * The budget a model should report when `override` is absent or unusable.
 * Mirrors the CLI: defaultLength -> first supported length -> maxInputTokens.
 */
function fallbackBudget(model) {
  const options = optionsFor(model);
  if (typeof model?.contextWindow === 'number' && Number.isSafeInteger(model.contextWindow) && model.contextWindow > 0) {
    return model.contextWindow;
  }
  if (options !== undefined) return options[0];
  if (typeof model?.maxInputTokens === 'number' && Number.isSafeInteger(model.maxInputTokens) && model.maxInputTokens > 0) {
    return model.maxInputTokens;
  }
  return undefined;
}

/**
 * The context window to advertise for `model`, honouring a stored override.
 *
 * An override is only accepted when the model is adjustable and the value is one
 * of its surviving supported lengths — otherwise it is ignored rather than
 * clamped, so a value from a previous model can never silently widen this one.
 *
 * @param {object} model - a normalized catalog model.
 * @param {number} [override] - the user's stored choice for this model.
 * @returns {number|undefined} the budget to report, or undefined when unknown.
 */
export function effectiveContextWindow(model, override) {
  const options = optionsFor(model);
  if (options !== undefined && typeof override === 'number' && options.includes(override)) {
    return override;
  }
  return fallbackBudget(model);
}

/**
 * Whether `model` offers a genuine choice. A single surviving option is not a
 * choice: it is what the model would use anyway.
 */
export function isAdjustable(model) {
  return optionsFor(model) !== undefined;
}

/**
 * Read the durable selection map, tolerating absence and corruption.
 * @returns {Map<string, number>} model id -> chosen length.
 */
export function readSelections(file) {
  const empty = new Map();
  if (typeof file !== 'string' || file.length === 0) return empty;
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return empty;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (data === null || typeof data !== 'object') return empty;
  if (data.stamp !== CONTEXT_STORE_STAMP || data.version !== STORE_VERSION) return empty;
  const out = new Map();
  const entries = data.selections;
  if (entries === null || typeof entries !== 'object') return out;
  for (const [id, value] of Object.entries(entries)) {
    if (typeof id !== 'string' || id.length === 0) continue;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) continue;
    out.set(id, value);
  }
  return out;
}

/** Persist the selection map atomically, so a crash cannot leave a partial file. */
export function writeSelections(file, selections) {
  if (typeof file !== 'string' || file.length === 0) return false;
  const entries = {};
  for (const [id, value] of selections) {
    if (typeof id === 'string' && id.length > 0
      && typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
      entries[id] = value;
    }
  }
  const payload = `${JSON.stringify({
    stamp: CONTEXT_STORE_STAMP,
    version: STORE_VERSION,
    selections: entries,
  }, undefined, 2)}\n`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Write to a sibling temp file and rename, so readers never observe a
    // half-written map and a crash mid-write leaves the previous file intact.
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, payload, 'utf8');
    fs.renameSync(temp, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * The mutable selection store: an in-memory map backed by a JSON file.
 *
 * Kept deliberately small and synchronous. It is read on every `resolveModel`
 * (which the runtime calls per turn) and written only when the user changes a
 * value, so a cache with a mtime check is enough; there is no concurrency to
 * arbitrate because only the host process owns this file.
 */
export class ContextWindowStore {
  /**
   * @param options.file - path of the JSON store (empty disables persistence).
   * @param options.cacheMs - how long an on-disk read may be reused.
   */
  constructor(options = {}) {
    this.file = options.file ?? '';
    this.cacheMs = typeof options.cacheMs === 'number' ? options.cacheMs : 2000;
    this.cache = undefined;
    this.cachedAt = 0;
  }

  /** The current selection for `modelId`, or undefined when unset. */
  get(modelId) {
    const now = Date.now();
    if (this.cache === undefined || now - this.cachedAt > this.cacheMs) {
      this.cache = readSelections(this.file);
      this.cachedAt = now;
    }
    return this.cache.get(modelId);
  }

  /**
   * Commit one model's selection.
   *
   * `value` is validated against the model's own options by the caller; this
   * layer only enforces shape. Returns the stored value, or undefined when the
   * model is cleared.
   */
  set(modelId, value) {
    const next = new Map(this.read());
    if (value === undefined || value === null) next.delete(modelId);
    else next.set(modelId, value);
    writeSelections(this.file, next);
    this.cache = next;
    this.cachedAt = Date.now();
    return value;
  }

  /** Drop stored selections for models the catalog no longer offers. */
  prune(validIds) {
    const current = this.read();
    const valid = new Set(validIds);
    let changed = false;
    const next = new Map();
    for (const [id, value] of current) {
      if (valid.has(id)) next.set(id, value);
      else changed = true;
    }
    if (!changed) return false;
    writeSelections(this.file, next);
    this.cache = next;
    this.cachedAt = Date.now();
    return true;
  }

  /** Read through the cache, so `set`/`prune` do not double-load. */
  read() {
    const now = Date.now();
    if (this.cache === undefined || now - this.cachedAt > this.cacheMs) {
      this.cache = readSelections(this.file);
      this.cachedAt = now;
    }
    return this.cache;
  }
}

/** Default store location inside the WorkBuddy home directory. */
export function defaultStorePath(workBuddyHome) {
  return path.join(workBuddyHome, 'dsh-context-window.json');
}