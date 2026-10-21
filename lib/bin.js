#!/usr/bin/env node
/**
 * Standalone CLI for the WorkBuddy (domestic) plugin.
 *
 * Usage: dsh-plugin-workbuddy <login|status|logout>
 *
 *   login   sign in through the browser (prints a URL, then waits for it)
 *   status  sign-in state, token expiry, and the stored credential path
 *   logout  remove the stored credential
 *
 * The login is a device-authorization flow against the SAME endpoints the
 * official desktop app uses (see lib/login.js), so no API key and no desktop
 * app are involved. The credential lands in the plugin's own data directory,
 * and the plugin refreshes it automatically from then on.
 *
 * This matters for the domestic edition specifically: a token scanned out of
 * the CodeBuddy CLI's auth directory can belong to another product channel
 * (`Tencent-Cloud.coding-copilot`), which the WorkBuddy gateway rejects with
 * business code 11128 ("Illegal API invocation from an unapproved channel").
 * Signing in here issues a token from the WorkBuddy realm itself.
 */
import { DOMESTIC_BASE, WorkBuddyLoginClient } from './login.js';
import {
  authPath,
  clearCredential,
  credentialState,
  readCredential,
  writeCredential,
} from './login-auth.js';

/** Poll cadence while the browser half is unfinished. */
const LOGIN_POLL_INTERVAL_MS = 2000;

/** How long a login URL stays worth waiting on. */
const LOGIN_TIMEOUT_MS = 5 * 60_000;

/** Remove token-like strings from an unexpected diagnostic message. */
function safeMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, '$1[redacted]');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function login() {
  const client = new WorkBuddyLoginClient({ baseURL: DOMESTIC_BASE });
  const attempt = await client.begin();
  process.stdout.write([
    'Sign in to WorkBuddy by opening this URL in a browser:',
    '',
    `  ${attempt.authUrl}`,
    '',
    `Waiting for the sign-in to complete (up to ${Math.round(LOGIN_TIMEOUT_MS / 60_000)} minutes)…`,
    '',
  ].join('\n'));

  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    let outcome;
    try {
      outcome = await client.poll(attempt);
    } catch (error) {
      client.forget(attempt.state);
      process.stderr.write(`dsh-plugin-workbuddy: ${safeMessage(error)}\n`);
      return 1;
    }
    if (outcome.status === 'complete') {
      const { tokens, account } = outcome;
      const stored = writeCredential({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAtMs: tokens.expiresInSec > 0 ? Date.now() + tokens.expiresInSec * 1000 : 0,
        domain: tokens.domain || 'www.workbuddy.cn',
        uid: account.uid ?? '',
        enterpriseId: account.enterpriseId,
        nickname: account.nickname,
      });
      process.stdout.write(
        `WorkBuddy: signed in${account.nickname ? ` as ${account.nickname}` : ''}`
        + ` (credential stored at ${stored})\n`,
      );
      return 0;
    }
    await sleep(LOGIN_POLL_INTERVAL_MS);
  }
  client.forget(attempt.state);
  process.stderr.write('dsh-plugin-workbuddy: timed out waiting for the browser sign-in; run login again for a fresh URL\n');
  return 1;
}

function status() {
  const credential = readCredential();
  const file = authPath();
  if (credential === undefined) {
    process.stdout.write(`WorkBuddy: not signed in through this plugin (no credential at ${file})\n`);
    return 1;
  }
  const state = credentialState(credential);
  const expiry = credential.expiresAtMs > 0
    ? new Date(credential.expiresAtMs).toISOString()
    : 'unknown';
  process.stdout.write([
    `WorkBuddy: ${state.state === 'signed-in' ? 'signed in' : 'token expired (will refresh)'}`,
    `  account    : ${credential.nickname || credential.uid || 'unknown'}`,
    `  domain     : ${credential.domain}`,
    `  expires at : ${expiry}`,
    `  credential : ${file}`,
    '',
  ].join('\n'));
  return 0;
}

function logout() {
  const removed = clearCredential();
  process.stdout.write(
    removed
      ? `WorkBuddy: signed out (removed ${authPath()})\n`
      : `WorkBuddy: nothing to remove (${authPath()} absent)\n`,
  );
  return 0;
}

const HELP = [
  'Usage: dsh-plugin-workbuddy <login|status|logout>',
  '',
  '  login   sign in through the browser (prints a URL, then waits for it)',
  '  status  sign-in state and where the credential is stored',
  '  logout  remove the stored credential',
  '',
].join('\n');

const action = process.argv[2];
let code = 1;
try {
  if (action === undefined || action === '--help' || action === '-h') {
    process.stdout.write(`${HELP}\n`);
    code = 0;
  } else if (action === 'login') {
    code = await login();
  } else if (action === 'status') {
    code = status();
  } else if (action === 'logout') {
    code = logout();
  } else {
    process.stderr.write(`dsh-plugin-workbuddy: expected login, status, or logout; got ${JSON.stringify(action)}\n`);
  }
} catch (error) {
  process.stderr.write(`dsh-plugin-workbuddy: ${safeMessage(error)}\n`);
}
process.exit(code);
