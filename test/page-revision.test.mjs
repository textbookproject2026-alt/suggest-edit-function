/**
 * api/page-revision.js against the in-memory GitHub (test/fake-github.mjs): public,
 * live branch only, a file the commit changed only, cached, and an anonymous
 * proposal's name from its App-written pull request. Run with `npm test`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createFakeGitHub } from './fake-github.mjs';

const { privateKey: PEM } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
delete process.env.GITHUB_APP_INSTALLATION_ID;
delete process.env.BOT_TOKEN;
Object.assign(process.env, { GITHUB_APP_ID: '123456', GITHUB_APP_PRIVATE_KEY: Buffer.from(PEM).toString('base64') });

const gh = createFakeGitHub();
globalThis.fetch = gh.fetch;

const { default: BUNDLE } = await import('../registry/bundled.mjs');
const { default: handler, proposerName, forPreview } = await import('../api/page-revision.js');

const BOOK = BUNDLE.registry.books.find((b) => b.status === 'live');
const REPO = BOOK.content.repo;
const LIVE = BOOK.content.live_branch;
const PAGE = 'chapters/one.md';
const BOT = { name: 'textbook-suggest-edit[bot]', email: '329478423+textbook-suggest-edit[bot]@users.noreply.github.com' };

const v1 = gh.commitFiles(REPO, LIVE, { [PAGE]: '# One\n\nFirst words.\n', 'index.md': '# Book\n' }, { message: 'first' });
const v2 = gh.commitFiles(REPO, LIVE, { [PAGE]: '# One\n\nBetter words.\n' }, { message: 'Fix a word\n\nProposed by a reader with the in-site editor.', author: BOT });
const v3 = gh.commitFiles(REPO, LIVE, { [PAGE]: '# One\n\nBest words.\n' }, { message: 'Tidy\n\nCo-authored-by: Ann <1+ann@users.noreply.github.com>', author: BOT });
const draftsOnly = gh.commitFiles(REPO, 'drafts-only', { [PAGE]: 'secret draft\n' }, { message: 'not yet' });

const r = gh.repo(REPO);
const json = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
gh.state.hooks = {
  '/markdown': ({ body }) => ({ ok: true, status: 200, text: async () => `<p>${body.text.length}</p>`, json: async () => ({}) }),
  '/pulls?per_page': ({ url }) => json(200, url.includes(v2) ? [{ user: { type: 'Bot' }, body: '**Proposed by:** `Jo Reader` (`j***@example.com`)' }] : []),
  '/contents/': ({ url }) => {
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname.split('/contents/')[1]);
    const t = gh.textAt(REPO, u.searchParams.get('ref'), path);
    return t === undefined ? json(404, {}) : json(200, { type: 'file', content: Buffer.from(t).toString('base64') });
  },
  [`/repos/${REPO}/commits/`]: ({ url }) => {
    const sha = /\/commits\/([0-9a-f]{40})$/.exec(new URL(url).pathname)?.[1];
    if (!sha) return null;
    const c = r.commits.get(sha);
    const parent = c.parents[0];
    const A = parent ? gh.filesAt(REPO, parent) : new Map();
    const B = gh.filesAt(REPO, sha);
    const files = [...new Set([...A.keys(), ...B.keys()])].filter((p) => A.get(p) !== B.get(p))
      .map((p) => ({ filename: p, status: !A.has(p) ? 'added' : !B.has(p) ? 'removed' : 'modified' }));
    return json(200, { sha, parents: c.parents.map((s) => ({ sha: s })), files, commit: { message: c.message, author: c.author }, author: null });
  },
};

function mockRes() {
  return {
    headers: {}, statusCode: 0, payload: undefined,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(p) { this.payload = p; this.ended = true; return this; },
    end() { this.ended = true; return this; },
    get headersSent() { return !!this.ended; },
  };
}
let ip = 0;
async function get(params, { method = 'GET', from = `10.9.0.${++ip}` } = {}) {
  const res = mockRes();
  await handler({ method, url: `/api/page-revision?${new URLSearchParams(params)}`, headers: { 'x-forwarded-for': from } }, res);
  return res;
}

test('a live revision: before and after, rendered, cached for a year, any origin', async () => {
  const res = await get({ book: BOOK.slug, sha: v3, path: PAGE });
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.before, '# One\n\nBetter words.\n');
  assert.equal(res.payload.after, '# One\n\nBest words.\n');
  assert.equal(res.payload.parent, v2);
  assert.equal(res.payload.status, 'modified');
  assert.match(res.payload.html, /^<p>\d+<\/p>$/);
  assert.equal(res.payload.proposer, null, 'a human co-author is credited by the build, not here');
  assert.equal(res.headers['access-control-allow-origin'], '*');
  assert.match(res.headers['cache-control'], /s-maxage=31536000/);
});

test('an anonymous in-site proposal: the name from the App-written pull request', async () => {
  const res = await get({ book: BOOK.slug, sha: v2, path: PAGE });
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.proposer, 'Jo Reader');
});

test('a page added in the revision has no before', async () => {
  const res = await get({ book: BOOK.slug, sha: v1, path: PAGE });
  assert.equal(res.payload.status, 'added');
  assert.equal(res.payload.before, '');
});

test('refusals: not on the live branch, a file the commit did not change, unknown and retired books, bad input', async () => {
  const off = await get({ book: BOOK.slug, sha: draftsOnly, path: PAGE });
  assert.equal(off.statusCode, 404);
  assert.equal(off.payload.error, 'not on the live branch');
  assert.match(off.headers['cache-control'], /s-maxage=300/);
  assert.equal((await get({ book: BOOK.slug, sha: v2, path: 'index.md' })).statusCode, 404);
  assert.equal((await get({ book: 'no-such-book', sha: v2, path: PAGE })).statusCode, 404);
  const retired = BUNDLE.registry.books.find((b) => b.status === 'retired');
  if (retired) assert.equal((await get({ book: retired.slug, sha: v2, path: PAGE })).statusCode, 404);
  assert.equal((await get({ book: BOOK.slug, sha: 'abc', path: PAGE })).statusCode, 400);
  assert.equal((await get({ book: BOOK.slug, sha: v2, path: '../secret.md' })).statusCode, 400);
  assert.equal((await get({ book: BOOK.slug, sha: v2, path: PAGE }, { method: 'POST' })).statusCode, 405);
  assert.equal((await get({}, { method: 'OPTIONS' })).statusCode, 204);
});

test('rate-limited per IP', async () => {
  let last;
  for (let i = 0; i < 121; i++) last = await get({ book: BOOK.slug, sha: 'bad' }, { from: '10.99.0.1' });
  assert.equal(last.statusCode, 400, 'invalid input is refused before the limiter counts it');
  for (let i = 0; i < 121; i++) last = await get({ book: BOOK.slug, sha: v3, path: PAGE }, { from: '10.99.0.2' });
  assert.equal(last.statusCode, 429);
});

test('proposerName and forPreview', () => {
  assert.equal(proposerName('x\n\n**Proposed by:** `A ``B` (`a***@b.c`)'), 'A ``B');
  assert.equal(proposerName('**Proposed by:** @someone (signed in with GitHub)'), null);
  assert.equal(proposerName(null), null);
  assert.equal(forPreview('---\na: 1\n---\nSee [[x/Page|that]] and [[y/Other]].'), 'See that and Other.');
});
