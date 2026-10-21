/**
 * WorkBuddy device-authorization login (both editions).
 *
 * Wire facts, verified live against BOTH realms:
 *   POST /v2/plugin/auth/state?platform=CLI
 *        -> {"code":0,"data":{"state":"<uuid>","authUrl":"<base>/login?platform=CLI&state=<uuid>"}}
 *   GET  /v2/plugin/auth/token?state=<state>
 *        -> while unfinished: {"code":11217,"msg":"login ing..."}   (HTTP 200)
 *        -> when finished:     {"code":0,"data":{accessToken,refreshToken,expiresIn,domain}}
 *   GET  /v2/plugin/login/account?state=<state>   (Bearer) -> {uid,enterpriseId,nickname}
 *   POST /v2/plugin/auth/token/refresh  (X-Refresh-Token header) -> new token bundle
 *
 * The same three endpoints answer on www.workbuddy.ai (international) and
 * www.workbuddy.cn (domestic); only the origin differs, so the base is a
 * constructor option rather than a module constant. Each edition therefore
 * signs in to its own realm and never mixes the two accounts.
 *
 * This is the SAME flow the official desktop app and CLI use, so the plugin
 * obtains its own credential instead of trying to read the desktop client's
 * encrypted session store — which is AES-256-GCM behind a key this plugin
 * cannot derive (see the note in index.js).
 *
 * Two details are load-bearing:
 *   - One cookie jar per attempt: the gateway correlates the browser's
 *     completion with the state it issued, so the state request and every poll
 *     must present the same cookies.
 *   - Pending is a business code (11217), not an HTTP error: `auth/token`
 *     answers HTTP 200 while the human has not finished.
 */

/** The international realm, kept for callers that name it explicitly. */
export const GLOBAL_BASE = 'https://www.workbuddy.ai';

/** The domestic realm. */
export const DOMESTIC_BASE = 'https://www.workbuddy.cn';

/** Identity the login endpoints expect (unrelated to the chat User-Agent). */
const LOGIN_USER_AGENT = 'CLI/2.63.2 CodeBuddy/2.63.2';

/** Login round trips are interactive; a slow one is dead, not merely slow. */
const LOGIN_TIMEOUT_MS = 30_000;

/** Business code `auth/token` returns while the browser half is unfinished. */
export const LOGIN_PENDING_CODE = 11217;

/** Path of the state issuer. */
const AUTH_STATE_PATH = '/v2/plugin/auth/state?platform=CLI';

/** Poll and account paths; both take the state as a query parameter. */
const authTokenPath = (state) => `/v2/plugin/auth/token?state=${encodeURIComponent(state)}`;
const loginAccountPath = (state) => `/v2/plugin/login/account?state=${encodeURIComponent(state)}`;

/** Refresh path; the refresh token rides in its own header. */
const AUTH_REFRESH_PATH = '/v2/plugin/auth/token/refresh';

/** One issued login attempt: what to open, and what to poll with. */
export class WorkBuddyLoginAttempt {
  constructor(state, authUrl, region = 'domestic') {
    this.state = state;
    this.authUrl = authUrl;
    this.region = region;
  }
}

/** A minimal cookie jar, scoped to one login attempt. */
class LoginCookieJar {
  constructor() {
    this.cookies = new Map();
  }

  /** Record every cookie the response set, last write winning per name. */
  absorb(response) {
    const setter = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [];
    for (const raw of setter) {
      const pair = raw.split(';', 1)[0] ?? '';
      const separator = pair.indexOf('=');
      if (separator <= 0) continue;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (name !== '') this.cookies.set(name, value);
    }
  }

  /** The Cookie header for this attempt, or undefined when it holds nothing. */
  header() {
    if (this.cookies.size === 0) return undefined;
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}

/** Read one upstream `{code,msg,data}` reply, tolerantly. */
async function readEnvelope(response) {
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`workbuddy login: upstream returned non-JSON (http ${response.status}): ${text.slice(0, 160)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`workbuddy login: upstream returned an unexpected document (http ${response.status})`);
  }
  return {
    code: typeof parsed.code === 'number' ? parsed.code : 0,
    msg: typeof parsed.msg === 'string' ? parsed.msg : '',
    data: 'data' in parsed ? parsed.data : undefined,
  };
}

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const optionalString = (value) => (typeof value === 'string' && value !== '' ? value : undefined);

/**
 * The login client. Each attempt owns its own cookie jar, keyed by the state
 * it issued, so two concurrent logins can never answer for each other.
 */
export class WorkBuddyLoginClient {
  /**
   * @param options.fetchImpl - fetch implementation (tests inject a stub).
   * @param options.baseURL   - realm origin; defaults to the domestic one,
   *                            because this module ships inside the domestic
   *                            plugin. The international plugin passes its own.
   */
  constructor(options = {}) {
    const { fetchImpl = fetch, baseURL = DOMESTIC_BASE } = options;
    this.fetchImpl = fetchImpl;
    this.baseURL = String(baseURL).replace(/\/+$/, '');
    this.jars = new Map();
  }

  /** Request headers, carrying the attempt's cookies when it has any. */
  headers(jar) {
    const cookie = jar?.header();
    return {
      'content-type': 'application/json',
      accept: 'application/json, text/plain, */*',
      'x-requested-with': 'XMLHttpRequest',
      // Origin/Referer must match the realm being targeted: the gateway checks
      // that a login was started from its own site.
      origin: this.baseURL,
      referer: `${this.baseURL}/`,
      'user-agent': LOGIN_USER_AGENT,
      ...(cookie === undefined ? {} : { cookie }),
    };
  }

  /**
   * Issue one attempt: obtain the state and the URL the human must open.
   *
   * The response's cookies are retained under the returned state, because the
   * poll that finishes this attempt has to present them.
   */
  async begin() {
    const jar = new LoginCookieJar();
    const response = await this.fetchImpl(`${this.baseURL}${AUTH_STATE_PATH}`, {
      method: 'POST',
      headers: this.headers(jar),
      body: '{}',
      signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
    });
    jar.absorb(response);
    const envelope = await readEnvelope(response);
    if (!response.ok || envelope.code !== 0) {
      throw new Error(`workbuddy login: auth state failed (http ${response.status}, code ${envelope.code}): ${envelope.msg.slice(0, 160)}`);
    }
    const data = isObject(envelope.data) ? envelope.data : {};
    const state = optionalString(data.state);
    const authUrl = optionalString(data.authUrl);
    if (state === undefined || authUrl === undefined) {
      throw new Error('workbuddy login: auth state reply carried no state or authUrl');
    }
    this.jars.set(state, jar);
    return new WorkBuddyLoginAttempt(state, authUrl, this.baseURL.includes('workbuddy.cn') ? 'domestic' : 'global');
  }

  /** Drop a finished or abandoned attempt's jar. */
  forget(state) {
    this.jars.delete(state);
  }

  /** How many attempts currently hold a jar; diagnostics and tests. */
  pendingCount() {
    return this.jars.size;
  }

  /**
   * Poll one attempt once. The caller drives the cadence.
   *
   * `pending` covers both "the human has not finished" (code 11217) and "the
   * gateway refused this poll yet" (a 4xx while the browser half is still
   * open). A transport failure or a 5xx is a real error and is thrown:
   * retrying those as pending would hide an outage behind a spinner.
   */
  async poll(attempt) {
    const jar = this.jars.get(attempt.state);
    const response = await this.fetchImpl(`${this.baseURL}${authTokenPath(attempt.state)}`, {
      method: 'GET',
      headers: this.headers(jar),
      signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
    });
    jar?.absorb(response);
    if (response.status >= 500) {
      throw new Error(`workbuddy login: token endpoint failed (http ${response.status})`);
    }
    if (response.status >= 400) return { status: 'pending' };
    const envelope = await readEnvelope(response);
    if (envelope.code !== 0) return { status: 'pending' };
    const data = isObject(envelope.data) ? envelope.data : {};
    const accessToken = optionalString(data.accessToken);
    if (accessToken === undefined) return { status: 'pending' };
    const tokens = {
      accessToken,
      refreshToken: optionalString(data.refreshToken) ?? '',
      expiresInSec: typeof data.expiresIn === 'number' && data.expiresIn > 0 ? data.expiresIn : 0,
      domain: optionalString(data.domain) ?? new URL(this.baseURL).host,
    };
    return { status: 'complete', tokens, account: await this.fetchAccount(attempt, tokens.accessToken, jar) };
  }

  /**
   * Read the account identity for a finished attempt.
   *
   * Best effort by design: the token bundle is what makes the credential
   * usable, and the identity only improves the display name and the
   * `X-User-Id` header. A failure here must not discard a working login.
   */
  async fetchAccount(attempt, accessToken, jar) {
    try {
      const response = await this.fetchImpl(`${this.baseURL}${loginAccountPath(attempt.state)}`, {
        method: 'GET',
        headers: { ...this.headers(jar), authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
      });
      jar?.absorb(response);
      if (!response.ok) return { uid: '' };
      const envelope = await readEnvelope(response);
      const data = isObject(envelope.data) ? envelope.data : {};
      const enterpriseId = optionalString(data.enterpriseId);
      const nickname = optionalString(data.nickname);
      return {
        uid: optionalString(data.uid) ?? '',
        ...(enterpriseId === undefined ? {} : { enterpriseId }),
        ...(nickname === undefined ? {} : { nickname }),
      };
    } catch {
      // Best effort: see above. The credential is already usable.
      return { uid: '' };
    }
  }

  /**
   * Exchange a refresh token for a fresh access token.
   *
   * The refresh token rides in `X-Refresh-Token` (not the body, and not the
   * Authorization header), and `X-Auth-Refresh-Source: plugin` names the
   * channel — matching the official client's own refresh channel.
   */
  async refresh(credential) {
    const response = await this.fetchImpl(`${this.baseURL}${AUTH_REFRESH_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/plain, */*',
        'x-requested-with': 'XMLHttpRequest',
        origin: LOGIN_ORIGIN,
        referer: `${LOGIN_ORIGIN}/`,
        'user-agent': LOGIN_USER_AGENT,
        'x-refresh-token': credential.refreshToken ?? '',
        'x-auth-refresh-source': 'plugin',
        ...(credential.enterpriseId ? { 'x-enterprise-id': credential.enterpriseId } : {}),
      },
      body: '{}',
      signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
    });
    const envelope = await readEnvelope(response);
    if (!response.ok || envelope.code !== 0) {
      throw new Error(`workbuddy login: token refresh failed (http ${response.status}, code ${envelope.code}): ${envelope.msg.slice(0, 160)}`);
    }
    const data = isObject(envelope.data) ? envelope.data : {};
    const accessToken = optionalString(data.accessToken);
    if (accessToken === undefined) {
      throw new Error('workbuddy login: token refresh returned no accessToken; sign in again');
    }
    return {
      accessToken,
      refreshToken: optionalString(data.refreshToken),
      expiresInSec: typeof data.expiresIn === 'number' && data.expiresIn > 0 ? data.expiresIn : undefined,
      domain: optionalString(data.domain),
    };
  }
}
