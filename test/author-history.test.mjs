/**
 * The author site's revision history (api/author-history.js) against the in-memory
 * GitHub (test/fake-github.mjs). Run with `npm test`.
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
Object.assign(process.env, { GITHUB_APP_ID: '123456', GITHUB_APP_PRIVATE_KEY: Buffer.from(PEM).toString('base64'), IDENTITY_SECRET: 'y'.repeat(40) });

const gh = createFakeGitHub();
globalThis.fetch = gh.fetch;

const { default: BUNDLE } = await import('../registry/bundled.mjs');
const { issueIdentity } = await import('../lib/identity.mjs');
const { default: history } = await import('../author/author-history.js');

const PAGE = BUNDLE.registry.platform.pages.find((p) => p.services.includes('author-api'));
const ORIGIN = `https://${PAGE.domain}`;
const BOOK = BUNDLE.registry.books.find((b) => b.slug === 'ontology-for-social-research-a-criti');
const { repo: REPO, drafts_branch: DRAFTS, live_branch: LIVE } = BOOK.content;
const AUTHOR = { login: 'BrandonAndCaroline', id: 777, name: 'Brandon' };
const STRANGER = { login: 'someone-else', id: 999, name: 'Someone' };
const CH = 'chapters/chapter-03.md';

const r = gh.repo(REPO);
const first = gh.commitFiles(REPO, LIVE, { [CH]: '# Chapter 3\n\nOld line.\n', 'glossary.md': '# Glossary\n' }, { message: 'initial', author: { name: 'Brandon', email: 'b@x', login: 'BrandonAndCaroline' } });
r.refs.set(DRAFTS, first);
const edit = gh.commitFiles(REPO, DRAFTS, { [CH]: '# Chapter 3\n\nNew line.\n', 'README.md': 'not an author file\n' }, { message: 'Edit chapter-03\n\nby @BrandonAndCaroline via the author site', author: { name: 'Brandon', email: 'b@x', login: 'BrandonAndCaroline' } });
for (let i = 0; i < 30; i++) gh.commitFiles(REPO, DRAFTS, { 'glossary.md': `# Glossary\n\nterm ${i}\n` }, { message: `glossary ${i}` });

function mockRes() {
  return {
    headers: {}, statusCode: 0, payload: undefined, ended: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(p) { this.payload = p; this.ended = true; return this; },
    end() { this.ended = true; return this; },
    get headersSent() { return this.ended; },
  };
}
async function get(params, { who = AUTHOR, origin = ORIGIN } = {}) {
  const headers = { origin };
  if (who) headers.authorization = `Bearer ${issueIdentity(process.env.IDENTITY_SECRET, who, origin)}`;
  const res = mockRes();
  await history({ method: 'GET', headers, url: `/api/author-history?${new URLSearchParams({ book: BOOK.slug, ...params })}`, socket: {} }, res);
  return res;
}

test('the book\'s commits on drafts, newest first, 30 a page, with what is still waiting marked', async () => {
  const p1 = await get({});
  assert.equal(p1.statusCode, 200);
  assert.equal(p1.payload.commits.length, 30);
  assert.equal(p1.payload.next, true);
  assert.equal(p1.payload.commits[0].message, 'glossary 29');
  assert.ok(p1.payload.commits.every((c) => !c.live));
  const p2 = await get({ page: '2' });
  assert.deepEqual(p2.payload.commits.map((c) => [c.sha, c.message, c.live, c.who]),
    [[edit, 'Edit chapter-03', false, 'BrandonAndCaroline'], [first, 'initial', true, 'BrandonAndCaroline']]);
  assert.equal(p2.payload.next, false);
});

test('one chapter\'s history: only the commits that changed it', async () => {
  const res = await get({ path: CH });
  assert.deepEqual(res.payload.commits.map((c) => c.sha), [edit, first]);
});

test('a revision: its author files with the patch, and the page then and before it', async () => {
  const res = await get({ sha: edit, path: CH });
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.parent, first);
  assert.equal(res.payload.live, false);
  assert.deepEqual(res.payload.files.map((f) => f.path), [CH]); // README.md isn't the author's
  assert.match(res.payload.files[0].patch, /\+New line\./);
  assert.deepEqual(res.payload.page, { path: CH, text: '# Chapter 3\n\nNew line.\n', before: '# Chapter 3\n\nOld line.\n' });
  const created = await get({ sha: first, path: CH });
  assert.equal(created.payload.page.before, null);
  assert.equal(created.payload.live, true);
});

test('refused: a non-author, no identity, another origin, a bad sha, page or path', async () => {
  assert.equal((await get({}, { who: STRANGER })).statusCode, 403);
  assert.equal((await get({}, { who: null })).statusCode, 401);
  assert.equal((await get({}, { origin: 'https://evil.example' })).statusCode, 403);
  assert.equal((await get({ sha: 'HEAD' })).statusCode, 400);
  assert.equal((await get({ page: '0' })).statusCode, 400);
  assert.equal((await get({ path: 'README.md' })).statusCode, 400);
  assert.equal((await get({ sha: edit, path: '.github/workflows/x.yml' })).statusCode, 400);
});
