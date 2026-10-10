/**
 * Discover the WorkBuddy/CodeBuddy CLI login on this machine.
 *
 * The desktop clients persist their session in an at-rest record; on this
 * machine the record is plain JSON at
 *   %LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\<authentication id>.info
 * holding `auth.accessToken` / `auth.refreshToken` and `account.uid`.
 *
 * Discovery is a fallback: an explicitly stored DSH credential or an exported
 * environment variable always wins, so a user who pastes a token keeps control.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Candidate auth directories, best first. */
function candidateAuthDirs(explicit) {
  const out = [];
  if (typeof explicit === 'string' && explicit.length > 0) out.push(explicit);
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    out.push(path.join(localAppData, 'CodeBuddyExtension', 'Data', 'Public', 'auth'));
    out.push(path.join(localAppData, 'WorkBuddyExtension', 'Data', 'Public', 'auth'));
  }
  out.push(path.join(os.homedir(), '.codebuddy', 'auth'));
  out.push(path.join(os.homedir(), '.workbuddy', 'auth'));
  return out;
}

/** `ResourceData/Public/auth` nests one directory per scope; walk shallowly. */
function collectRecords(dir) {
  const found = [];
  const visit = (current, depth) => {
    if (depth > 3) return;
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(full, depth + 1);
      } else if (entry.name.endsWith('.info')) {
        try {
          const stat = fs.statSync(full);
          const record = JSON.parse(fs.readFileSync(full, 'utf8'));
          const token = record?.auth?.accessToken;
          if (typeof token !== 'string' || token.length === 0) continue;
          const expiresAt = typeof record?.auth?.expiresAt === 'number' ? record.auth.expiresAt : undefined;
          found.push({
            token,
            refreshToken: typeof record?.auth?.refreshToken === 'string' ? record.auth.refreshToken : undefined,
            userId: typeof record?.account?.uid === 'string' ? record.account.uid : undefined,
            nickname: typeof record?.account?.nickname === 'string' ? record.account.nickname : undefined,
            tokenType: record?.auth?.tokenType,
            expiresAt,
            source: full,
            mtimeMs: stat.mtimeMs,
          });
        } catch {
          /* unreadable or not a session record */
        }
      }
    }
  };
  visit(dir, 0);
  return found;
}

/** Best JWT `exp` for a token, as epoch milliseconds. */
export function tokenExpiry(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/** Stable user id from the token when the record does not carry one. */
export function userIdFromToken(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const candidate = payload.uid ?? payload.userId ?? payload.sub;
    return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Newest unexpired CLI session, or the newest expired one when nothing is live
 * (so the caller can report an actionable auth error instead of "no token").
 */
export function discoverSession(explicitDir) {
  const records = [];
  for (const dir of candidateAuthDirs(explicitDir)) records.push(...collectRecords(dir));
  if (records.length === 0) return undefined;
  records.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const now = Date.now();
  const live = records.find((record) => {
    const expiresAt = record.expiresAt ?? tokenExpiry(record.token);
    return expiresAt === undefined || expiresAt > now;
  });
  return live ?? records[0];
}
