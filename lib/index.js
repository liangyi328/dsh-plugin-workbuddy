/**
 * WorkBuddy provider for DeepSeek Harness.
 *
 * Registers one LLM provider route (`workbuddy` by default). Models come from the
 * locally cached WorkBuddy product configuration, with each model's credit
 * multiplier (倍率) and currently effective discount baked into its display name.
 *
 * The access token is resolved in this order, so the common case needs no setup:
 *   1. a credential stored through the DSH credentials service (`apiKeyEnv`)
 *   2. the same name in the launching environment
 *   3. this plugin's own device-authorization login (`login.js`)
 *   4. the session the CodeBuddy/WorkBuddy CLI already wrote to disk
 *
 * Step 3 is what makes the plugin self-sufficient: the browser login issues a
 * token from the WorkBuddy realm itself, so it can never be the wrong product
 * channel. Step 4 is a convenience fallback and is why it runs LAST — a CLI
 * session directory can hold tokens for other products (for example
 * `Tencent-Cloud.coding-copilot`), and presenting one of those to the WorkBuddy
 * gateway fails channel verification with business code 11128.
 *
 * This module imports only the packages it declares as dependencies (pnpm
 * installs them alongside the plugin). Host services arrive through `ctx`.
 */
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import z from '@deepseek-ai/schemastery';
import { WorkBuddyAdapter, WorkBuddyError } from './adapter.js';
import { CATALOG_STAMP, loadCatalog, workBuddyHome } from './catalog.js';
import { discoverSession, tokenExpiry, userIdFromToken } from './auth.js';
import {
  credentialState,
  readCredential as readLoginCredential,
  writeCredential as writeLoginCredential,
} from './login-auth.js';
import { DOMESTIC_BASE, WorkBuddyLoginClient } from './login.js';
import { ContextWindowStore, defaultStorePath, effectiveContextWindow, isAdjustable, optionsFor } from './ctx-window.js';
import { TARGET as MENU_TARGET, stripPatch, isPatched } from './menu-patch.js';

const name = 'llm-workbuddy';
// `clientModules` lets uninstallMenuPatch restore the built-in model menu
// bundle in memory, undoing the row injected by an earlier plugin version.
const inject = ['llm', 'clientModules'];
const DEFAULT_PROVIDER = 'workbuddy';
const DEFAULT_TOKEN_REF = 'WORKBUDDY_AUTH_TOKEN';
// The gateway verifies that the caller looks like an official client; this is
// the identity string the shipped CLI sends.
const DEFAULT_CLIENT_UA = 'CLI/2.162.0 CodeBuddy/2.162.0';
// The version the shipped CLI reports; kept beside the User-Agent because
// `X-IDE-Version` carries the same value.
const DEFAULT_CLIENT_VERSION = '2.162.0';
const CREDENTIAL_REF_PATTERN = /^[A-Z][A-Z0-9_]*$/;

const Config = z.object({
  provider: z.string().default(DEFAULT_PROVIDER),
  displayName: z.string().default('WorkBuddy'),
  baseURL: z.string().default('https://www.workbuddy.cn/v2'),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_TOKEN_REF).volatile(),
  userId: z.string().default('').volatile(),
  clientUserAgent: z.string().default(DEFAULT_CLIENT_UA).volatile(),
  // The version the official client reports in `X-IDE-Version`. Kept separate
  // from the User-Agent so either can be adjusted without touching the other.
  clientVersion: z.string().default(DEFAULT_CLIENT_VERSION).volatile(),
  clientHeaders: z.dict(z.string()).default({}).volatile(),
  authDir: z.string().default(''),
  discoverCliSession: z.boolean().default(true),
  // Where this plugin keeps its own login credential (device-authorization
  // login, not a pasted token). Empty uses $DSH_HOME/.dsh-workbuddy-connect.
  loginAuthPath: z.string().default('').volatile(),
  workBuddyHome: z.string().default(''),
  accountConfigPath: z.string().default(''),
  baseProductJsonPath: z.string().default(''),
  // Where the per-model context-length choice is persisted. Empty places it in
  // the WorkBuddy home directory; 'off' disables persistence entirely.
  contextWindowStorePath: z.string().default(''),
  scope: z.string().default('cli'),
  includeBaseOnly: z.boolean().default(false),
  onlyModels: z.array(z.string()).default([]),
  multiplierInName: z.boolean().default(true),
  reasoningEffortField: z.string().default('reasoning_effort'),
  defaultContextWindow: z.number().default(262144),
  defaultMaxTokens: z.number().default(32768),
  requestTimeoutMs: z.number().default(600000),
  // The gateway rate-limits bursts (HTTP 429) with no `Retry-After`. Two knobs
  // keep a turn from ever failing: a minimum gap between chat sends, and how
  // many times a 429 is retried in the adapter before the caller sees it.
  rateLimitMinGapMs: z.number().default(700),
  rateLimitRetries: z.number().default(3),
  catalogRefreshMs: z.number().default(60000),
  debugLogPath: z.string().default(''),
});

/** Read every field once per operation, so a settings edit applies to the next call. */
function plainOptions(config) {
  return {
    provider: config.provider,
    displayName: config.displayName,
    baseURL: config.baseURL,
    apiKeyEnv: config.apiKeyEnv.get(),
    userId: config.userId.get(),
    clientUserAgent: config.clientUserAgent.get(),
    clientVersion: config.clientVersion.get(),
    clientHeaders: { ...config.clientHeaders.get() },
    authDir: config.authDir,
    discoverCliSession: config.discoverCliSession,
    loginAuthPath: config.loginAuthPath.get(),
    workBuddyHome: config.workBuddyHome,
    accountConfigPath: config.accountConfigPath,
    baseProductJsonPath: config.baseProductJsonPath,
    contextWindowStorePath: config.contextWindowStorePath,
    scope: config.scope,
    includeBaseOnly: config.includeBaseOnly,
    onlyModels: [...config.onlyModels],
    multiplierInName: config.multiplierInName,
    reasoningEffortField: config.reasoningEffortField,
    defaultContextWindow: config.defaultContextWindow,
    defaultMaxTokens: config.defaultMaxTokens,
    requestTimeoutMs: config.requestTimeoutMs,
    rateLimitMinGapMs: config.rateLimitMinGapMs,
    rateLimitRetries: config.rateLimitRetries,
    catalogRefreshMs: config.catalogRefreshMs,
    debugLogPath: config.debugLogPath,
  };
}

/** Accept either a raw token or a pasted `Authorization` header value. */
function normalizeToken(raw) {
  const trimmed = raw.trim();
  return trimmed.toLowerCase().startsWith('bearer ') ? trimmed.slice(7).trim() : trimmed;
}

/** A credential must be a header-safe non-empty string. */
function assertUsableToken(raw, refName) {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new WorkBuddyError(`workbuddy: the token resolved from ${refName} is blank`, 'INVALID_CREDENTIAL');
  }
  if (!/^[\x21-\x7E]+$/.test(raw.trim())) {
    throw new WorkBuddyError(
      `workbuddy: the token resolved from ${refName} contains characters no HTTP header can carry`,
      'INVALID_CREDENTIAL',
    );
  }
  return raw;
}

/**
 * The client-identity headers the gateway's channel verification expects.
 *
 * These are not guesses: they are the header set the official `CodeBuddy` CLI
 * actually sends, read out of its shipped bundle
 * (`resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs`):
 *
 *   - `withSecurityHeader()` adds exactly `x-codebuddy-request: 1`
 *   - `buildConversationHeaders()` adds `X-Agent-Intent` (default `craft`),
 *     `X-Agent-Type`, `X-Agent-Purpose`, and the `X-Conversation-*` /
 *     `X-Request-*` correlation ids
 *   - the CLI identity constants are `IDE_TYPE = "CLI"` and
 *     `IDE_NAME = "CodeBuddy"` (module 57893 / 64186)
 *   - `X-Product` comes from the product configuration's `deploymentType`,
 *     which is `"SaaS"` for the hosted realm
 *
 * A token alone is not enough: the gateway rejects a call whose headers do not
 * look like an official client with business code 11128 ("Illegal API
 * invocation from an unapproved channel"). Sending the correlation ids matters
 * too — measured 20/20 accepted with them versus intermittent rejections with
 * the bare token.
 */
function identityHeadersFor(current) {
  let host = '';
  try {
    host = new URL(current.baseURL).host;
  } catch {
    host = '';
  }
  // Per-request correlation ids: the official client mints fresh ones for every
  // message, and reusing them is itself a channel-verification signal.
  const conversationId = randomUUID();
  const requestId = randomUUID().replace(/-/g, '');
  return {
    'user-agent': current.clientUserAgent,
    'x-product': 'SaaS',
    'x-codebuddy-request': '1',
    'x-ide-type': 'CLI',
    'x-ide-name': 'CodeBuddy',
    'x-ide-version': current.clientVersion,
    'x-agent-intent': 'craft',
    'x-agent-purpose': 'conversation',
    'x-conversation-id': conversationId,
    'x-conversation-request-id': conversationId,
    'x-conversation-message-id': requestId,
    'x-request-id': requestId,
    ...(host.length > 0 ? { 'x-domain': host } : {}),
    ...current.clientHeaders,
  };
}

/**
 * Restore the built-in model-menu bundle to its pristine bytes, undoing the
 * in-memory "上下文窗口" row injection from an earlier plugin version. Like the
 * patch itself it only rewrites the in-memory record, so nothing on disk is
 * touched; runs once per boot and is skipped when the bundle is already clean.
 *
 * @param ctx - host plugin context (needs clientModules, or a scoped child of it).
 * @param debugLog - optional diagnostics sink.
 */
function uninstallMenuPatch(ctx, debugLog) {
  debugLog('menu patch: uninstall invoked');
  try {
    const registry = ctx.clientModules;
    if (!registry || !registry.table) {
      debugLog('menu patch: clientModules unavailable; skipped');
      return;
    }
    const record = registry.table.get(MENU_TARGET);
    if (!record) {
      debugLog(`menu patch: "${MENU_TARGET}" not in table yet; skipped`);
      return;
    }
    const text = record.bundle?.toString('utf8');
    if (text === undefined) {
      debugLog('menu patch: record has no bundle; skipped');
      return;
    }
    if (!isPatched(text)) {
      debugLog('menu patch: already pristine');
      return;
    }
    const restored = stripPatch(text);
    if (restored === null) {
      // The marker is present but the block cannot be located: the patched
      // bytes no longer match this plugin's shape (e.g. a DSH update was
      // composed on top). Leave the bundle alone rather than corrupt it.
      debugLog('menu patch: marker present but strip failed; skipped');
      return;
    }
    record.bundle = Buffer.from(restored, 'utf8');
    // Invalidate any already-composed response so the served bytes change too.
    try {
      registry.responses?.clear();
      registry.batchResponses?.clear();
      registry.previousBatchResponses?.clear();
      registry.composed = registry.compose?.();
    } catch {
      /* recomposition is best-effort; a later HMR flush would do it anyway */
    }
    debugLog(`menu patch: removed (${text.length} -> ${restored.length})`);
  } catch (error) {
    debugLog(`menu patch: FAILED ${error?.message ?? error}`);
  }
}

function apply(ctx, config) {
  // Log before anything that can throw: this single line separates "the module
  // was never imported" from "apply() ran and failed here".
  try {
    const target = config?.debugLogPath;
    if (typeof target === 'string' && target.length > 0) {
      fs.appendFileSync(target, `${new Date().toISOString()} apply() entered (code=v11)\n`);
    }
  } catch {
    /* ignore */
  }

  const options = () => plainOptions(config);
  options(); // fail loud on a malformed configuration rather than at first request

  const provider = options().provider;
  let cache;
  let loadedAt = 0;

  // Per-model context-length choices. The store is created once here (rather than
  // per call) so a value written through the HTTP route is immediately visible
  // to the adapter's `resolveModel`, and it re-reads its backing file when stale.
  const storePath = (() => {
    const configured = options().contextWindowStorePath;
    if (configured === 'off') return '';
    if (typeof configured === 'string' && configured.length > 0) return configured;
    return defaultStorePath(workBuddyHome(options().workBuddyHome));
  })();
  const selections = new ContextWindowStore({ file: storePath });

  /** Opt-in breadcrumb trail; a silent startup failure is otherwise invisible. */
  const debugLog = (message) => {
    const target = options().debugLogPath;
    if (typeof target !== 'string' || target.length === 0) return;
    try {
      fs.appendFileSync(target, `${new Date().toISOString()} ${message}\n`);
    } catch {
      /* diagnostics are best-effort and never fail the plugin */
    }
  };

  // Remove the "上下文窗口" row an earlier plugin version injected into the
  // built-in model menu. The menu exposes no slot and its component is not
  // exported, so the restore is also done at the byte level, in memory only.
  // Must run after `debugLog` exists (const bindings are not hoisted).
  uninstallMenuPatch(ctx, debugLog);

  // The client half (额度 pill + 上下文选择器) lives in this same package, but
  // `clientModules` only re-reads bundle bytes through `rebuilt()` — the HMR
  // module watch does not cover plugin files on this host, so a reload alone
  // would keep serving the previous client.js. Publishing our own bundle at
  // apply() makes every reload ship the current client half; unchanged files
  // keep the graph as-is (the call is a no-op), so this is safe on restart.
  try {
    const registry = ctx.clientModules;
    if (registry !== undefined && typeof registry.rebuilt === 'function') {
      // The client bundle is keyed by the PACKAGE name (what package.json
      // declares and the boot graph advertises), not by this loader row id.
      const rev = registry.rebuilt('dsh-plugin-workbuddy');
      debugLog(`client bundle: rebuilt -> ${rev ?? '<unchanged>'}`);
    }
  } catch (error) {
    debugLog(`client bundle: rebuilt FAILED ${error?.message ?? error}`);
  }

  const getCatalog = () => {
    const current = options();
    const now = Date.now();
    if (cache === undefined || now - loadedAt > current.catalogRefreshMs) {
      cache = loadCatalog({
        workBuddyHome: current.workBuddyHome,
        accountConfigPath: current.accountConfigPath,
        baseProductJsonPath: current.baseProductJsonPath,
        scope: current.scope,
        includeBaseOnly: current.includeBaseOnly,
        onlyModels: current.onlyModels,
      });
      loadedAt = now;
      // A model that left the catalog (or lost its adjustable lengths) can no
      // longer honour a stored choice, so drop it rather than carry it forever.
      try {
        selections.prune(cache.models.map((model) => model.id));
      } catch {
        /* pruning is best-effort; a stale entry is ignored at resolve time */
      }
      ctx.logger?.info?.(`llm-workbuddy: loaded ${cache.models.length} models from ${cache.source ?? '<none>'}`);
    }
    return cache;
  };

  // The plugin's own credential, obtained through the device-authorization
  // login in login.js. This is preferred over a discovered CLI session: the
  // login issues a token from the WorkBuddy realm itself, whereas a CLI auth
  // directory can hold a token for a different product channel, which the
  // gateway rejects with business code 11128 (channel verification).
  const loginClient = new WorkBuddyLoginClient({ baseURL: DOMESTIC_BASE });
  let loginCredential = readLoginCredential(options().loginAuthPath);
  let refreshInFlight;

  const persistLogin = (next) => {
    loginCredential = next;
    try {
      writeLoginCredential(next, options().loginAuthPath);
    } catch (error) {
      debugLog(`login auth: persist FAILED ${error?.message ?? error}`);
    }
  };

  /**
   * The plugin's login token, refreshed when it is close to expiring.
   *
   * A refresh token that has itself expired means only a fresh login can help,
   * so that case reports an actionable error instead of a doomed refresh.
   */
  const ensureFreshLoginToken = async () => {
    if (loginCredential === undefined) {
      throw new WorkBuddyError(
        'workbuddy: not signed in. Run "dsh-plugin-workbuddy login" once to authorize '
        + 'this plugin in a browser, or paste a token through the Models page.',
        'MISSING_CREDENTIAL',
      );
    }
    const state = credentialState(loginCredential);
    if (state.state === 'expired') {
      throw new WorkBuddyError(
        `workbuddy: the login credential expired at ${new Date(loginCredential.expiresAtMs).toISOString()}; `
        + 'run "dsh-plugin-workbuddy login" to sign in again',
        'AUTH',
      );
    }
    // Refresh a minute early so a token cannot expire mid-flight.
    const soon = loginCredential.expiresAtMs > 0 && loginCredential.expiresAtMs - Date.now() < 60_000;
    if (soon && typeof loginCredential.refreshToken === 'string' && loginCredential.refreshToken.length > 0) {
      if (refreshInFlight === undefined) {
        refreshInFlight = (async () => {
          debugLog('login auth: refreshing access token');
          const outcome = await loginClient.refresh(loginCredential);
          persistLogin({
            ...loginCredential,
            accessToken: outcome.accessToken,
            refreshToken: outcome.refreshToken ?? loginCredential.refreshToken,
            expiresAtMs: outcome.expiresInSec !== undefined
              ? Date.now() + outcome.expiresInSec * 1000
              : loginCredential.expiresAtMs,
            domain: outcome.domain ?? loginCredential.domain,
          });
          debugLog('login auth: refresh ok');
        })().finally(() => { refreshInFlight = undefined; });
      }
      await refreshInFlight;
    }
    return loginCredential;
  };

  const resolveConnection = async () => {
    const current = options();
    const refName = typeof current.apiKeyEnv === 'string' && current.apiKeyEnv.length > 0
      ? current.apiKeyEnv
      : DEFAULT_TOKEN_REF;
    let token;
    let discoveredUserId;
    let source;

    const credentials = ctx.get('credentials');
    if (credentials !== undefined && CREDENTIAL_REF_PATTERN.test(refName)) {
      const hit = await credentials.resolve(refName).catch(() => undefined);
      if (hit !== undefined && typeof hit.value === 'string') {
        token = normalizeToken(assertUsableToken(hit.value, refName));
        source = `stored credential ${refName}`;
      }
    }
    if (token === undefined) {
      const ambient = process.env[refName];
      if (typeof ambient === 'string' && ambient.length > 0) {
        token = normalizeToken(assertUsableToken(ambient, refName));
        source = `environment ${refName}`;
      }
    }
    // The plugin's own login beats a discovered CLI session: see the note on
    // `loginClient` above. It is also the only source that can refresh itself.
    if (token === undefined) {
      try {
        const fresh = await ensureFreshLoginToken();
        token = normalizeToken(fresh.accessToken);
        discoveredUserId = fresh.uid;
        source = 'plugin login';
      } catch (error) {
        // Not signed in through this plugin: fall through to the CLI session
        // scan, which may still hold a usable token for this realm.
        if (error?.code !== 'MISSING_CREDENTIAL' && error?.code !== 'AUTH') throw error;
        debugLog(`login auth unavailable (${error.code}); trying the CLI session`);
      }
    }
    if (token === undefined && current.discoverCliSession) {
      const session = discoverSession(current.authDir);
      if (session !== undefined) {
        const expiry = session.expiresAt ?? tokenExpiry(session.token);
        if (expiry !== undefined && expiry <= Date.now()) {
          throw new WorkBuddyError(
            `workbuddy: the CLI session in ${session.source} expired at ${new Date(expiry).toISOString()}; `
            + 'sign in again by running "codebuddy" and then /login',
            'AUTH',
          );
        }
        token = normalizeToken(session.token);
        discoveredUserId = session.userId;
        source = session.source;
      }
    }
    if (token === undefined) {
      throw new WorkBuddyError(
        `workbuddy: no WorkBuddy access token. Run "dsh-plugin-workbuddy login" once `
        + '(a browser opens; no API key needed), store ' + refName + ' through the credentials '
        + 'service, export it, or sign in once with the CodeBuddy CLI ("codebuddy" then /login)',
        'MISSING_CREDENTIAL',
      );
    }
    const userId = current.userId.length > 0
      ? current.userId
      : (discoveredUserId ?? userIdFromToken(token));
    return { baseURL: current.baseURL, token, userId, source };
  };

  // The billing endpoints live at the origin root (no `/v2`), and these three
  // package codes are the free-quota grants the account currently holds. The
  // gateway returns precise decimal strings; sum them into integers.
  const QUOTA_CODES = [
    'TCACA_code_007_nzdH5h4Nl0',
    'TCACA_code_008_cfWoLwvjU4',
    'TCACA_code_030_BjSt89qTvr',
  ];
  const QUOTA_BASE = 'https://www.workbuddy.cn';
  const QUOTA_CACHE_MS = 30000;
  let quotaCache;
  let quotaCachedAt = 0;

  // Per-package display names. The endpoint's Chinese names are long and repeat
  // ("CodeBuddy个人版国内运营裂变包" covers seven grants), so key on the code.
  const PACKAGE_LABELS = {
    TCACA_code_007_nzdH5h4Nl0: '运营活动',
    TCACA_code_008_cfWoLwvjU4: '体验版月额度',
    TCACA_code_030_BjSt89qTvr: '拉新权益',
  };

  // The monthly grant (008) reports `CapacityUsed: 0` even when fully spent,
  // because it is CapacityType 4 with a calendar-month cycle: `Capacity*` is a
  // lifetime view across cycles and only resets per renewal, whereas
  // `CycleCapacity*` is the current October cycle. Its own sibling field
  // `CycleCapacityUsed` then carries the real 500. So every figure is read from
  // the `CycleCapacity*` family, falling back to `Capacity*` if absent.
  const cycleNumber = (account, field) => {
    const value = account[`CycleCapacity${field}Precise`] ?? account[`CycleCapacity${field}`];
    if (value !== undefined && Number.isFinite(Number(value))) return Number(value);
    const fallback = account[`Capacity${field}Precise`] ?? account[`Capacity${field}`];
    return Number.isFinite(Number(fallback)) ? Number(fallback) : 0;
  };

  /**
   * Per-package and aggregate free quota for the Web indicator.
   * Returns `{total, used, remaining, packages: [{code, label, total, used, remaining}]}`.
   */
  const fetchQuota = async () => {
    const now = Date.now();
    if (quotaCache !== undefined && now - quotaCachedAt < QUOTA_CACHE_MS) return quotaCache;
    const connection = await resolveConnection();
    const headers = {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${connection.token}`,
      'accept-language': 'zh',
      ...(connection.userId ? { 'x-user-id': connection.userId } : {}),
    };
    const res = await fetch(`${QUOTA_BASE}/billing/meter/get-user-resource-free-packages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        PageNumber: 1,
        PageSize: 100,
        Status: [0, 3],
        IsDisplayTotalInfo: true,
        PackageCodes: QUOTA_CODES,
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`billing HTTP ${res.status}`);
    const json = await res.json();
    const accounts = Array.isArray(json?.data?.Accounts) ? json.data.Accounts : [];
    let total = 0;
    let remaining = 0;
    let used = 0;
    // Several grants can share one package code (007 has six), so collapse by
    // code and keep one row per package rather than one per grant.
    const byCode = new Map();
    for (const account of accounts) {
      const size = cycleNumber(account, 'Size');
      const rem = cycleNumber(account, 'Remain');
      const use = cycleNumber(account, 'Used');
      total += size;
      remaining += rem;
      used += use;
      const code = account.PackageCode;
      const row = byCode.get(code) ?? { code, label: PACKAGE_LABELS[code] ?? account.PackageName ?? code, total: 0, used: 0, remaining: 0 };
      row.total += size;
      row.remaining += rem;
      row.used += use;
      byCode.set(code, row);
    }
    // Stable display order: largest grant first.
    const packages = [...byCode.values()].sort((a, b) => b.total - a.total);
    quotaCache = { total, used, remaining, packages };
    quotaCachedAt = now;
    // Log per package: the aggregate alone hides which grant was drained.
    for (const row of packages) {
      debugLog(`quota pkg: ${row.label} total=${row.total} used=${row.used} remaining=${row.remaining}`);
    }
    debugLog(`quota: total=${total} used=${used} remaining=${remaining}`);
    return quotaCache;
  };

  // Image blocks carry only a durable reference (no bytes), so the adapter needs
  // a way to read them back. The host attachments service is reached by name and
  // duck-typed: importing it would re-introduce the resolution failure this
  // plugin avoids, since a plugin must stay import-free of host packages.
  const attachments = {
    async imageDataUrl(ref) {
      const service = ctx.get('attachments');
      if (service === undefined) return undefined;
      const hostPath = typeof service.imageHostPath === 'function'
        ? service.imageHostPath(ref)
        : undefined;
      if (typeof hostPath !== 'string' || hostPath.length === 0) return undefined;
      const bytes = await fs.promises.readFile(hostPath).catch(() => undefined);
      if (bytes === undefined) return undefined;
      const mediaType = ref?.mediaType ?? 'image/png';
      return `data:${mediaType};base64,${bytes.toString('base64')}`;
    },
  };

  const adapter = new WorkBuddyAdapter({
    provider,
    displayName: options().displayName,
    multiplierInName: options().multiplierInName,
    reasoningEffortField: options().reasoningEffortField,
    requestTimeoutMs: options().requestTimeoutMs,
    rateLimitMinGapMs: options().rateLimitMinGapMs,
    rateLimitRetries: options().rateLimitRetries,
    defaultContextWindow: options().defaultContextWindow,
    defaultMaxTokens: options().defaultMaxTokens,
    identityHeaders: () => identityHeadersFor(options()),
    getCatalog,
    selections,
    resolveConnection,
    attachments,
    // Diagnostics only: a request the runtime retries is otherwise invisible,
    // so every wire failure is appended to the debug log with its status and
    // the gateway's own message (which carries the business code).
    onFailure: ({ url, status, code, detail }) => {
      debugLog(`request FAILED: [${code}] HTTP ${status} url=${url} detail=${detail}`);
    },
  });

  const settingsNs = ctx.fiber.entry?.options.id ?? name;
  debugLog(`settings: ns=${settingsNs}`);
  ctx.llm.registerConfigurableProviders([{
    provider,
    displayName: options().displayName,
    settingsNs,
    settingsPath: [],
  }]);
  ctx.llm.registerAdapter([provider], adapter);

  // Startup self-check: proves the module loaded, the catalog read, and whether
  // a token is resolvable — the three things that fail silently otherwise.
  debugLog(`apply: provider=${provider} scope=${options().scope} baseURL=${options().baseURL}`);
  try {
    const loaded = getCatalog();
    debugLog(`catalog: ${loaded.models.length} models from ${loaded.source ?? '<none>'} stamp=${CATALOG_STAMP}`);
  } catch (error) {
    debugLog(`catalog FAILED: ${error?.message ?? error}`);
  }
  void resolveConnection().then(
    (connection) => debugLog(`token: resolved from ${connection.source ?? 'unknown'} userId=${connection.userId ? '<set>' : '<missing>'}`),
    (error) => debugLog(`token FAILED: [${error?.code ?? '?'}] ${error?.message ?? error}`),
  );

  /**
   * The context-length view the client renders: every catalog model with the
   * lengths it offers (or none, when it is not adjustable) and the budget now in
   * force for it.
   *
   * `provider`/`providerName` identify the owning provider group: the unified
   * picker fetches this route alongside the OpenCode one and groups rows under
   * these headings (the 上级分类), so the payload must name itself.
   */
  const contextWindowView = () => {
    const catalog = getCatalog();
    return {
      provider,
      providerName: options().displayName,
      storePath: storePath.length > 0 ? storePath : undefined,
      models: catalog.models.map((model) => {
        const options = optionsFor(model);
        const selected = selections.get(model.id);
        return {
          id: model.id,
          name: model.name,
          displayName: model.displayName ?? model.name,
          adjustable: options !== undefined,
          ...(options === undefined ? {} : { options }),
          selected: selected ?? null,
          effective: effectiveContextWindow(model, selected) ?? null,
        };
      }),
    };
  };

  /**
   * Commit one model's context length.
   *
   * The value is validated against that model's own supported lengths rather
   * than merely being a positive integer: a client must not be able to widen a
   * model past the ceiling the WorkBuddy catalogue declares for it.
   */
  const setContextWindow = (modelId, value) => {
    const catalog = getCatalog();
    const model = catalog.models.find((entry) => entry.id === modelId);
    if (model === undefined) {
      return { error: `unknown model "${modelId}"` };
    }
    if (!isAdjustable(model)) {
      return { error: `model "${modelId}" has no adjustable context window` };
    }
    if (value === null) {
      selections.set(model.id, undefined);
      return { ok: true, model: model.id, effective: effectiveContextWindow(model, undefined) ?? null };
    }
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
      return { error: `"${String(value)}" is not a context length` };
    }
    const allowed = optionsFor(model);
    if (!allowed.includes(value)) {
      return { error: `${value} is not offered by "${modelId}" (allowed: ${allowed.join(', ')})` };
    }
    selections.set(model.id, value);
    debugLog(`context: ${model.id} -> ${value}`);
    return { ok: true, model: model.id, effective: value };
  };

  /** Read a JSON request body, tolerating an empty or malformed one. */
  const readJsonBody = (req) => new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      // A picker payload is a few hundred bytes; anything larger is a mistake or
      // an attack, and must not be buffered.
      if (raw.length > 64 * 1024) {
        raw = '';
        resolve(undefined);
        req.destroy();
      }
    });
    req.on('end', () => {
      if (raw.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(undefined);
      }
    });
    req.on('error', () => resolve(undefined));
  });

  // Quota endpoint for the Web input-box indicator. The client half fetches
  // `/workbuddy/quota` (same-origin, authenticated by the browser cookie); this
  // host half owns the WorkBuddy token, so the access token never reaches the
  // browser. Register through the optional web carrier so this plugin also
  // works in a headless (cli) scope without a webServer.
  debugLog('route: requesting webServer+connection');
  ctx.inject(['webServer', 'connection'], (webCtx) => {
    debugLog('route: inject callback entered');
    webCtx.effect(() => {
      try {
        const dispose = webCtx.webServer.register({
          kind: 'exact',
          path: '/workbuddy/quota',
          handler: async (req, res) => {
            const admission = webCtx.connection.admit(req);
            if ('rejection' in admission) {
              res.writeHead(admission.rejection);
              res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden');
              return;
            }
            try {
              const quota = await fetchQuota();
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify(quota));
            } catch (error) {
              res.writeHead(502);
              res.end(JSON.stringify({ error: error?.message ?? String(error) }));
            }
          },
        });
        // Context-length selection. GET reports what each model offers and what is
        // in force; POST commits one model's choice after host-side validation.
        const disposeContext = webCtx.webServer.register({
          kind: 'exact',
          path: '/workbuddy/context-window',
          handler: async (req, res) => {
            const admission = webCtx.connection.admit(req);
            if ('rejection' in admission) {
              res.writeHead(admission.rejection);
              res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden');
              return;
            }
            const send = (status, payload) => {
              res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify(payload));
            };
            try {
              if ((req.method ?? 'GET').toUpperCase() === 'GET') {
                send(200, contextWindowView());
                return;
              }
              if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
                send(405, { error: 'method not allowed' });
                return;
              }
              const body = await readJsonBody(req);
              if (body === undefined || typeof body.model !== 'string') {
                send(400, { error: 'expected a JSON body with a "model" field' });
                return;
              }
              const value = body.contextWindow === null ? null : body.contextWindow;
              const result = setContextWindow(body.model, value);
              if (result.error !== undefined) {
                send(400, { error: result.error });
                return;
              }
              send(200, result);
            } catch (error) {
              debugLog(`context: route FAILED ${error?.message ?? error}`);
              send(500, { error: error?.message ?? String(error) });
            }
          },
        });
        debugLog('route: /workbuddy/quota + /workbuddy/context-window registered');
        return () => {
          dispose();
          disposeContext();
        };
      } catch (error) {
        debugLog(`route: FAILED ${error?.message ?? error}`);
        throw error;
      }
    }, 'llm-workbuddy: /workbuddy routes');
  });
}

export { Config, apply, inject, name };
