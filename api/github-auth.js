/**
 * GET /api/github-auth — "Sign in with GitHub" for the in-site editor.
 *
 * Runs in a popup the editor opens. Two legs on one URL:
 *
 *   ?origin=https://<book domain>   start: check the origin against the registry,
 *                                   set a nonce cookie, redirect to GitHub's consent
 *                                   page with a signed `state` carrying the origin.
 *   ?code=…&state=…                 callback: check state + nonce, exchange the code,
 *                                   ask GitHub who this is (GET /user), REVOKE the
 *                                   GitHub token, and postMessage an identity token
 *                                   (lib/identity.mjs) to the opener at that origin
 *                                   only. Then the popup closes itself.
 *
 * The OAuth App asks for no scopes: its token can read public profile data and
 * nothing else, and it is thrown away within the request. What the editor keeps is
 * our identity token, which GitHub knows nothing about.
 *
 * Environment: GITHUB_OAUTH_CLIENT_ID, GITHUB_OAUTH_CLIENT_SECRET, IDENTITY_SECRET
 * (>= 32 chars), optionally GITHUB_OAUTH_REDIRECT_URI (default: this URL on the
 * request's host). With any missing, sign-in is off and propose-edit says so.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import BUNDLE from '../registry/bundled.mjs';
import { validateRegistry, createResolver, canonicalOrigin } from '../lib/registry.mjs';
import { GITHUB_API, GITHUB_HEADERS, resolveBook } from '../lib/common.mjs';
import { issueIdentity, readIdentitySecret, sign, verify } from '../lib/identity.mjs';

const RESOLVER = createResolver(validateRegistry(BUNDLE.registry));
const CLIENT_ID = (process.env.GITHUB_OAUTH_CLIENT_ID ?? '').trim();
const CLIENT_SECRET = (process.env.GITHUB_OAUTH_CLIENT_SECRET ?? '').trim();
const SECRET = readIdentitySecret(process.env);
const ENABLED = Boolean(CLIENT_ID && CLIENT_SECRET && SECRET);
if (!ENABLED) {
  console.warn('config: GitHub sign-in is off (needs GITHUB_OAUTH_CLIENT_ID, GITHUB_OAUTH_CLIENT_SECRET, IDENTITY_SECRET >= 32 chars)');
}

const COOKIE = 'tb_oauth';
const STATE_TTL_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 6000;

function redirectUri(req) {
  const configured = (process.env.GITHUB_OAUTH_REDIRECT_URI ?? '').trim();
  if (configured) return configured;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `https://${host}/api/github-auth`;
}

function cookieValue(req, name) {
  const raw = req.headers.cookie;
  if (typeof raw !== 'string') return '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return '';
}

const sameString = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
};

/**
 * The popup's last page. `message` goes to the opener at `origin` (a registry
 * origin, never the raw query); without an opener the reader sees `text`.
 */
function page(res, status, { origin = null, message = null, text }) {
  const nonce = randomBytes(12).toString('base64');
  // JSON inside <script>: escape "<" so no value can close the tag.
  const data = JSON.stringify({ origin, message, text }).replace(/</g, '\\u003c');
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in with GitHub</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:3rem auto;max-width:28rem;padding:0 1rem;color:#2B2B2B}</style>
</head><body><p id="m"></p>
<script nonce="${nonce}">
(function () {
  var d = ${data};
  document.getElementById("m").textContent = d.text;
  try {
    if (d.origin && d.message && window.opener) {
      window.opener.postMessage(d.message, d.origin);
      window.close();
    }
  } catch (e) {}
})();
</script></body></html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'`);
  res.status(status);
  res.end(html);
}

async function timedFetch(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function start(req, res, origin) {
  const resolved = resolveBook(RESOLVER, origin);
  if (!resolved.ok) {
    console.warn(`github-auth: ${resolved.log}`);
    page(res, 403, { text: 'This sign-in link is not for a book on this platform.' });
    return;
  }
  const bookOrigin = canonicalOrigin(resolved.book);
  const n = randomBytes(16).toString('base64url');
  const state = sign(SECRET, { k: 'state', o: bookOrigin, n, e: Date.now() + STATE_TTL_MS });
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${n}; Path=/api/github-auth; Max-Age=${STATE_TTL_MS / 1000}; HttpOnly; Secure; SameSite=Lax`,
  );
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri(req));
  url.searchParams.set('state', state);
  url.searchParams.set('scope', ''); // public profile only
  url.searchParams.set('allow_signup', 'true');
  res.setHeader('Location', url.toString());
  res.setHeader('Cache-Control', 'no-store');
  res.status(302);
  res.end();
}

async function callback(req, res, params) {
  const state = verify(SECRET, params.get('state') ?? '');
  const cookie = cookieValue(req, COOKIE);
  // The cookie is spent either way.
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/api/github-auth; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
  if (!state || state.k !== 'state' || !sameString(state.n, cookie)) {
    console.warn('github-auth: state or nonce did not verify');
    page(res, 400, { text: 'That sign-in expired or came from somewhere else. Close this window and try again.' });
    return;
  }
  const origin = state.o;
  // Still a live book? (It was when the state was issued; the registry may have moved on.)
  if (!resolveBook(RESOLVER, origin).ok) {
    page(res, 403, { text: 'This book no longer accepts sign-ins.' });
    return;
  }

  if (params.get('error')) {
    // The reader pressed Cancel on GitHub's page.
    page(res, 200, {
      origin,
      message: { type: 'tb-github-identity', error: 'denied' },
      text: 'Sign-in cancelled. You can close this window.',
    });
    return;
  }

  const code = params.get('code') ?? '';
  let accessToken = '';
  let outcome;
  try {
    const exchange = await timedFetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': GITHUB_HEADERS['User-Agent'] },
      body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code, redirect_uri: redirectUri(req) }),
    });
    const data = exchange.ok ? await exchange.json() : null;
    accessToken = typeof data?.access_token === 'string' ? data.access_token : '';
    if (!accessToken) throw new Error(`code exchange failed (status ${exchange.status}${data?.error ? `, ${data.error}` : ''})`);

    const who = await timedFetch(`${GITHUB_API}/user`, {
      headers: { ...GITHUB_HEADERS, Authorization: `Bearer ${accessToken}` },
    });
    if (!who.ok) throw new Error(`GET /user returned ${who.status}`);
    const user = await who.json();
    if (typeof user?.login !== 'string' || !Number.isSafeInteger(user?.id)) throw new Error('GET /user returned no login');

    const token = issueIdentity(SECRET, { login: user.login, id: user.id, name: user.name }, origin);
    console.log(`github-auth: signed in @${user.login} for ${origin}`);
    outcome = [200, {
      origin,
      message: { type: 'tb-github-identity', token, login: user.login, id: user.id, name: user.name || '' },
      text: `Signed in as @${user.login}. You can close this window.`,
    }];
  } catch (err) {
    console.error(`github-auth: ${err.message}`);
    outcome = [502, {
      origin,
      message: { type: 'tb-github-identity', error: 'failed' },
      text: 'GitHub sign-in did not work. Close this window and try again.',
    }];
  }
  // Before responding: a serverless instance may freeze once the response is sent.
  if (accessToken) await revoke(accessToken);
  page(res, ...outcome);
}

/** Best effort: we never needed the GitHub token past GET /user. Never throws. */
async function revoke(accessToken) {
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  try {
    const r = await timedFetch(`${GITHUB_API}/applications/${CLIENT_ID}/token`, {
      method: 'DELETE',
      headers: { ...GITHUB_HEADERS, Authorization: `Basic ${basic}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_token: accessToken }),
    });
    if (r.status !== 204) console.warn(`github-auth: token revoke returned ${r.status}`);
  } catch {
    console.warn('github-auth: token revoke failed');
  }
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      res.status(405);
      res.end();
      return;
    }
    if (!ENABLED) {
      page(res, 503, { text: 'GitHub sign-in is not available on this book yet.' });
      return;
    }
    const params = new URL(req.url ?? '/', 'https://local.invalid').searchParams;
    if (params.has('state')) await callback(req, res, params);
    else start(req, res, params.get('origin') ?? '');
  } catch (err) {
    console.error('github-auth unhandled:', err);
    if (!res.headersSent) page(res, 500, { text: 'Something went wrong. Close this window and try again.' });
  }
}
