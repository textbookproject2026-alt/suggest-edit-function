/**
 * /api/propose-edit and /api/github-auth, against an in-memory GitHub.
 * Run with `npm test`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

for (const name of ['GITHUB_APP_ID', 'GITHUB_APP_INSTALLATION_ID', 'GITHUB_APP_PRIVATE_KEY']) delete process.env[name];
process.env.BOT_TOKEN = 'test-token';
process.env.IDENTITY_SECRET = 'x'.repeat(40);
process.env.GITHUB_OAUTH_CLIENT_ID = 'client-id';
process.env.GITHUB_OAUTH_CLIENT_SECRET = 'client-secret';

const { default: BUNDLE } = await import('../registry/bundled.mjs');
const BOOK = BUNDLE.registry.books.find((b) => b.status !== 'retired' && b.site.domain && b.suggest_edit.enabled);
const ORIGIN = `https://${BOOK.site.domain}`;
const REPO = BOOK.content.repo;
const BASE = BOOK.content.drafts_branch || BOOK.content.live_branch;
const PATH = 'chapters/chapter-03.md';
const COMMIT = 'c'.repeat(40);
const SHA0 = 'a'.repeat(40);
const TEXT0 = '---\ntitle: T\n---\n\nFirst paragraph here.\n\nSecond paragraph, recieve.\n\nThird.\n';

// --- a small GitHub -----------------------------------------------------------
const gh = {};
function resetGitHub({ text = TEXT0, sha = SHA0, crlf = false } = {}) {
  Object.assign(gh, {
    text: crlf ? text.replace(/\n/g, '\r\n') : text, sha, refs: [], puts: [], pulls: [], issues: [],
    deleted: [], labelled: [], putStatus: 200, prStatus: 201, calls: [],
  });
}
resetGitHub();
const json = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  const method = opts.method ?? 'GET';
  const body = opts.body ? JSON.parse(opts.body) : undefined;
  gh.calls.push({ method, url, body, headers: opts.headers });
  const api = `https://api.github.com/repos/${REPO}`;
  if (url === 'https://github.com/login/oauth/access_token') return json(200, { access_token: 'gho_secret' });
  if (url === 'https://api.github.com/user') return json(200, { login: 'ada-l', id: 42, name: 'Ada' });
  if (url.startsWith('https://api.github.com/applications/')) return { ok: true, status: 204 };
  if (!url.startsWith(api)) throw new Error(`unexpected ${method} ${url}`);
  const rest = url.slice(api.length);
  if (method === 'GET' && rest === `/git/ref/heads/${BASE}`) return json(200, { object: { sha: COMMIT } });
  if (method === 'GET' && rest.startsWith(`/contents/${PATH}?ref=`)) {
    return json(200, { type: 'file', sha: gh.sha, encoding: 'base64', content: Buffer.from(gh.text).toString('base64') });
  }
  if (method === 'GET' && rest.startsWith('/contents/')) return json(404, { message: 'Not Found' });
  if (method === 'GET' && rest === `/git/blobs/${SHA0}`) {
    return json(200, { encoding: 'base64', content: Buffer.from(TEXT0).toString('base64') });
  }
  if (method === 'POST' && rest === '/git/refs') { gh.refs.push(body); return json(201, {}); }
  if (method === 'PUT' && rest === `/contents/${PATH}`) { gh.puts.push(body); return json(gh.putStatus, {}); }
  if (method === 'POST' && rest === '/pulls') {
    gh.pulls.push(body);
    return json(gh.prStatus, { html_url: `https://github.com/${REPO}/pull/7`, number: 7, base: { repo: { full_name: REPO } } });
  }
  if (method === 'POST' && rest === '/issues') { gh.issues.push(body); return json(201, { html_url: `https://github.com/${REPO}/issues/9` }); }
  if (method === 'POST' && rest === '/issues/7/labels') { gh.labelled.push(body); return json(200, []); }
  if (method === 'DELETE' && rest.startsWith('/git/refs/heads/')) { gh.deleted.push(rest); return { ok: true, status: 204 }; }
  if (rest.startsWith('/labels/')) return json(200, {});
  throw new Error(`unexpected ${method} ${url}`);
};

const { default: handler } = await import('../api/propose-edit.js');
const { default: auth } = await import('../api/github-auth.js');
const { applyEdit, lineDiff } = await import('../api/propose-edit.js');
const { issueIdentity, readIdentity, sign } = await import('../lib/identity.mjs');

function mockRes() {
  return {
    headers: {}, statusCode: 0, payload: undefined, body: '', ended: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(p) { this.payload = p; this.ended = true; return this; },
    end(b) { if (b) this.body = b; this.ended = true; return this; },
    get headersSent() { return this.ended; },
  };
}
let ip = 0;
async function call({ method = 'POST', body, origin = ORIGIN, url = '/api/propose-edit', cookie, handle = handler } = {}) {
  const headers = { 'x-forwarded-for': `10.9.${Math.floor(ip / 250)}.${(ip++ % 250) + 1}`, 'content-type': 'application/json', host: 'fn.example' };
  if (origin) headers.origin = origin;
  if (cookie) headers.cookie = cookie;
  const res = mockRes();
  await handle({ method, headers, url, body, socket: {} }, res);
  return res;
}
const ANON = { name: 'A Reader', email: 'reader@example.org' };
const para = (extra = {}) => ({
  mode: 'paragraph', path: PATH, baseSha: SHA0, startLine: 6,
  original: 'Second paragraph, recieve.', replacement: 'Second paragraph, receive.', paragraph: 2,
  title: '', description: '', ...ANON, ...extra,
});
const decodePut = () => Buffer.from(gh.puts[0].content, 'base64').toString('utf8');

// --- GET ---------------------------------------------------------------------------

test('GET returns the drafts source, its sha, and whether sign-in is on', async () => {
  resetGitHub();
  const r = await call({ method: 'GET', url: `/api/propose-edit?path=${encodeURIComponent(PATH)}` });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.payload, { path: PATH, branch: BASE, sha: SHA0, content: TEXT0, signIn: true });
  assert.equal(r.headers['access-control-allow-origin'], ORIGIN);
});

test('GET normalises CRLF to LF, and refuses unsafe paths and unknown pages', async () => {
  resetGitHub({ crlf: true });
  const ok = await call({ method: 'GET', url: `/api/propose-edit?path=${PATH}` });
  assert.equal(ok.payload.content, TEXT0);
  assert.equal((await call({ method: 'GET', url: '/api/propose-edit?path=../x.md' })).statusCode, 400);
  assert.equal((await call({ method: 'GET', url: '/api/propose-edit?path=nope.md' })).statusCode, 404);
});

test('an unregistered or missing Origin gets 403 and no CORS headers, GET and POST alike', async () => {
  for (const method of ['GET', 'POST']) {
    for (const origin of ['https://evil.example', null]) {
      const r = await call({ method, origin, body: para(), url: `/api/propose-edit?path=${PATH}` });
      assert.equal(r.statusCode, 403);
      assert.equal(r.headers['access-control-allow-origin'], undefined);
    }
  }
});

// --- POST: applied -------------------------------------------------------------------

test('paragraph edit: branch from the drafts head, one commit, PR into drafts, labelled', async () => {
  resetGitHub();
  const r = await call({ body: para() });
  assert.equal(r.statusCode, 201);
  assert.equal(r.payload.prUrl, `https://github.com/${REPO}/pull/7`);
  assert.equal(gh.refs[0].sha, COMMIT);
  assert.match(gh.refs[0].ref, /^refs\/heads\/proposed-edits\/chapter-03-[a-z0-9]+-[0-9a-f]{4}$/);
  assert.equal(decodePut(), TEXT0.replace('recieve', 'receive'));
  assert.equal(gh.puts[0].sha, SHA0);
  assert.equal(gh.puts[0].author, undefined, 'anonymous: the App is the author');
  assert.equal(gh.pulls[0].base, BASE);
  assert.equal(gh.pulls[0].title, 'Update chapter-03');
  assert.match(gh.pulls[0].body, /\*\*Where:\*\* ¶2/);
  assert.match(gh.pulls[0].body, /`A Reader` \(`r\*\*\*@example\.org`\)/);
  assert.ok(!gh.pulls[0].body.includes('reader@example.org'), 'never the full email');
  assert.ok(!gh.puts[0].message.includes('A Reader'), 'the name stays out of git history');
  assert.deepEqual(gh.labelled[0].labels, ['proposed-edit', 'needs-triage']);
});

test('page edit keeps the file\'s CRLF line endings', async () => {
  resetGitHub({ crlf: true });
  const content = TEXT0.replace('Third.', 'Third, edited.');
  const r = await call({ body: { mode: 'page', path: PATH, baseSha: SHA0, content, title: 'Fix', ...ANON } });
  assert.equal(r.statusCode, 201);
  assert.equal(decodePut(), content.replace(/\n/g, '\r\n'));
});

test('signed in: the commit is authored by the reader\'s GitHub noreply address, and the PR names them', async () => {
  resetGitHub();
  const identity = issueIdentity(process.env.IDENTITY_SECRET, { login: 'ada-l', id: 42, name: 'Ada' }, ORIGIN);
  const r = await call({ body: para({ name: '', email: '', identity }) });
  assert.equal(r.statusCode, 201);
  assert.deepEqual(gh.puts[0].author, { name: 'Ada', email: '42+ada-l@users.noreply.github.com' });
  assert.match(gh.pulls[0].body, /\*\*Proposed by:\*\* @ada-l \(signed in with GitHub\)/);
});

test('a forged, expired or other-book identity is a 401 with a way forward, and writes nothing', async () => {
  resetGitHub();
  const secret = process.env.IDENTITY_SECRET;
  const bad = [
    issueIdentity('y'.repeat(40), { login: 'ada-l', id: 42 }, ORIGIN),
    issueIdentity(secret, { login: 'ada-l', id: 42 }, ORIGIN, Date.now() - 9 * 3600e3),
    issueIdentity(secret, { login: 'ada-l', id: 42 }, 'https://other.example'),
    sign(secret, { k: 'state', o: ORIGIN, n: 'x', e: Date.now() + 1e6 }), // a state is not an identity
  ];
  for (const identity of bad) {
    const r = await call({ body: para({ identity }) });
    assert.equal(r.statusCode, 401);
    assert.ok(r.payload.userMessage);
  }
  assert.equal(gh.refs.length, 0);
});

// --- POST: conflicts fall back to an issue -------------------------------------------------

test('drafts moved but the paragraph is still there once: applied by text', async () => {
  resetGitHub({ text: 'New intro.\n\n' + TEXT0, sha: 'b'.repeat(40) });
  const r = await call({ body: para() });
  assert.equal(r.statusCode, 201);
  assert.ok(r.payload.prUrl);
  assert.equal(decodePut(), ('New intro.\n\n' + TEXT0).replace('recieve', 'receive'));
});

test('drafts moved and the paragraph is gone: an issue with the reader\'s change, no branch', async () => {
  resetGitHub({ text: TEXT0.replace('Second paragraph, recieve.', 'Rewritten.'), sha: 'b'.repeat(40) });
  const r = await call({ body: para() });
  assert.equal(r.statusCode, 201);
  assert.deepEqual(r.payload, { issueUrl: `https://github.com/${REPO}/issues/9`, fallback: true });
  assert.equal(gh.refs.length, 0);
  assert.match(gh.issues[0].body, /-Second paragraph, recieve\.\n\+Second paragraph, receive\./);
});

test('page mode on a moved file: an issue with the diff against what they edited', async () => {
  resetGitHub({ sha: 'b'.repeat(40) });
  const content = TEXT0.replace('Third.', 'Third, edited.');
  const r = await call({ body: { mode: 'page', path: PATH, baseSha: SHA0, content, ...ANON } });
  assert.equal(r.payload.fallback, true);
  assert.match(gh.issues[0].body, /-Third\.\n\+Third, edited\./);
});

test('a 409 from the commit (a race) also becomes an issue, and the branch is removed', async () => {
  resetGitHub();
  gh.putStatus = 409;
  const r = await call({ body: para() });
  assert.equal(r.payload.fallback, true);
  assert.equal(gh.deleted.length, 1);
});

test('a failed PR is a 502, cleans up its branch, and leaks nothing', async () => {
  resetGitHub();
  gh.prStatus = 500;
  const r = await call({ body: para() });
  assert.equal(r.statusCode, 502);
  assert.equal(gh.deleted.length, 1);
  assert.ok(!JSON.stringify(r.payload).includes('test-token'));
});

// --- POST: refusals ------------------------------------------------------------------------

test('no change, bad fields, and the honeypot', async () => {
  resetGitHub();
  const same = await call({ body: para({ replacement: 'Second paragraph, recieve.' }) });
  assert.equal(same.statusCode, 400);
  assert.equal(same.payload.userMessage, "You haven't changed anything yet.");
  for (const body of [
    para({ mode: 'other' }), para({ path: '../etc.md' }), para({ baseSha: 'zz' }), para({ startLine: -1 }),
    para({ original: '' }), para({ name: '' }), para({ email: 'nope' }), para({ title: 'x'.repeat(201) }),
    { mode: 'page', path: PATH, baseSha: SHA0, content: 'x'.repeat(400_001), ...ANON },
  ]) {
    assert.equal((await call({ body })).statusCode, 400, JSON.stringify(body).slice(0, 80));
  }
  const bot = await call({ body: para({ website: 'http://spam' }) });
  assert.equal(bot.statusCode, 201);
  assert.equal(gh.refs.length, 0);
});

test('text/plain is refused before anything else (forces a CORS preflight)', async () => {
  const res = mockRes();
  await handler({ method: 'POST', headers: { origin: ORIGIN, 'content-type': 'text/plain' }, body: '{}', socket: {} }, res);
  assert.equal(res.statusCode, 415);
});

test('five proposals an hour per IP', async () => {
  resetGitHub();
  const headers = { origin: ORIGIN, 'content-type': 'application/json', 'x-forwarded-for': '10.99.0.1' };
  const statuses = [];
  for (let i = 0; i < 6; i++) {
    const res = mockRes();
    await handler({ method: 'POST', headers, body: para({ mode: 'bad' }), socket: {} }, res);
    statuses.push(res.statusCode);
  }
  assert.deepEqual(statuses, [400, 400, 400, 400, 400, 429]);
});

// --- pure helpers --------------------------------------------------------------------------

test('applyEdit: exact line replacement on the same snapshot, even with a duplicate elsewhere', () => {
  const text = 'Same.\n\nSame.\n';
  const out = applyEdit({ sha: SHA0, text }, { mode: 'paragraph', baseSha: SHA0, startLine: 2, original: 'Same.', replacement: 'Changed.' });
  assert.equal(out, 'Same.\n\nChanged.\n');
  assert.throws(() => applyEdit({ sha: 'b'.repeat(40), text }, { mode: 'paragraph', baseSha: SHA0, startLine: 2, original: 'Same.', replacement: 'x' }));
});

test('lineDiff shows only the changed middle', () => {
  assert.equal(lineDiff('a\nb\nc', 'a\nB\nc'), '@@ line 2 @@\n-b\n+B');
});

// --- github-auth ---------------------------------------------------------------------------

test('sign-in start: a registered origin gets a nonce cookie and a redirect to GitHub with no scopes', async () => {
  const r = await call({ method: 'GET', handle: auth, origin: null, url: `/api/github-auth?origin=${encodeURIComponent(ORIGIN)}` });
  assert.equal(r.statusCode, 302);
  const loc = new URL(r.headers.location);
  assert.equal(loc.origin + loc.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(loc.searchParams.get('scope'), '');
  assert.equal(loc.searchParams.get('redirect_uri'), 'https://fn.example/api/github-auth');
  assert.match(r.headers['set-cookie'], /^tb_oauth=[\w-]+; Path=\/api\/github-auth; Max-Age=600; HttpOnly; Secure; SameSite=Lax$/);
  const bad = await call({ method: 'GET', handle: auth, origin: null, url: '/api/github-auth?origin=https%3A%2F%2Fevil.example' });
  assert.equal(bad.statusCode, 403);
});

test('sign-in callback: posts an identity to the book origin only, and revokes GitHub\'s token', async () => {
  resetGitHub();
  const start = await call({ method: 'GET', handle: auth, origin: null, url: `/api/github-auth?origin=${encodeURIComponent(ORIGIN)}` });
  const state = new URL(start.headers.location).searchParams.get('state');
  const nonce = start.headers['set-cookie'].split(';')[0];
  const r = await call({ method: 'GET', handle: auth, origin: null, cookie: nonce, url: `/api/github-auth?code=abc&state=${encodeURIComponent(state)}` });
  assert.equal(r.statusCode, 200);
  const data = JSON.parse(/var d = (\{.*\});/.exec(r.body)[1]);
  assert.equal(data.origin, ORIGIN);
  assert.equal(data.message.login, 'ada-l');
  assert.deepEqual(readIdentity(process.env.IDENTITY_SECRET, data.message.token, ORIGIN), { login: 'ada-l', id: 42, name: 'Ada' });
  assert.ok(!r.body.includes('gho_secret'), 'GitHub\'s token never reaches the page');
  assert.ok(gh.calls.some((c) => c.method === 'DELETE' && c.url.includes('/applications/client-id/token')), 'revoked');
  assert.match(r.headers['content-security-policy'], /default-src 'none'/);

  // Without the nonce cookie (another browser), the same state is refused.
  const stolen = await call({ method: 'GET', handle: auth, origin: null, url: `/api/github-auth?code=abc&state=${encodeURIComponent(state)}` });
  assert.equal(stolen.statusCode, 400);
});

test('setup problems tell the reader plainly: no drafts branch, and no usable credential', async () => {
  resetGitHub();
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, opts) =>
    String(url).includes('/git/ref/heads/') ? json(404, { message: 'Not Found' }) : saved(url, opts);
  try {
    const r = await call({ method: 'GET', url: `/api/propose-edit?path=${PATH}` });
    assert.equal(r.statusCode, 502);
    assert.match(r.payload.userMessage, /no drafts branch/);
  } finally {
    globalThis.fetch = saved;
  }
});
