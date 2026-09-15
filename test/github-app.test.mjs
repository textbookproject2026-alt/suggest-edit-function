/**
 * GitHub App credential path, with the token exchange stubbed. Run with `npm test`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { call, VALID, requests, loadHandler, stubTokenExchange } from './harness.mjs';
import BUNDLE from '../registry/bundled.mjs';
import { readCredentialConfig, createAppJwt } from '../lib/github-app.mjs';

const BOOK = BUNDLE.registry.books.find((b) => b.status !== 'retired' && b.site.domain && b.suggest_edit.enabled);
const ORIGIN = `https://${BOOK.site.domain}`;
const [, REPO_NAME] = BOOK.content.repo.split('/');

const { privateKey: PEM, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, // the format GitHub hands out
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const PEM_B64 = Buffer.from(PEM).toString('base64');

const APP_ENV = {
  GITHUB_APP_ID: '123456',
  GITHUB_APP_INSTALLATION_ID: '7890',
  GITHUB_APP_PRIVATE_KEY: PEM_B64,
};
const NO_APP = { GITHUB_APP_ID: undefined, GITHUB_APP_INSTALLATION_ID: undefined, GITHUB_APP_PRIVATE_KEY: undefined };

function captureLogs() {
  const lines = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  for (const level of Object.keys(saved)) console[level] = (...args) => lines.push(`${level}: ${args.join(' ')}`);
  return { lines, restore: () => Object.assign(console, saved) };
}

async function withLogs(fn) {
  const logs = captureLogs();
  try {
    return { result: await fn(), lines: logs.lines };
  } finally {
    logs.restore();
  }
}

/** A token exchange that succeeds, counting calls; `ttlMs` sets expires_at. */
function grantingExchange({ ttlMs = 60 * 60 * 1000, repo = BOOK.content.repo } = {}) {
  const state = { calls: 0 };
  stubTokenExchange(() => {
    state.calls++;
    return {
      ok: true, status: 201,
      json: async () => ({
        token: `ghs_installation_${state.calls}`,
        expires_at: new Date(Date.now() + ttlMs).toISOString(),
        permissions: { issues: 'write', metadata: 'read' },
        repository_selection: 'selected',
        repositories: [{ full_name: repo }],
      }),
    };
  });
  return state;
}

function failingExchange(status = 404) {
  stubTokenExchange(() => ({ ok: false, status, text: async () => '{"message":"Not Found"}' }));
}

const exchanges = () => requests.filter((q) => q.url.includes('/access_tokens'));
const githubCalls = () => requests.filter((q) => q.url.includes('/repos/'));
const authOf = (q) => q.headers.Authorization;

// ---------------------------------------------------------------------------
// JWT
// ---------------------------------------------------------------------------

test('the app JWT is RS256, signed by the private key, issued by the app, and under 10 minutes', () => {
  const now = Date.UTC(2026, 8, 15, 12, 0, 0);
  const { app } = readCredentialConfig(APP_ENV);
  const jwt = createAppJwt({ appId: app.appId, privateKey: app.privateKey, now });

  const [h, p, s] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'RS256', typ: 'JWT' });
  const payload = JSON.parse(Buffer.from(p, 'base64url'));
  assert.equal(payload.iss, '123456');
  assert.ok(payload.iat <= now / 1000, 'iat must not be in the future');
  assert.ok(payload.exp > now / 1000, 'exp must be in the future');
  assert.ok(payload.exp - payload.iat <= 600, 'GitHub refuses JWTs longer than 10 minutes');
  assert.ok(verify('sha256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url')), 'signature must verify');
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

test('config: a complete, well-formed App config is accepted', () => {
  const c = readCredentialConfig({ ...APP_ENV, GITHUB_APP_PRIVATE_KEY: `  ${PEM_B64.replace(/(.{76})/g, '$1\n')}\n` });
  assert.equal(c.appProblem, null);
  assert.equal(c.app.appId, '123456');
  assert.equal(c.app.installationId, '7890');
  assert.equal(c.botToken, null);
});

test('config: every missing or malformed App variable is named clearly, without key material', () => {
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256', privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
                                         publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
  const cases = [
    [{}, /GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY are not set/],
    [{ ...APP_ENV, GITHUB_APP_INSTALLATION_ID: undefined }, /^GITHUB_APP_INSTALLATION_ID is not set$/],
    [{ ...APP_ENV, GITHUB_APP_ID: '  ' }, /^GITHUB_APP_ID is not set$/],
    [{ ...APP_ENV, GITHUB_APP_ID: 'Iv1.abc' }, /GITHUB_APP_ID must be a number/],
    [{ ...APP_ENV, GITHUB_APP_INSTALLATION_ID: '78x' }, /GITHUB_APP_INSTALLATION_ID must be a number/],
    [{ ...APP_ENV, GITHUB_APP_PRIVATE_KEY: PEM }, /raw PEM; it must be base64-encoded/],
    [{ ...APP_ENV, GITHUB_APP_PRIVATE_KEY: PEM.replace(/\n/g, '\\n') }, /raw PEM/],
    [{ ...APP_ENV, GITHUB_APP_PRIVATE_KEY: 'not base64!' }, /not valid base64/],
    [{ ...APP_ENV, GITHUB_APP_PRIVATE_KEY: Buffer.from('hello world').toString('base64') }, /does not decode to a PEM/],
    [{ ...APP_ENV, GITHUB_APP_PRIVATE_KEY: Buffer.from('-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----\n').toString('base64') },
      /not a readable private key/],
    [{ ...APP_ENV, GITHUB_APP_PRIVATE_KEY: Buffer.from(ec).toString('base64') }, /is a ec key; GitHub App keys are RSA/],
  ];
  for (const [env, pattern] of cases) {
    const c = readCredentialConfig(env);
    assert.equal(c.app, null, String(pattern));
    assert.match(c.appProblem, pattern);
    assert.ok(!c.appProblem.includes(PEM_B64.slice(0, 40)) && !c.appProblem.includes('MII'), 'no key material in the problem');
  }
});

test('startup: the chosen credential path is logged at load', async () => {
  const app = await withLogs(() => loadHandler({ ...APP_ENV, BOT_TOKEN: undefined }));
  assert.ok(app.lines.includes('log: config: credential=app (app 123456, installation 7890)'), app.lines.join('\n'));

  const both = await withLogs(() => loadHandler({ ...APP_ENV, BOT_TOKEN: 'pat' }));
  assert.ok(both.lines.some((l) => l.includes('credential=app') && l.includes('BOT_TOKEN fallback is also set')));

  const malformed = await withLogs(() => loadHandler({ ...APP_ENV, GITHUB_APP_PRIVATE_KEY: PEM, BOT_TOKEN: 'pat' }));
  assert.ok(malformed.lines.some((l) => l.startsWith('error: config: GitHub App NOT usable') && l.includes('raw PEM')),
    malformed.lines.join('\n'));

  const none = await withLogs(() => loadHandler({ ...NO_APP, BOT_TOKEN: undefined }));
  assert.ok(none.lines.some((l) => l.startsWith('error: config: FATAL no GitHub credential')), none.lines.join('\n'));
});

test('startup: no credential at all refuses submissions with the existing 500, and still honours the honeypot', async () => {
  const h = await loadHandler({ ...NO_APP, BOT_TOKEN: undefined });
  const { result: r } = await withLogs(() => call({ using: h, origin: ORIGIN, body: { ...VALID } }));
  assert.equal(r.status, 500);
  assert.deepEqual(r.payload, { error: 'bot credentials not configured' });
  assert.equal(r.issue, null);

  const honey = await call({ using: h, origin: ORIGIN, body: { ...VALID, website: 'x' } });
  assert.equal(honey.status, 201);
});

// ---------------------------------------------------------------------------
// The App path through the handler
// ---------------------------------------------------------------------------

test('app path: mints a token downscoped to the resolved repo and issues:write, and files with it', async () => {
  const h = await loadHandler({ ...APP_ENV, BOT_TOKEN: undefined });
  grantingExchange();
  requests.length = 0;

  const { result: r, lines } = await withLogs(() => call({ using: h, origin: ORIGIN, body: { ...VALID } }));
  assert.equal(r.status, 201);
  assert.ok(r.issue);

  const [ex] = exchanges();
  assert.equal(exchanges().length, 1);
  assert.equal(ex.url, 'https://api.github.com/app/installations/7890/access_tokens');
  assert.deepEqual(ex.body, { repositories: [REPO_NAME], permissions: { issues: 'write' } });
  const jwt = authOf(ex).replace(/^Bearer /, '');
  const [hh, pp, ss] = jwt.split('.');
  assert.ok(verify('sha256', Buffer.from(`${hh}.${pp}`), publicKey, Buffer.from(ss, 'base64url')), 'exchange must use a valid app JWT');

  assert.ok(githubCalls().length >= 1);
  for (const q of githubCalls()) assert.equal(authOf(q), 'Bearer ghs_installation_1', q.url);
  assert.ok(requests.every((q) => !JSON.stringify(q.headers).includes('test-token')), 'BOT_TOKEN must not be sent');

  assert.ok(lines.includes(`log: credential=app (minted installation token for ${BOOK.content.repo}) book=${BOOK.slug}`),
    lines.join('\n'));
  assert.ok(lines.some((l) => l.includes('(credential=app)')));
});

test('app path: the token is cached per warm instance and re-minted near expiry', async () => {
  const h = await loadHandler({ ...APP_ENV, BOT_TOKEN: undefined });

  const long = grantingExchange();
  requests.length = 0;
  const first = await withLogs(() => call({ using: h, origin: ORIGIN, body: { ...VALID } }));
  const second = await withLogs(() => call({ using: h, origin: ORIGIN, body: { ...VALID } }));
  assert.equal(first.result.status, 201);
  assert.equal(second.result.status, 201);
  assert.equal(long.calls, 1, 'second request must reuse the cached token');
  assert.ok(second.lines.some((l) => l.startsWith('log: credential=app (cached')), second.lines.join('\n'));

  // A token with under five minutes left is not handed out.
  const h2 = await loadHandler({ ...APP_ENV, BOT_TOKEN: undefined });
  const short = grantingExchange({ ttlMs: 4 * 60 * 1000 });
  await withLogs(() => call({ using: h2, origin: ORIGIN, body: { ...VALID } }));
  await withLogs(() => call({ using: h2, origin: ORIGIN, body: { ...VALID } }));
  assert.equal(short.calls, 2);
});

test('app path: a 401 from GitHub drops the cached token so the next request re-mints', async () => {
  const h = await loadHandler({ ...APP_ENV, BOT_TOKEN: undefined });
  const state = grantingExchange();
  const realFetch = globalThis.fetch;
  let rejectOnce = true;
  globalThis.fetch = async (url, opts) => {
    if (rejectOnce && opts?.method === 'POST' && String(url).endsWith('/issues')) {
      rejectOnce = false;
      return { ok: false, status: 401, text: async () => 'Bad credentials' };
    }
    return realFetch(url, opts);
  };
  try {
    const bad = await withLogs(() => call({ using: h, origin: ORIGIN, body: { ...VALID } }));
    assert.equal(bad.result.status, 502);
    const good = await withLogs(() => call({ using: h, origin: ORIGIN, body: { ...VALID } }));
    assert.equal(good.result.status, 201);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(state.calls, 2);
});

test('app path: the honeypot and every refusal mint nothing', async () => {
  const h = await loadHandler({ ...APP_ENV, BOT_TOKEN: undefined });
  grantingExchange();
  requests.length = 0;
  await withLogs(async () => {
    await call({ using: h, origin: ORIGIN, body: { ...VALID, website: 'x' } });
    await call({ using: h, origin: ORIGIN, body: { bogus: 1 } });
    await call({ using: h, origin: ORIGIN, contentType: 'text/plain', body: { ...VALID } });
    await call({ using: h, origin: 'https://evil.example', body: { ...VALID } });
    await call({ using: h, method: 'OPTIONS', origin: ORIGIN });
  });
  assert.equal(requests.length, 0);
});

test('app path: exchange failure with no fallback is a 502 that files nothing', async () => {
  const h = await loadHandler({ ...APP_ENV, BOT_TOKEN: undefined });
  failingExchange(404);
  requests.length = 0;
  const { result: r, lines } = await withLogs(() => call({ using: h, origin: ORIGIN, body: { ...VALID } }));
  assert.equal(r.status, 502);
  assert.deepEqual(r.payload, { error: 'github: credential unavailable' });
  assert.equal(r.issue, null);
  assert.equal(githubCalls().length, 0);
  assert.ok(lines.some((l) => l.startsWith('error: credential: app token unavailable') && l.includes('no fallback')));
});

test('app path: a token granted for a different repo is refused, not used', async () => {
  const h = await loadHandler({ ...APP_ENV, BOT_TOKEN: undefined });
  grantingExchange({ repo: 'someone-else/textbook' });
  requests.length = 0;
  const { result: r, lines } = await withLogs(() => call({ using: h, origin: ORIGIN, body: { ...VALID } }));
  assert.equal(r.status, 502);
  assert.equal(githubCalls().length, 0);
  assert.ok(lines.some((l) => l.includes('granted someone-else/textbook')), lines.join('\n'));
});

test('fallback: exchange failure with BOT_TOKEN set files with BOT_TOKEN and says so', async () => {
  const h = await loadHandler({ ...APP_ENV, BOT_TOKEN: 'pat-fallback' });
  failingExchange(500);
  requests.length = 0;
  const { result: r, lines } = await withLogs(() => call({ using: h, origin: ORIGIN, body: { ...VALID } }));
  assert.equal(r.status, 201);
  for (const q of githubCalls()) assert.equal(authOf(q), 'Bearer pat-fallback');
  assert.ok(lines.some((l) => l.startsWith('warn: credential=bot_token (fallback; app token unavailable: token exchange returned 500)')),
    lines.join('\n'));
});

test('fallback: malformed App config with BOT_TOKEN set keeps the form up on BOT_TOKEN', async () => {
  const h = await withLogs(() => loadHandler({ ...APP_ENV, GITHUB_APP_ID: undefined, BOT_TOKEN: 'pat-fallback' }));
  stubTokenExchange(null); // any exchange attempt would throw
  requests.length = 0;
  const { result: r, lines } = await withLogs(() => call({ using: h.result, origin: ORIGIN, body: { ...VALID } }));
  assert.equal(r.status, 201);
  assert.equal(exchanges().length, 0);
  for (const q of githubCalls()) assert.equal(authOf(q), 'Bearer pat-fallback');
  assert.ok(lines.some((l) => l.startsWith('warn: credential=bot_token (fallback; app not configured: GITHUB_APP_ID is not set)')),
    lines.join('\n'));
});

test('app and BOT_TOKEN paths send identical GitHub requests apart from Authorization', async () => {
  const strip = (qs) => qs.map(({ method, url, headers, body }) => {
    const { Authorization, ...rest } = headers;
    return { method, url, headers: rest, body };
  });

  const pat = await loadHandler({ ...NO_APP, BOT_TOKEN: 'pat' });
  requests.length = 0;
  await withLogs(() => call({ using: pat, origin: ORIGIN, body: { ...VALID } }));
  const viaPat = strip(githubCalls());

  const app = await loadHandler({ ...APP_ENV, BOT_TOKEN: undefined });
  grantingExchange();
  requests.length = 0;
  await withLogs(() => call({ using: app, origin: ORIGIN, body: { ...VALID } }));
  const viaApp = strip(githubCalls());

  assert.ok(viaPat.length >= 1);
  assert.deepEqual(viaApp, viaPat);
});

test('no response ever leaks the private key, the JWT, or an installation token', async () => {
  const h = await loadHandler({ ...APP_ENV, BOT_TOKEN: undefined });
  const secrets = [PEM_B64.slice(0, 40), 'PRIVATE KEY', 'ghs_installation', 'eyJ'];
  const probes = [
    () => { grantingExchange(); return call({ using: h, origin: ORIGIN, body: { ...VALID } }); },
    () => { failingExchange(401); return loadHandler({ ...APP_ENV, BOT_TOKEN: undefined })
      .then((fresh) => call({ using: fresh, origin: ORIGIN, body: { ...VALID } })); },
    () => call({ using: h, origin: ORIGIN, body: { bogus: 1 } }),
  ];
  for (const probe of probes) {
    const { result: r } = await withLogs(probe);
    const s = JSON.stringify({ payload: r.payload, headers: r.headers });
    for (const secret of secrets) assert.ok(!s.includes(secret), `response must not contain ${secret}`);
  }
});
