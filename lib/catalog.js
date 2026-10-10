/**
 * WorkBuddy catalog: model list, per-model credit multiplier (倍率) and live promotions.
 *
 * Two sources are merged:
 *  - `cli/product.json`            — the shipped base catalog (per app version)
 *  - `storage/**\/wb-product-config.json` — the server-delivered, account-scoped snapshot
 *
 * The account snapshot wins, because the two disagree (e.g. `deepseek-v4-flash` is
 * x0.06 in the base catalog and x0.17 for this account).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Candidate install roots for the WorkBuddy desktop app. */
function candidateBaseCatalogPaths() {
  const out = [];
  const suffix = ['resources', 'app.asar.unpacked', 'cli', 'product.json'];
  const home = os.homedir();
  // The desktop app is installed per-user, but not necessarily on the drive the
  // profile lives on (this machine keeps LOCALAPPDATA on C: and the app on F:).
  const perUser = [...path.join('Users', path.basename(home), 'AppData', 'Local', 'Programs', 'WorkBuddy').split(path.sep)];
  if (process.env.LOCALAPPDATA) out.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'WorkBuddy', ...suffix));
  if (process.env.PROGRAMFILES) out.push(path.join(process.env.PROGRAMFILES, 'WorkBuddy', ...suffix));
  for (let code = 67; code <= 90; code += 1) {
    out.push(path.join(`${String.fromCharCode(code)}:\\`, ...perUser, ...suffix));
  }
  if (process.platform === 'darwin') {
    out.push('/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/product.json');
  }
  out.push('/opt/WorkBuddy/resources/app.asar.unpacked/cli/product.json');
  return out;
}

/** The WorkBuddy configuration directory (`~/.workbuddy`). */
export function workBuddyHome(override) {
  if (override && override.length > 0) return override;
  const fromEnv = process.env.WORKBUDDY_CONFIG_DIR;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();
  return path.join(os.homedir(), '.workbuddy');
}

/** Find `wb-product-config.json` snapshots under the WorkBuddy storage tree. */
function findAccountSnapshots(home) {
  const root = path.join(home, 'storage');
  const hits = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name === 'wb-product-config.json') hits.push(full);
    }
  };
  walk(root, 0);
  return hits;
}

/** Parse a `credits` string such as `"x0.16 credits"`, `"x0.17"` or `"0x"` into a number. */
export function parseMultiplier(value) {
  if (typeof value !== 'string') return undefined;
  const match = value.match(/(\d+(?:\.\d+)?)/);
  if (match === null) return undefined;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : undefined;
}

/** `12.5` -> `"12.5"`, `0.06` -> `"0.06"`, `1` -> `"1"`. */
export function formatMultiplier(n) {
  if (n === undefined) return undefined;
  return String(Number(n.toFixed(4)));
}

/** Wall-clock parts of `now` inside `timeZone`. */
function partsInZone(now, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${hour}:${parts.minute}` };
}

/** `"23:00"`.."7:50"` windows wrap past midnight. */
function inDailyWindow(time, start, end) {
  if (start <= end) return time >= start && time < end;
  return time >= start || time < end;
}

/**
 * Resolve the promotion that currently applies to `modelId`.
 * @returns {{factor:number,label?:string,color?:string,id:string,text?:string}|undefined}
 */
export function activePromotion(promotions, modelId, now = new Date()) {
  let best;
  for (const promo of promotions ?? []) {
    if (promo?.enabled === false) continue;
    if (!Array.isArray(promo?.modelIds) || !promo.modelIds.includes(modelId)) continue;
    const schedule = promo.schedule ?? {};
    const tz = schedule.timezone || 'Asia/Shanghai';
    const { date, time } = partsInZone(now, tz);
    if (typeof schedule.validFrom === 'string' && Date.parse(schedule.validFrom) > now.getTime()) continue;
    if (typeof schedule.validUntil === 'string' && Date.parse(schedule.validUntil) <= now.getTime()) continue;
    if (Array.isArray(schedule.daily) && schedule.daily.length > 0) {
      const hit = schedule.daily.some((w) => inDailyWindow(time, w.start, w.end));
      if (!hit) continue;
    }
    const factor = promo?.discount?.factor;
    const candidate = {
      id: promo.id,
      factor: typeof factor === 'number' ? factor : 1,
      label: promo?.badge?.label,
      color: promo?.badge?.color,
      discountedCredits: promo?.discount?.discountedCredits,
      text: promo?.hover?.textZh ?? promo?.hover?.textEn,
      priority: typeof promo.priority === 'number' ? promo.priority : 0,
      startsAt: date,
    };
    if (best === undefined || candidate.priority > best.priority) best = candidate;
  }
  return best;
}

/**
 * A usable context-length choice is a positive safe integer that the model's own
 * ceiling accepts. This mirrors the shipped CLI filter, which drops anything
 * non-integer, non-positive, or above `maxInputTokens`.
 */
function normalizeLengths(lengths, maxInputTokens) {
  return [...new Set((Array.isArray(lengths) ? lengths : [])
    .filter((n) => typeof n === 'number' && Number.isSafeInteger(n) && n > 0
      && (typeof maxInputTokens !== 'number' || n <= maxInputTokens)))]
    .sort((a, b) => a - b);
}

/**
 * `300000` -> `"300K"`, `1000000` -> `"1M"`, otherwise the plain number.
 * Same rendering rule as the WorkBuddy CLI's context-window picker.
 */
export function formatContextLength(n) {
  if (typeof n !== 'number') return String(n);
  if (n >= 1e6 && n % 1e6 === 0) return `${n / 1e6}M`;
  if (n >= 1e3 && n % 1e3 === 0) return `${n / 1e3}K`;
  return String(n);
}

/** Normalize one raw catalog entry from either source. */
export function normalizeModel(raw) {
  if (raw === null || typeof raw !== 'object' || typeof raw.id !== 'string' || raw.id.length === 0) return undefined;
  const credits = parseMultiplier(raw.credits);
  const reasoning = raw.reasoning ?? {};
  const supported = Array.isArray(reasoning.supportedEfforts) ? reasoning.supportedEfforts : undefined;
  const single = typeof reasoning.effort === 'string' ? [reasoning.effort] : undefined;
  const efforts = supported ?? single;
  const maxInputTokens = typeof raw.maxInputTokens === 'number' ? raw.maxInputTokens : undefined;
  const supportedLengths = normalizeLengths(raw.contextWindow?.supportedLengths, maxInputTokens);
  // Only a model offering two or more surviving lengths is genuinely adjustable:
  // a single remaining option is what it would use regardless, so presenting a
  // choice would be a no-op. This is the same `length >= 2` test the CLI applies
  // before it offers a `context_window` select at all.
  const adjustable = supportedLengths.length >= 2;
  // `defaultLength` is the budget in force with no override. Keep the catalog's
  // own value rather than assuming the first option, because it need not be the
  // smallest (space-bunny defaults to its maximum).
  const contextWindow = adjustable
    ? (typeof raw.contextWindow?.defaultLength === 'number' ? raw.contextWindow.defaultLength : supportedLengths[0])
    : (typeof raw.contextWindow?.defaultLength === 'number'
      ? raw.contextWindow.defaultLength
      : (typeof maxInputTokens === 'number' ? maxInputTokens : undefined));
  return {
    id: raw.id,
    name: typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : raw.id,
    credits,
    contextWindow,
    supportedContextLengths: adjustable ? supportedLengths : undefined,
    maxAllowedSize: typeof raw.maxAllowedSize === 'number' ? raw.maxAllowedSize : undefined,
    maxTokens: typeof raw.maxOutputTokens === 'number' ? raw.maxOutputTokens : undefined,
    maxInputTokens,
    supportsToolCall: raw.supportsToolCall === true,
    supportsImages: raw.supportsImages === true,
    supportsReasoning: raw.supportsReasoning === true,
    onlyReasoning: raw.onlyReasoning === true,
    efforts: efforts === undefined ? undefined : [...new Set(efforts.filter((e) => typeof e === 'string'))],
    defaultEffort: typeof reasoning.defaultEffort === 'string'
      ? reasoning.defaultEffort
      : (typeof reasoning.effort === 'string' ? reasoning.effort : undefined),
    description: raw.descriptionZh ?? raw.descriptionEn,
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    vendor: raw.vendor,
  };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Load the shipped base catalog. */
export function loadBaseCatalog(explicitPath) {
  const candidates = explicitPath && explicitPath.length > 0 ? [explicitPath] : candidateBaseCatalogPaths();
  for (const file of candidates) {
    try {
      const data = readJson(file);
      if (Array.isArray(data?.models)) {
        return { source: file, savedAt: undefined, endpoint: data.endpoint, models: data.models, promotions: [], tiers: [], features: {}, creditPurchaseActions: {} };
      }
    } catch {
      /* try the next candidate */
    }
  }
  return undefined;
}

/** Load the newest account-scoped snapshot under `~/.workbuddy/storage`. */
export function loadAccountCatalog(home, explicitPath) {
  const files = explicitPath && explicitPath.length > 0 ? [explicitPath] : findAccountSnapshots(home);
  let best;
  for (const file of files) {
    try {
      const data = readJson(file);
      const snap = data?.['product-config-snapshot'];
      const payload = snap?.data ?? data?.data ?? data;
      if (!Array.isArray(payload?.models)) continue;
      const savedAt = typeof snap?.savedAt === 'number' ? snap.savedAt : 0;
      if (best === undefined || savedAt > best.savedAt) {
        best = {
          source: file,
          savedAt,
          endpoint: payload.endpoint,
          models: payload.models,
          promotions: Array.isArray(payload.modelPromotions) ? payload.modelPromotions : [],
          tiers: Array.isArray(payload.modelTiers) ? payload.modelTiers : [],
          features: payload.productFeatures ?? {},
          creditPurchaseActions: payload.creditPurchaseActions ?? {},
          agents: Array.isArray(payload.agents) ? payload.agents : [],
        };
      }
    } catch {
      /* skip unreadable snapshot */
    }
  }
  return best;
}

/**
 * Build the effective catalog: the account snapshot when present, otherwise the
 * shipped base catalog, optionally extended with base-only models.
 */
export function loadCatalog(options = {}) {
  const home = workBuddyHome(options.workBuddyHome);
  const account = loadAccountCatalog(home, options.accountConfigPath);
  const base = loadBaseCatalog(options.baseProductJsonPath);
  const chosen = account ?? base;
  if (chosen === undefined) {
    return { models: [], promotions: [], tiers: [], features: {}, creditPurchaseActions: {}, source: undefined, savedAt: undefined, account: undefined, base: undefined };
  }
  const byId = new Map();
  for (const raw of base?.models ?? []) {
    const model = normalizeModel(raw);
    if (model !== undefined) byId.set(model.id, model);
  }
  if (account === undefined || options.includeBaseOnly === true) {
    // Base entries fill gaps; account entries then overwrite them.
    for (const raw of chosen.models) {
      const model = normalizeModel(raw);
      if (model !== undefined) byId.set(model.id, model);
    }
  } else {
    for (const raw of chosen.models) {
      const model = normalizeModel(raw);
      if (model !== undefined) byId.set(model.id, model);
    }
  }

  const now = options.now ?? new Date();
  // The `cli` agent row lists the models the installed CLI will actually run,
  // which excludes completion/codewise internals that are not chat models.
  const cliAgent = (account?.agents ?? []).find((agent) => agent?.name === 'cli');
  const cliModelIds = Array.isArray(cliAgent?.models) && cliAgent.models.length > 0
    ? new Set(cliAgent.models)
    : undefined;

  const models = [];
  for (const model of byId.values()) {
    if (options.scope === 'cli' && cliModelIds !== undefined && !cliModelIds.has(model.id)) continue;
    if (Array.isArray(options.onlyModels) && options.onlyModels.length > 0 && !options.onlyModels.includes(model.id)) continue;
    const promo = activePromotion(chosen.promotions, model.id, now);
    const factor = promo?.factor ?? 1;
    const effective = model.credits === undefined ? undefined : Number((model.credits * factor).toFixed(6));
    models.push({ ...model, discount: promo, effectiveCredits: effective, discountFactor: factor });
  }
  models.sort((a, b) => {
    const ac = a.effectiveCredits ?? a.credits;
    const bc = b.effectiveCredits ?? b.credits;
    if (ac === undefined && bc === undefined) return a.name.localeCompare(b.name);
    if (ac === undefined) return 1;
    if (bc === undefined) return -1;
    return ac - bc;
  });
  // Distinct models can share a display name (Hy3 / Hy3-b / Hy3-c); the picker
  // renders the name alone, so a collision would be ambiguous there.
  const seenLabels = new Map();
  for (const model of models) {
    let label = displayNameFor(model);
    const count = seenLabels.get(label) ?? 0;
    seenLabels.set(label, count + 1);
    if (count > 0) label = `${label} [${model.id}]`;
    model.displayName = label;
  }

  return {
    models,
    promotions: chosen.promotions,
    tiers: chosen.tiers,
    features: chosen.features,
    creditPurchaseActions: chosen.creditPurchaseActions,
    cliModelIds,
    source: chosen.source,
    savedAt: chosen.savedAt,
    account,
    base,
  };
}

/** Bump when changing the model normalization; logged at startup so a stale
 *  in-memory module is distinguishable from a code bug. */
export const CATALOG_STAMP = 'ctx-lengths-v1';

/** The display name carrying the 倍率, e.g. `"Deepseek-V4-Flash ×0.17"`. */
export function displayNameFor(model, options = {}) {
  const credits = model.effectiveCredits ?? model.credits;
  if (options.multiplierInName === false || credits === undefined) return model.name;
  const shown = formatMultiplier(credits);
  const struck = model.discount !== undefined && model.credits !== undefined && credits !== model.credits
    ? ` (原价 ×${formatMultiplier(model.credits)})`
    : '';
  return `${model.name} ×${shown}${struck}`;
}
