/**
 * WorkBuddy domestic (workbuddy.cn) credential storage.
 *
 * The credential comes from this plugin's own device-authorization login (see
 * login.js) — never from the desktop client's session store, whose accessToken
 * is sealed in a `$wbEncrypted` envelope this plugin cannot open.
 *
 * This module is deliberately separate from the older `auth.js`, which scans
 * the CodeBuddy CLI's on-disk session files. That scan is kept as a fallback
 * for users who already have a working CLI login, but it can also pick up a
 * token from a DIFFERENT product channel (`Tencent-Cloud.coding-copilot`),
 * which the WorkBuddy gateway rejects with business code 11102/11128. A
 * credential written here always wins, because it was issued by this plugin's
 * own login against the WorkBuddy realm.
 *
 * Location: `$DSH_HOME/.dsh-workbuddy-connect/auth.json`, overridable through
 * `loginAuthPath` (Config) or `DSH_WORKBUDDY_DATA_DIR` (env).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Filename inside the plugin's data directory. */
const AUTH_FILENAME = 'auth.json';

/** Environment override for the whole data directory. */
export const DATA_DIR_ENV = 'DSH_WORKBUDDY_DATA_DIR';

/** Folder name this plugin keeps its own files in, under the DSH home. */
export const DATA_DIR_NAME = '.dsh-workbuddy-connect';

/** The realm this credential belongs to; a guard against cross-region reuse. */
export const CREDENTIAL_REGION = 'domestic';

/** The one provenance a stored credential can have: this plugin's own login. */
export const CREDENTIAL_SOURCE = 'login';

/** Normalize an expiry that may arrive in seconds or milliseconds. */
export function expiryToMs(value) {
  if (typeof value !== 'number' || value <= 0) return 0;
  return value > 1e12 ? value : value * 1000;
}

/** Decode a JWT payload without verifying (the gateway verifies upstream). */
function jwtPayload(token) {
  if (typeof token !== 'string') return undefined;
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const parsed = JSON.parse(json);
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** A pasted token's `exp`, in ms, when the token parses as a JWT. */
export function tokenExpiry(token) {
  const exp = jwtPayload(token)?.exp;
  return typeof exp === 'number' && exp > 0 ? exp * 1000 : undefined;
}

/** The account id a token carries, or a stable hash when it carries none. */
export function userIdFromToken(token) {
  const payload = jwtPayload(token);
  if (payload !== undefined) {
    for (const key of ['uid', 'userId', 'user_id', 'sub', 'accountId', 'accountIdStr']) {
      const value = payload[key];
      if (typeof value === 'string' && value.length > 0) return value;
    }
  }
  let hash = 0;
  const source = typeof token === 'string' ? token : String(token ?? '');
  for (let index = 0; index < source.length; index += 1) {
    hash = (hash * 31 + source.charCodeAt(index)) >>> 0;
  }
  return `wb-${hash.toString(16).padStart(8, '0')}`;
}

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const optionalString = (value) => (typeof value === 'string' && value !== '' ? value : undefined);

/** The plugin's data directory. */
export function dataDir(override) {
  if (typeof override === 'string' && override.trim().length > 0) return override.trim();
  const fromEnv = process.env[DATA_DIR_ENV];
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim();
  const home = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh');
  return path.join(home, DATA_DIR_NAME);
}

/** The credential file path inside the data directory. */
export function authPath(override) {
  if (typeof override === 'string' && override.trim().length > 0) return override.trim();
  return path.join(dataDir(), AUTH_FILENAME);
}

/** Parse a credential document in either the nested or the flat layout. */
export function parseCredential(document) {
  if (!isObject(document)) return undefined;
  const auth = isObject(document.auth) ? document.auth : document;
  const account = isObject(document.account) ? document.account : {};
  const accessToken = optionalString(auth.accessToken ?? document.accessToken);
  if (accessToken === undefined) return undefined;
  const expiresRaw = auth.expiresAt ?? document.expiresAt;
  const refreshRaw = auth.refreshExpiresAt ?? document.refreshExpiresAt;
  return {
    accessToken,
    refreshToken: optionalString(auth.refreshToken ?? document.refreshToken) ?? '',
    expiresAtMs: typeof expiresRaw === 'number' ? expiryToMs(expiresRaw) : 0,
    refreshExpiresAtMs: typeof refreshRaw === 'number' ? expiryToMs(refreshRaw) : undefined,
    domain: optionalString(auth.domain ?? document.domain) ?? 'www.workbuddy.cn',
    region: optionalString(document.region) ?? CREDENTIAL_REGION,
    uid: optionalString(account.uid ?? document.uid) ?? '',
    enterpriseId: optionalString(account.enterpriseId ?? document.enterpriseId),
    nickname: optionalString(account.nickname ?? document.nickname),
    // Set once the token has been re-signed by a refresh. A login token carries
    // `token_source: "enterprise_switch"`, which the gateway rejects for large
    // requests; the refreshed flavour (`oneid_login`) is accepted, so this flag
    // records that normalization already happened.
    normalized: auth.normalized === true,
    source: CREDENTIAL_SOURCE,
  };
}

/** Read the stored credential, or undefined when absent or unusable. */
export function readCredential(overridePath) {
  const file = authPath(overridePath);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  let document;
  try {
    document = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return parseCredential(document);
}

/**
 * Write one credential atomically: a partial file would read back as a
 * corrupt credential and force a needless re-login.
 */
export function writeCredential(credential, overridePath) {
  const file = authPath(overridePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const document = {
    version: 1,
    region: CREDENTIAL_REGION,
    auth: {
      accessToken: credential.accessToken,
      refreshToken: credential.refreshToken ?? '',
      expiresAt: credential.expiresAtMs > 0 ? Math.floor(credential.expiresAtMs / 1000) : 0,
      ...(credential.refreshExpiresAtMs ? { refreshExpiresAt: Math.floor(credential.refreshExpiresAtMs / 1000) } : {}),
      domain: credential.domain ?? 'www.workbuddy.cn',
      ...(credential.normalized === true ? { normalized: true } : {}),
    },
    account: {
      uid: credential.uid ?? '',
      ...(credential.enterpriseId ? { enterpriseId: credential.enterpriseId } : {}),
      ...(credential.nickname ? { nickname: credential.nickname } : {}),
    },
  };
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
  return file;
}

/** Remove the stored credential. Returns whether one was present. */
export function clearCredential(overridePath) {
  const file = authPath(overridePath);
  try {
    fs.rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a credential is still usable for chat, and if not, why.
 *
 * A refresh token that has itself expired means only a fresh login can help,
 * so the caller reports that rather than attempting a doomed refresh.
 */
export function credentialState(credential, now = Date.now()) {
  if (credential === undefined) return { state: 'signed-out' };
  const refreshDeadline = credential.refreshExpiresAtMs;
  if (typeof refreshDeadline === 'number' && refreshDeadline > 0 && refreshDeadline <= now) {
    return { state: 'expired', expiresAtMs: credential.expiresAtMs };
  }
  if (credential.expiresAtMs > 0 && credential.expiresAtMs <= now) {
    return { state: 'expired', expiresAtMs: credential.expiresAtMs };
  }
  return { state: 'signed-in', expiresAtMs: credential.expiresAtMs };
}
