/**
 * The author site's endpoints (api/author-*.js) against an in-memory GitHub
 * (test/fake-github.mjs), through their shipped code paths. Run with `npm test`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createFakeGitHub, blobId } from './fake-github.mjs';

const { privateKey: PEM } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const APP_ENV = { GITHUB_APP_ID: '123456', GITHUB_APP_PRIVATE_KEY: Buffer.from(PEM).toString('base64') };
delete process.env.GITHUB_APP_INSTALLATION_ID;
delete process.env.BOT_TOKEN;
delete process.env.REQUESTS_REPO;
Object.assign(process.env, APP_ENV, {
  IDENTITY_SECRET: 'y'.repeat(40),
  GITHUB_OAUTH_CLIENT_ID: 'client-id',
  GITHUB_OAUTH_CLIENT_SECRET: 'client-secret',
});

const gh = createFakeGitHub();
globalThis.fetch = gh.fetch;

// These tests sign in with a GitHub identity token, which production now takes only
// for author-read?what=books (member.test.mjs checks that).
(await import('../lib/author.mjs')).LEGACY_BEARER.everywhere = true;
const { default: BUNDLE } = await import('../registry/bundled.mjs');
const { issueIdentity, sign } = await import('../lib/identity.mjs');
const { isAuthorPath } = await import('../lib/author.mjs');
const { partReceipt } = await import('../lib/author-import.mjs');
const { default: read } = await import('../author/author-read.js');
const { default: sendEp } = await import('../author/author-send.js');
const { default: importEp } = await import('../author/author-import.js');
const { default: act } = await import('../author/author-act.js');
const { default: auth } = await import('../api/github-auth.js');
const { proposeSlug } = await import('../api/request-book.js');
const { validateRegistry, createPageResolver } = await import('../lib/registry.mjs');

const SECRET = process.env.IDENTITY_SECRET;
const PAGE = BUNDLE.registry.platform.pages.find((p) => p.services.includes('author-api'));
const ORIGIN = `https://${PAGE.domain}`;
const PREVIEW_ORIGIN = `https://abc123.${PAGE.host.project}.pages.dev`;
const BOOK = BUNDLE.registry.books.find((b) => b.slug === 'ontology-for-social-research-a-criti');
const OTHER = BUNDLE.registry.books.find((b) => b.slug === 'platform-test-book');
const RETIRED = BUNDLE.registry.books.find((b) => b.status === 'retired');
const REPO = BOOK.content.repo;
const DRAFTS = BOOK.content.drafts_branch;
const LIVE = BOOK.content.live_branch;
const REQUESTS = 'textbookproject2026-alt/book-requests';

const AUTHOR = { login: 'brandonandcaroline', id: 777, name: 'Brandon' }; // registry has BrandonAndCaroline
const STRANGER = { login: 'someone-else', id: 999, name: 'Someone' };
const tokenFor = (who, origin = ORIGIN) => issueIdentity(SECRET, who, origin);

// --- the book as GitHub holds it -------------------------------------------------

const CH3 = '# Chapter 3\n\nThe the domains of reality.\n\nSecond paragraph.\n';
let BASE;
function resetBook() {
  const r = gh.repo(REPO);
  r.refs.clear();
  gh.commitFiles(REPO, LIVE, {
    'index.md': '# Book\n\n## Contents\n\n- **[[chapters/chapter-03|Chapter 3]]**\n',
    'glossary.md': '# Glossary\n',
    'chapters/chapter-03.md': CH3,
    'assets/chapter-03/image1.png': Buffer.from([1, 2, 3]),
    '.github/workflows/build.yml': 'on: push\n',
    'README.md': '# readme\n',
  }, { message: 'initial' });
  r.refs.set(DRAFTS, r.refs.get(LIVE));
  BASE = r.refs.get(DRAFTS);
  r.issues.clear();
  r.pulls.clear();
}
resetBook();
gh.commitFiles(REQUESTS, 'main', { 'README.md': 'requests\n' });

// --- calling a handler ----------------------------------------------------------------

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
async function call(handler, { method = 'POST', url = '/', body, origin = ORIGIN, who = AUTHOR, token, contentType = 'application/json' } = {}) {
  const headers = { 'x-forwarded-for': '10.1.1.1', host: 'fn.example' };
  if (contentType) headers['content-type'] = contentType;
  if (origin) headers.origin = origin;
  const t = token !== undefined ? token : who ? tokenFor(who, origin ?? ORIGIN) : null;
  if (t) headers.authorization = `Bearer ${t}`;
  const res = mockRes();
  await handler({ method, headers, url, body, socket: {} }, res);
  return res;
}
const get = (what, params = {}, opts = {}) =>
  call(read, { method: 'GET', url: `/api/author-read?${new URLSearchParams({ what, ...params })}`, ...opts });

// --- who may ask ------------------------------------------------------------------------

test('a platform page without author-api, a book origin, or no origin: 403 and no CORS', async () => {
  for (const origin of [`https://${BUNDLE.registry.platform.portal.domain}`, `https://${BOOK.site.domain}`, 'https://evil.example', null]) {
    const r = await get('books', {}, { origin });
    assert.equal(r.statusCode, 403, String(origin));
    assert.equal(r.headers['access-control-allow-origin'], undefined);
  }
});

test('the author site and its Pages previews are accepted; the preflight allows Authorization', async () => {
  for (const origin of [ORIGIN, PREVIEW_ORIGIN]) {
    const pre = await call(read, { method: 'OPTIONS', origin, who: null });
    assert.equal(pre.statusCode, 204);
    assert.equal(pre.headers['access-control-allow-origin'], origin);
    assert.match(pre.headers['access-control-allow-headers'], /Authorization/);
    assert.equal((await get('books', {}, { origin })).statusCode, 200);
  }
});

test('no identity, a forged one, an expired one, or one issued to another origin: 401', async () => {
  assert.equal((await get('books', {}, { who: null })).statusCode, 401);
  assert.equal((await get('books', {}, { token: 'v1.e30.forged' })).statusCode, 401);
  const expired = issueIdentity(SECRET, AUTHOR, ORIGIN, Date.now() - 9 * 3600_000);
  assert.equal((await get('books', {}, { token: expired })).statusCode, 401);
  // Issued to a book's in-site editor: useless here.
  assert.equal((await get('books', {}, { token: tokenFor(AUTHOR, `https://${BOOK.site.domain}`) })).statusCode, 401);
  // Issued to the preview, presented from the domain.
  assert.equal((await get('books', {}, { token: tokenFor(AUTHOR, PREVIEW_ORIGIN) })).statusCode, 401);
});

test('books lists only the books whose authors include the login, case-insensitively, never retired ones', async () => {
  const r = await get('books');
  assert.equal(r.statusCode, 200);
  const slugs = r.payload.books.map((b) => b.slug).sort();
  assert.deepEqual(slugs, ['from-ontology-to-method-an-ontologic', 'ontology-for-social-research-a-criti']);
  assert.equal(r.payload.books[0].zip, `https://github.com/${r.payload.books[0].repo}/archive/refs/heads/drafts.zip`);
  const none = await get('books', {}, { who: STRANGER });
  assert.deepEqual(none.payload.books, []);
});

test('a non-author is refused every book-scoped read and write, and nothing is written', async () => {
  resetBook();
  const before = gh.state.calls.length;
  for (const [who, slug] of [[STRANGER, BOOK.slug], [AUTHOR, OTHER.slug], [AUTHOR, RETIRED.slug], [AUTHOR, 'no-such-book']]) {
    assert.equal((await get('tree', { book: slug }, { who })).statusCode, 403, `${who.login} ${slug}`);
    const s = await call(sendEp, { who, body: { book: slug, base: BASE, files: [{ path: 'chapters/chapter-03.md', text: 'x' }] } });
    assert.equal(s.statusCode, 403);
    const a = await call(act, { who, body: { book: slug, action: 'publish-prepare' } });
    assert.equal(a.statusCode, 403);
  }
  assert.equal(gh.state.calls.length, before, 'no GitHub call was made for a refused author');
});

// --- paths ------------------------------------------------------------------------------

test('isAuthorPath: chapters/, assets/, and exactly index.md, glossary.md, chapter-sources.json', () => {
  const ok = ['chapters/chapter-01.md', 'chapters/Definitions/Critical realism.md', 'assets/chapter-01/image1.png',
    'index.md', 'glossary.md', 'chapter-sources.json'];
  const bad = ['README.md', '.github/workflows/x.yml', 'chapters/../README.md', '../index.md', '/index.md', 'chapters/',
    'chapters', 'chapters//x.md', 'chapters/./x.md', 'assets/..', 'chapters\\x.md', 'chapters/x.md\u0000', 'Chapters/x.md',
    'docs/index.md', 'chapters/ x.md', 'index.md/', 'textbook.config.json', 'x'.repeat(301), '', null, 42,
    'chapters/café.md'];
  for (const p of ok) assert.ok(isAuthorPath(p), p);
  for (const p of bad) assert.ok(!isAuthorPath(p), JSON.stringify(p));
});

test('a send naming any path outside them is refused whole, before GitHub is asked anything', async () => {
  resetBook();
  for (const path of ['README.md', '.github/workflows/build.yml', 'chapters/../README.md', 'textbook.config.json']) {
    const before = gh.state.calls.length;
    const r = await call(sendEp, { body: { book: BOOK.slug, base: BASE, files: [{ path: 'chapters/chapter-03.md', text: 'ok' }, { path, text: 'x' }] } });
    assert.equal(r.statusCode, 400, path);
    assert.equal(gh.state.calls.length, before);
    const d = await call(sendEp, { body: { book: BOOK.slug, base: BASE, deletes: [path] } });
    assert.equal(d.statusCode, 400, `delete ${path}`);
  }
  assert.equal(gh.repo(REPO).refs.get(DRAFTS), BASE);
  const f = await get('file', { book: BOOK.slug, path: 'README.md', ref: BASE });
  assert.equal(f.statusCode, 400);
});

// --- reading ------------------------------------------------------------------------------

test('tree lists drafts at its head, author paths only; file returns text, its sha and who last changed it', async () => {
  resetBook();
  const t = await get('tree', { book: BOOK.slug });
  assert.equal(t.statusCode, 200);
  assert.equal(t.payload.head, BASE);
  assert.deepEqual(t.payload.files.map((f) => f.path).sort(),
    ['assets/chapter-03/image1.png', 'chapters/chapter-03.md', 'glossary.md', 'index.md']);
  const f = await get('file', { book: BOOK.slug, path: 'chapters/chapter-03.md', ref: BASE });
  assert.equal(f.payload.text, CH3);
  assert.equal(f.payload.sha, blobId(Buffer.from(CH3)));
  assert.equal(f.payload.last.message, 'initial');
  const img = await get('file', { book: BOOK.slug, path: 'assets/chapter-03/image1.png', ref: BASE });
  assert.equal(img.payload.base64, Buffer.from([1, 2, 3]).toString('base64'));
});

test('every GitHub call is made with the App token, downscoped to the one repository', async () => {
  resetBook();
  gh.state.tokenRequests.length = 0;
  await get('tree', { book: BOOK.slug });
  const repoName = REPO.split('/')[1];
  assert.ok(gh.state.tokenRequests.every((t) => t.repositories.length === 1 && t.repositories[0] === repoName));
  assert.ok(gh.state.calls.filter((c) => c.url.includes(`/repos/${REPO}/git`)).every((c) => c.auth === `Bearer ghs_${repoName}`));
});

// --- sending ------------------------------------------------------------------------------

const NEW3 = CH3.replace('The the domains', 'The three domains');

test('send: one commit on drafts, parent = base, the author as author, the App as committer, the byline in the message', async () => {
  resetBook();
  const r = await call(sendEp, { body: { book: BOOK.slug, base: BASE, files: [
    { path: 'chapters/chapter-03.md', text: NEW3 },
    { path: 'glossary.md', text: '# Glossary\n' }, // unchanged: left out
  ] } });
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.deepEqual(r.payload.written, ['chapters/chapter-03.md']);
  const head = gh.repo(REPO).refs.get(DRAFTS);
  assert.equal(head, r.payload.sha);
  const c = gh.repo(REPO).commits.get(head);
  assert.deepEqual(c.parents, [BASE]);
  assert.equal(c.author.email, '777+brandonandcaroline@users.noreply.github.com');
  assert.equal(c.committer.name, 'textbook-suggest-edit[bot]');
  assert.match(c.message, /^Update chapters\/chapter-03\.md\n\nSent by @brandonandcaroline via the author site\.$/);
  assert.equal(gh.textAt(REPO, head, 'chapters/chapter-03.md'), NEW3);
  assert.equal(gh.repo(REPO).refs.get(LIVE), BASE, 'the live branch is never touched');
});

test('send: a delete, and nothing-to-send when drafts already has exactly this', async () => {
  resetBook();
  const same = await call(sendEp, { body: { book: BOOK.slug, base: BASE, files: [{ path: 'chapters/chapter-03.md', text: CH3 }] } });
  assert.equal(same.statusCode, 400);
  assert.match(same.payload.userMessage, /already has exactly this/);
  const del = await call(sendEp, { body: { book: BOOK.slug, base: BASE, deletes: ['assets/chapter-03/image1.png'] } });
  assert.equal(del.statusCode, 201);
  assert.equal(gh.textAt(REPO, del.payload.sha, 'assets/chapter-03/image1.png'), undefined);
});

test('conflict: drafts moved since base — 409 with what moved, and nothing written', async () => {
  resetBook();
  const moved = gh.commitFiles(REPO, DRAFTS, { 'chapters/chapter-03.md': CH3.replace('Second', 'Another') }, { message: 'a browser edit' });
  const commitsBefore = gh.repo(REPO).commits.size;
  const r = await call(sendEp, { body: { book: BOOK.slug, base: BASE, files: [{ path: 'chapters/chapter-03.md', text: NEW3 }] } });
  assert.equal(r.statusCode, 409);
  assert.equal(r.payload.error, 'conflict');
  assert.equal(r.payload.conflict.head, moved);
  assert.equal(r.payload.conflict.commits[0].message, 'a browser edit');
  assert.equal(r.payload.conflict.files[0].path, 'chapters/chapter-03.md');
  assert.match(r.payload.conflict.files[0].patch, /\+Another paragraph\./);
  assert.equal(gh.repo(REPO).refs.get(DRAFTS), moved);
  assert.equal(gh.repo(REPO).commits.size, commitsBefore, 'no commit was even created');
});

test('conflict: drafts moves between the check and the ref update — 409, drafts keeps the other change', async () => {
  resetBook();
  let raced;
  gh.state.hooks[`/repos/${REPO}/git/commits`] = ({ method }) => {
    if (method !== 'POST' || raced) return null;
    raced = gh.commitFiles(REPO, DRAFTS, { 'index.md': '# Changed meanwhile\n' }, { message: 'meanwhile' });
    return null;
  };
  try {
    const r = await call(sendEp, { body: { book: BOOK.slug, base: BASE, files: [{ path: 'chapters/chapter-03.md', text: NEW3 }] } });
    assert.equal(r.statusCode, 409);
    assert.equal(r.payload.conflict.head, raced);
    assert.equal(gh.repo(REPO).refs.get(DRAFTS), raced);
    assert.equal(gh.textAt(REPO, raced, 'chapters/chapter-03.md'), CH3);
  } finally {
    delete gh.state.hooks[`/repos/${REPO}/git/commits`];
  }
});

// --- Word import ---------------------------------------------------------------------------

const DOCX = Buffer.concat([Buffer.from('PK\x03\x04', 'binary'), Buffer.alloc(3 * 1024 * 1024, 7)]); // two parts
function partsOf(buf) {
  const size = 2.5 * 1024 * 1024;
  const out = [];
  for (let i = 0; i < buf.length; i += size) out.push(buf.subarray(i, i + size).toString('base64'));
  return out;
}
async function upload(buf, who = AUTHOR) {
  const receipts = [];
  for (const part of partsOf(buf)) {
    const r = await call(importEp, { who, body: { part } });
    assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
    receipts.push(r.payload.receipt);
  }
  return receipts;
}

test('import: parts are reassembled into source.docx on the import\'s own branch in the private requests repo', async () => {
  resetBook();
  const receipts = await upload(DOCX);
  assert.equal(receipts.length, 2);
  const r = await call(importEp, { body: { action: 'start', book: BOOK.slug, name: 'My Chapter.docx', parts: receipts } });
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.match(r.payload.id, /^[0-9a-f]{20}$/);
  assert.equal(r.payload.base, BASE);
  const branchHead = gh.repo(REQUESTS).refs.get(`author-imports/${r.payload.id}`);
  const files = gh.filesAt(REQUESTS, branchHead);
  assert.deepEqual([...files.keys()].sort(), ['README.md', 'import/request.json', 'import/source.docx']);
  assert.ok(gh.repo(REQUESTS).blobs.get(files.get('import/source.docx')).equals(DOCX));
  const request = JSON.parse(gh.textAt(REQUESTS, branchHead, 'import/request.json'));
  assert.equal(request.login, 'brandonandcaroline');
  assert.equal(request.book, BOOK.slug);
  assert.equal(request.base, BASE);
  assert.equal(request.attempt, 1);
  assert.equal(request.docx, 'My Chapter.docx');
  assert.equal(request.folder, 'chapters');
  assert.equal(request.name, null);
  // Made from the requests repo's main, so the push runs main's import-chapter workflow.
  assert.deepEqual(gh.repo(REQUESTS).commits.get(branchHead).parents, [gh.repo(REQUESTS).refs.get('main')]);
  assert.equal(gh.repo(REPO).refs.get(DRAFTS), BASE, 'nothing reaches the public book repo');
});

test('import: a forged, expired or another login\'s receipt is refused, so no private blob can be read', async () => {
  const [mine] = await upload(DOCX.subarray(0, 1000));
  const theirs = partReceipt(SECRET, 'a'.repeat(40), STRANGER);
  const forged = sign('z'.repeat(40), { k: 'part', sha: 'a'.repeat(40), u: 'brandonandcaroline', e: Date.now() + 1e6 });
  const expired = partReceipt(SECRET, 'a'.repeat(40), AUTHOR, Date.now() - 3 * 3600_000);
  for (const bad of [theirs, forged, expired, 'a'.repeat(40)]) {
    const r = await call(importEp, { body: { action: 'start', book: BOOK.slug, name: 'x.docx', parts: [mine, bad] } });
    assert.equal(r.statusCode, 400);
    assert.equal(r.payload.error, 'validation: receipt');
  }
});

test('import: a part from someone who is no book\'s author is refused; a non-docx is refused', async () => {
  const r = await call(importEp, { who: STRANGER, body: { part: Buffer.from('PK\x03\x04').toString('base64') } });
  assert.equal(r.statusCode, 403);
  const receipts = await upload(Buffer.from('not a zip at all'));
  const s = await call(importEp, { body: { action: 'start', book: BOOK.slug, name: 'x.docx', parts: receipts } });
  assert.equal(s.statusCode, 400);
  const n = await call(importEp, { body: { action: 'start', book: BOOK.slug, name: 'x.pdf', parts: receipts } });
  assert.equal(n.statusCode, 400);
});

/** What the import-chapter workflow does: import/result.json, import/chapter.md and import/out/ on the branch. */
function finishImport(id, result, staged) {
  const branch = `author-imports/${id}`;
  const request = JSON.parse(gh.textAt(REQUESTS, gh.repo(REQUESTS).refs.get(branch), 'import/request.json'));
  const files = { 'import/result.json': JSON.stringify({ version: 1, id, attempt: request.attempt, book: request.book, base: request.base, login: request.login, ...result }) };
  if (result.ok) files['import/chapter.md'] = staged[result.chapter.path] ?? CH3;
  for (const [path, content] of Object.entries(staged)) files[`import/out/${path}`] = content;
  gh.commitFiles(REQUESTS, branch, files, { message: 'converted' });
}

async function startedImport() {
  const receipts = await upload(DOCX.subarray(0, 5000));
  const r = await call(importEp, { body: { action: 'start', book: BOOK.slug, name: 'Chapter 4.docx', parts: receipts } });
  return r.payload.id;
}
const status = (id, extra = {}, who = AUTHOR) =>
  call(importEp, { method: 'GET', who, url: `/api/author-import?${new URLSearchParams({ book: BOOK.slug, id, ...extra })}` });

const CH4 = '# Chapter 4\n\n![](../assets/chapter-04/image1.png)\n';
const GOOD_RESULT = {
  ok: true,
  chapter: { path: 'chapters/chapter-04.md', title: 'Chapter 4', new: true, replaces: null },
  writes: [
    { path: 'chapters/chapter-04.md', staged: 'out/chapters/chapter-04.md', kind: 'chapter' },
    { path: 'assets/chapter-04/image1.png', staged: 'out/assets/chapter-04/image1.png', kind: 'picture' },
    { path: 'index.md', staged: 'out/index.md', kind: 'index' },
  ],
  deletes: ['assets/chapter-03/image1.png'],
  contents_line: '- **[[chapters/chapter-04|Chapter 4]]**',
  notes: [], report: [{ level: 'warn', text: 'One picture is a chart.' }],
};
const GOOD_STAGED = {
  'chapters/chapter-04.md': CH4,
  'assets/chapter-04/image1.png': Buffer.from([9, 9, 9]),
  'index.md': '# Book\n\n## Contents\n\n- **[[chapters/chapter-03|Chapter 3]]**\n- **[[chapters/chapter-04|Chapter 4]]**\n',
};

test('import: working until the workflow answers this attempt, then the result and the chapter text', async () => {
  resetBook();
  const id = await startedImport();
  assert.equal((await status(id)).payload.state, 'working');
  finishImport(id, GOOD_RESULT, GOOD_STAGED);
  const done = await status(id);
  assert.equal(done.payload.state, 'done');
  assert.equal(done.payload.chapter.text, CH4);
  assert.equal(done.payload.result.contents_line, GOOD_RESULT.contents_line);
  const pic = await status(id, { file: 'assets/chapter-04/image1.png' });
  assert.equal(pic.payload.base64, Buffer.from([9, 9, 9]).toString('base64'));
  assert.equal((await status(id, { file: '../request.json' })).statusCode, 404);
  // Someone else asking about it, even an author of the same book.
  const other = await status(id, {}, { login: 'textbookproject2026-alt', id: 5, name: 'Alec' });
  assert.equal(other.statusCode, 403);
});

test('import: sent with the one send path — staged files copied from the private repo, deletions made, one commit', async () => {
  resetBook();
  const id = await startedImport();
  finishImport(id, GOOD_RESULT, GOOD_STAGED);
  const r = await call(sendEp, { body: { book: BOOK.slug, base: BASE, import: id } });
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  const head = gh.repo(REPO).refs.get(DRAFTS);
  assert.equal(gh.textAt(REPO, head, 'chapters/chapter-04.md'), CH4);
  assert.match(gh.textAt(REPO, head, 'index.md'), /chapter-04\|Chapter 4/);
  assert.equal(gh.textAt(REPO, head, 'assets/chapter-03/image1.png'), undefined);
  assert.match(gh.repo(REPO).commits.get(head).message, /^Import chapters\/chapter-04\.md \(new chapter\)\n\nSent by @brandonandcaroline/);
});

test('import: the chapter as the author fixed it (lint) is sent in place of the converted copy; the rest of the import still goes', async () => {
  resetBook();
  const id = await startedImport();
  finishImport(id, GOOD_RESULT, GOOD_STAGED);
  const fixed = `${CH4}\n## Fixed by the author\n`;
  const r = await call(sendEp, { body: { book: BOOK.slug, base: BASE, import: id, files: [{ path: 'chapters/chapter-04.md', text: fixed }] } });
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  const head = gh.repo(REPO).refs.get(DRAFTS);
  assert.equal(gh.textAt(REPO, head, 'chapters/chapter-04.md'), fixed);
  assert.match(gh.textAt(REPO, head, 'index.md'), /chapter-04\|Chapter 4/);
});

test('import: a result that writes outside the author paths is refused whole', async () => {
  resetBook();
  const id = await startedImport();
  finishImport(id, { ...GOOD_RESULT, writes: [...GOOD_RESULT.writes, { path: '.github/workflows/x.yml', staged: 'out/.github/workflows/x.yml', kind: 'chapter' }] },
    { ...GOOD_STAGED, '.github/workflows/x.yml': 'on: push' });
  const r = await call(sendEp, { body: { book: BOOK.slug, base: BASE, import: id } });
  assert.equal(r.statusCode, 502);
  assert.equal(gh.repo(REPO).refs.get(DRAFTS), BASE);
});

test('import: drafts moved — the send is a conflict; "again" converts against the new head as attempt 2', async () => {
  resetBook();
  const id = await startedImport();
  finishImport(id, GOOD_RESULT, GOOD_STAGED);
  const moved = gh.commitFiles(REPO, DRAFTS, { 'glossary.md': '# Glossary\n\nX.\n' });
  const r = await call(sendEp, { body: { book: BOOK.slug, base: BASE, import: id } });
  assert.equal(r.statusCode, 409);
  const again = await call(importEp, { body: { action: 'again', book: BOOK.slug, id } });
  assert.equal(again.statusCode, 201);
  assert.equal(again.payload.attempt, 2);
  assert.equal(again.payload.base, moved);
  assert.equal((await status(id)).payload.state, 'working', 'the old attempt\'s result no longer counts');
});

test('import: replacing a chapter already in drafts needs its own tick (replace: true)', async () => {
  resetBook();
  const id = await startedImport();
  const replacing = {
    ...GOOD_RESULT,
    chapter: { path: 'chapters/chapter-03.md', title: 'Chapter 3', new: false, how: 'recorded',
      replaces: { who: 'someone', lines_differ: { removed: 1, added: 1 } } },
    writes: [{ path: 'chapters/chapter-03.md', staged: 'out/chapters/chapter-03.md', kind: 'chapter' }],
    deletes: [], contents_line: null,
  };
  finishImport(id, replacing, { 'chapters/chapter-03.md': NEW3 });
  const done = await status(id);
  assert.equal(done.payload.chapter.text, NEW3, 'the preview is the converted chapter');
  const unticked = await call(sendEp, { body: { book: BOOK.slug, base: BASE, import: id } });
  assert.equal(unticked.statusCode, 409);
  assert.equal(unticked.payload.error, 'replace not confirmed');
  assert.equal(gh.repo(REPO).refs.get(DRAFTS), BASE);
  const ticked = await call(sendEp, { body: { book: BOOK.slug, base: BASE, import: id, replace: true } });
  assert.equal(ticked.statusCode, 201, JSON.stringify(ticked.payload));
  assert.equal(gh.textAt(REPO, ticked.payload.sha, 'chapters/chapter-03.md'), NEW3);
});

test('import: a folder inside chapters/ with a chosen name, as the app allowed; anything else refused', async () => {
  resetBook();
  const receipts = await upload(DOCX.subarray(0, 3000));
  const ok = await call(importEp, { body: { action: 'start', book: BOOK.slug, name: 'Concept.docx', parts: receipts,
    folder: 'chapters/Definitions', chapterName: 'Critical realism' } });
  assert.equal(ok.statusCode, 201, JSON.stringify(ok.payload));
  const request = JSON.parse(gh.textAt(REQUESTS, gh.repo(REQUESTS).refs.get(`author-imports/${ok.payload.id}`), 'import/request.json'));
  assert.deepEqual([request.folder, request.name], ['chapters/Definitions', 'Critical realism.md']);
  for (const [folder, chapterName] of [['assets', 'x'], ['chapters/../README', 'x'], ['.github', 'x'], ['chapters/Definitions', 'a/b']]) {
    const r = await call(importEp, { body: { action: 'start', book: BOOK.slug, name: 'Concept.docx', parts: receipts, folder, chapterName } });
    assert.equal(r.statusCode, 400, `${folder} ${chapterName}`);
  }
});

test('import: a failed conversion is reported in the author\'s words', async () => {
  resetBook();
  const id = await startedImport();
  finishImport(id, { ok: false, error: 'That file could not be read as a Word document.' }, {});
  const s = await status(id);
  assert.deepEqual([s.payload.state, s.payload.error], ['failed', 'That file could not be read as a Word document.']);
});

// --- suggestions -------------------------------------------------------------------------

function suggestionIssue(text, extraLabels = []) {
  return gh.addIssue(REPO, {
    title: 'Suggested edit: chapters/chapter-03.md',
    body: `**File:** [\`chapters/chapter-03.md\`](x)\n\n### Suggested edit\n\n\`\`\`text\n${text}\n\`\`\`\n\n### Reasoning\n\n\`\`\`text\nTypo.\n\`\`\`\n\n**Submitted by:** \`Ada\` (\`a***@example.com\`)`,
    labels: [{ name: 'suggested-edit' }, { name: 'needs-triage' }, ...extraLabels.map((name) => ({ name }))],
  });
}

test('suggestions are listed, parsed as the app parsed them', async () => {
  resetBook();
  const n = suggestionIssue('"The the domains" should be "The three domains"');
  gh.addIssue(REPO, { title: 'Some other issue', labels: [] });
  const r = await get('suggestions', { book: BOOK.slug });
  assert.equal(r.payload.suggestions.length, 1);
  assert.deepEqual(
    (({ number, who, path, page, suggestion, reasoning, accepted }) => ({ number, who, path, page, suggestion, reasoning, accepted }))(r.payload.suggestions[0]),
    { number: n, who: 'Ada', path: 'chapters/chapter-03.md', page: 'chapter-03', suggestion: '"The the domains" should be "The three domains"', reasoning: 'Typo.', accepted: false });
});

test('accepting with the change made: the send commits, then thanks the reader with the link and closes', async () => {
  resetBook();
  const n = suggestionIssue('fix');
  const r = await call(sendEp, { body: { book: BOOK.slug, base: BASE, suggestion: n, files: [{ path: 'chapters/chapter-03.md', text: NEW3 }] } });
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  const issue = gh.repo(REPO).issues.get(n);
  assert.equal(issue.state, 'closed');
  assert.match(issue.comments[0], new RegExp(r.payload.url));
  assert.match(issue.comments[0], /_Replied by @brandonandcaroline via the author site\._$/);
  assert.match(gh.repo(REPO).commits.get(r.payload.sha).message, new RegExp(`^Accept suggestion #${n} on chapter-03`));
});

test('accept by hand, then "I\'ve made the change" with the newest commit on the page; decline', async () => {
  resetBook();
  const n = suggestionIssue('please reword this');
  const a = await call(act, { body: { book: BOOK.slug, action: 'suggestion-accept', number: n } });
  assert.equal(a.statusCode, 200, JSON.stringify(a.payload));
  const issue = gh.repo(REPO).issues.get(n);
  assert.equal(issue.state, 'open');
  assert.deepEqual(issue.labels.map((l) => l.name).sort(), ['accepted', 'suggested-edit']);
  assert.match(issue.comments[0], /hasn't been changed yet[\s\S]*by @brandonandcaroline via the author site/);
  assert.equal((await call(act, { body: { book: BOOK.slug, action: 'suggestion-accept', number: n } })).statusCode, 409);

  const none = await call(act, { body: { book: BOOK.slug, action: 'suggestion-made', number: n, sha: 'a'.repeat(40) } });
  assert.equal(none.statusCode, 409);
  const sent = await call(sendEp, { body: { book: BOOK.slug, base: BASE, files: [{ path: 'chapters/chapter-03.md', text: NEW3 }] } });
  const listed = await get('suggestion-changes', { book: BOOK.slug, number: String(n) });
  assert.equal(listed.payload.changes[0].sha, sent.payload.sha);
  const wrong = await call(act, { body: { book: BOOK.slug, action: 'suggestion-made', number: n, sha: BASE } });
  assert.equal(wrong.statusCode, 409);
  const made = await call(act, { body: { book: BOOK.slug, action: 'suggestion-made', number: n, sha: sent.payload.sha } });
  assert.equal(made.statusCode, 200);
  assert.equal(issue.state, 'closed');
  assert.match(issue.comments[1], new RegExp(sent.payload.sha));

  const d = suggestionIssue('no');
  // No reason, or a too-short one: refused, and nothing is written.
  for (const reason of [undefined, '', '   short  ', 'x'.repeat(1001)]) {
    const r = await call(act, { body: { book: BOOK.slug, action: 'suggestion-decline', number: d, reason } });
    assert.equal(r.statusCode, 400, String(reason));
    assert.match(r.payload.userMessage, /Why is this being declined\?/);
  }
  assert.equal(gh.repo(REPO).issues.get(d).comments.length, 0);
  assert.equal(gh.repo(REPO).issues.get(d).state, 'open');
  const ok = await call(act, { body: { book: BOOK.slug, action: 'suggestion-decline', number: d, reason: 'The chapter already says this in ¶4, @someone.' } });
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.payload));
  const declined = gh.repo(REPO).issues.get(d);
  assert.equal(declined.state, 'closed');
  assert.equal(declined.state_reason, 'not_planned');
  assert.equal(declined.locked, true);
  assert.match(declined.comments[0], /^<!-- tb-declined \{"member":"brandonandcaroline","name":"Brandon","reason":"The chapter already says this in ¶4, @someone\."\} -->\n\*\*Declined by Brandon\*\*/);
  assert.match(declined.comments[0], /> The chapter already says this in ¶4, @\u200bsomeone\./, 'no mention ping');
  assert.match(declined.comments[1], /stay as it is[\s\S]*by @brandonandcaroline via the author site/, 'the thank-you stays');
});

test('an issue that isn\'t a suggestion can\'t be answered or closed from here', async () => {
  resetBook();
  const n = gh.addIssue(REPO, { title: 'Build broke', labels: [{ name: 'bug' }] });
  for (const action of ['suggestion-accept', 'suggestion-decline']) {
    assert.equal((await call(act, { body: { book: BOOK.slug, action, number: n, reason: 'A good enough reason.' } })).statusCode, 404);
  }
  assert.equal(gh.repo(REPO).issues.get(n).state, 'open');
  assert.equal(gh.repo(REPO).issues.get(n).comments.length, 0);
});

// --- draft changes and going live -------------------------------------------------------------

function draftChange() {
  gh.repo(REPO).refs.set('proposed-edits/x', BASE);
  gh.commitFiles(REPO, 'proposed-edits/x', { 'chapters/chapter-03.md': NEW3 }, { message: 'Fix typo', author: { name: 'Reader', email: '5+reader@users.noreply.github.com' } });
  return gh.addPull(REPO, { head: 'proposed-edits/x', base: DRAFTS, title: 'Fix typo', commits: [
    { commit: { author: { name: 'Reader', email: '5+reader@users.noreply.github.com' } }, author: { login: 'reader', type: 'User' } },
    { commit: { author: { name: 'textbook-suggest-edit[bot]', email: 'x@bot' } }, author: { login: 'textbook-suggest-edit[bot]', type: 'Bot' } },
  ] });
}

test('accepting a draft change: squash-merged with the byline and the proposer\'s credit, then put in line', async () => {
  resetBook();
  const n = draftChange();
  const list = await get('changes', { book: BOOK.slug });
  assert.equal(list.payload.changes[0].number, n);
  const detail = await get('change', { book: BOOK.slug, number: String(n) });
  assert.equal(detail.payload.readable, true);
  assert.deepEqual(detail.payload.pages[0].lines.find((l) => l.kind === 'after'), { kind: 'after', text: 'The three domains of reality.' });

  const r = await call(act, { body: { book: BOOK.slug, action: 'change-accept', number: n } });
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  const pr = gh.repo(REPO).pulls.get(n);
  assert.equal(pr.mergeBody.merge_method, 'squash');
  assert.match(pr.mergeBody.commit_message, /Accepted by @brandonandcaroline via the author site\./);
  assert.match(pr.mergeBody.commit_message, /Co-authored-by: Reader <5\+reader@users\.noreply\.github\.com>/);
  assert.doesNotMatch(pr.mergeBody.commit_message, /\[bot\]/);
  assert.equal(r.payload.publish.opened, true);
  const publishPr = gh.repo(REPO).pulls.get(r.payload.publish.number);
  assert.equal(publishPr.base.ref, LIVE);
  assert.match(publishPr.body, /Put in line by @brandonandcaroline via the author site/);
});

test('a pull request that isn\'t into drafts can\'t be accepted or declined from here', async () => {
  resetBook();
  gh.repo(REPO).refs.set('sneaky', BASE);
  gh.commitFiles(REPO, 'sneaky', { 'README.md': 'x' });
  const n = gh.addPull(REPO, { head: 'sneaky', base: LIVE, title: 'into live' });
  for (const action of ['change-accept', 'change-decline']) {
    assert.equal((await call(act, { body: { book: BOOK.slug, action, number: n, reason: 'A good enough reason.' } })).statusCode, 409);
  }
  assert.equal(gh.repo(REPO).pulls.get(n).state, 'open');
});

test('declining a draft change needs a reason; then the reason, a note naming the author, closed and locked', async () => {
  resetBook();
  const n = draftChange();
  assert.equal((await call(act, { body: { book: BOOK.slug, action: 'change-decline', number: n } })).statusCode, 400);
  assert.equal(gh.repo(REPO).pulls.get(n).state, 'open');
  await call(act, { body: { book: BOOK.slug, action: 'change-decline', number: n, reason: 'We keep the original wording.' } });
  const pr = gh.repo(REPO).pulls.get(n);
  assert.equal(pr.state, 'closed');
  assert.equal(pr.locked, true);
  assert.match(pr.comments[0], /^<!-- tb-declined .*"reason":"We keep the original wording\."/);
  assert.match(pr.comments[1], /^Declined by @brandonandcaroline via the author site/);
});

// --- comments on declined items (batch 2c) ---------------------------------------------------

const MEMBER_ID = 'M'.repeat(43);
/** A member through the author site: its assertion read-back answered here, GitHub by the fake. */
async function asMember(handler, body, member = { id: '0a1b2c3d4e', name: 'Mo Member' }) {
  const { AUTHOR_SITE_ORIGIN } = await import('../lib/member.mjs');
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => String(url) === `${AUTHOR_SITE_ORIGIN}/api/internal/assertion`
    ? { ok: true, status: 200, json: async () => ({ member: { ...member, github: null }, book: BOOK.slug, books: [BOOK.slug] }) }
    : real(url, opts);
  try {
    const res = mockRes();
    await handler({ method: 'POST', headers: { origin: AUTHOR_SITE_ORIGIN, authorization: `Member ${MEMBER_ID}`, 'content-type': 'application/json', 'x-forwarded-for': '10.1.1.2' }, url: '/api/author-act', body, socket: {} }, res);
    return res;
  } finally {
    globalThis.fetch = real;
  }
}

test('members comment on a declined item; only the writer deletes it; never on an open one', async () => {
  resetBook();
  const open = suggestionIssue('still open');
  assert.equal((await asMember(act, { book: BOOK.slug, action: 'comment-add', number: open, text: 'A comment' })).statusCode, 404);
  const n = suggestionIssue('declined one');
  await call(act, { body: { book: BOOK.slug, action: 'suggestion-decline', number: n, reason: 'Not for this edition.' } });
  // GitHub sign-in (not a member): refused.
  assert.equal((await call(act, { body: { book: BOOK.slug, action: 'comment-add', number: n, text: 'hello there' } })).statusCode, 403);
  assert.equal((await asMember(act, { book: BOOK.slug, action: 'comment-add', number: n, text: '' })).statusCode, 400);
  const added = await asMember(act, { book: BOOK.slug, action: 'comment-add', number: n, text: 'We may revisit this in 2027.' });
  assert.equal(added.statusCode, 200, JSON.stringify(added.payload));
  const issue = gh.repo(REPO).issues.get(n);
  assert.match(issue.comments.at(-1), /^<!-- tb-comment \{"member":"m-0a1b2c3d4e","name":"Mo Member","text":"We may revisit this in 2027\."\} -->/);
  // Someone else's comment, or the decline itself: not theirs to delete.
  const other = await asMember(act, { book: BOOK.slug, action: 'comment-delete', number: n, id: added.payload.id }, { id: '9f9f9f9f9f', name: 'Other' });
  assert.equal(other.statusCode, 403);
  const declineId = issue.commentMeta[0].id;
  assert.equal((await asMember(act, { book: BOOK.slug, action: 'comment-delete', number: n, id: declineId })).statusCode, 403);
  assert.equal(issue.locked, true, 'locked again after commenting');
  const before = issue.comments.length;
  const del = await asMember(act, { book: BOOK.slug, action: 'comment-delete', number: n, id: added.payload.id });
  assert.equal(del.statusCode, 200, JSON.stringify(del.payload));
  assert.equal(issue.comments.length, before - 1);
  assert.ok(!issue.comments.some((c) => c.includes('revisit')));
  assert.equal(issue.locked, true);
});

test('publishing: the tick box, the one request shown, a clean merge — then a merge commit naming the author', async () => {
  resetBook();
  gh.commitFiles(REPO, DRAFTS, { 'chapters/chapter-03.md': NEW3 });
  const prep = await call(act, { body: { book: BOOK.slug, action: 'publish-prepare' } });
  const n = prep.payload.publish.number;
  const state = await get('publish', { book: BOOK.slug });
  assert.equal(state.payload.publish?.can_publish, true, JSON.stringify([prep.payload, state.payload]));

  assert.equal((await call(act, { body: { book: BOOK.slug, action: 'publish', number: n } })).statusCode, 400, 'no tick');
  assert.equal((await call(act, { body: { book: BOOK.slug, action: 'publish', number: n + 1, confirm: true } })).statusCode, 409, 'another request');
  gh.repo(REPO).pulls.get(n).mergeable = false;
  const conflicted = await call(act, { body: { book: BOOK.slug, action: 'publish', number: n, confirm: true } });
  assert.equal(conflicted.statusCode, 409);
  assert.equal(conflicted.payload.state, 'conflict');
  assert.equal(gh.repo(REPO).refs.get(LIVE), BASE);

  gh.repo(REPO).pulls.get(n).mergeable = true;
  const r = await call(act, { body: { book: BOOK.slug, action: 'publish', number: n, confirm: true } });
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  const pr = gh.repo(REPO).pulls.get(n);
  assert.equal(pr.mergeBody.merge_method, 'merge');
  assert.equal(pr.mergeBody.commit_message, 'Published by @brandonandcaroline via the author site.');
  assert.match(pr.body, /\*\*Published by @brandonandcaroline via the author site\.\*\*/);
  assert.equal(gh.textAt(REPO, gh.repo(REPO).refs.get(LIVE), 'chapters/chapter-03.md'), NEW3);
});

test('publishing stops on the book\'s own lint, with the problems listed; its config is the book\'s; dead links are only a notice', async () => {
  resetBook();
  gh.commitFiles(REPO, DRAFTS, { 'chapters/chapter-03.md': `${NEW3}\n**Bold as a heading**\n\nText.\n` });
  const prep = await call(act, { body: { book: BOOK.slug, action: 'publish-prepare' } });
  const n = prep.payload.publish.number;
  const pr = gh.repo(REPO).pulls.get(n);
  pr.head.sha = gh.repo(REPO).refs.get(DRAFTS);
  pr.comments.push(`<!-- link-check sha=${pr.head.sha} -->\nLinks that didn't work:\n- https://gone.example/x in chapters/chapter-03.md (404 Not Found)`);
  const state = (await get('publish', { book: BOOK.slug })).payload.publish;
  assert.equal(state.state, 'lint');
  assert.equal(state.can_publish, false);
  assert.deepEqual(state.lint.map((p) => [p.path, p.rule]), [['chapters/chapter-03.md', 'MD036']]);
  assert.deepEqual(state.links, { checked: true, dead: [{ url: 'https://gone.example/x', file: 'chapters/chapter-03.md', status: '404 Not Found' }] });

  const refused = await call(act, { body: { book: BOOK.slug, action: 'publish', number: n, confirm: true } });
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.payload.state, 'lint');
  assert.match(refused.payload.userMessage, /1 formatting problem in 1 page.*chapters\/chapter-03\.md line \d+ \(emphasis used instead of a heading\)/);
  assert.equal(gh.repo(REPO).refs.get(LIVE), BASE, 'nothing went live');

  // The book's own config decides: with MD036 off, it publishes, dead link and all.
  gh.commitFiles(REPO, DRAFTS, { '.markdownlint-cli2.yaml': 'config:\n  default: true\n  MD036: false\nignores:\n  - "templates/**"\n' });
  pr.head.sha = gh.repo(REPO).refs.get(DRAFTS);
  const after = (await get('publish', { book: BOOK.slug })).payload.publish;
  assert.equal(after.state, 'clean');
  assert.equal(after.links.checked, false, 'the link check spoke of an earlier commit');
  assert.equal((await call(act, { body: { book: BOOK.slug, action: 'publish', number: n, confirm: true } })).statusCode, 200);
});

test('lint ignores: the config\'s globs and node_modules are skipped', async () => {
  const { lintTexts, parseConfig } = await import('../lib/book-lint.mjs');
  const bad = '# A\n\n**B**\n';
  const found = await lintTexts({ 'templates/x.md': bad, 'node_modules/y.md': bad, 'scripts/seed-index.md': bad, 'chapters/z.md': bad },
    parseConfig('config:\n  default: true\nignores:\n  - "templates/**"\n  - "scripts/seed-index.md"\n'));
  assert.deepEqual(found.map((p) => p.path), ['chapters/z.md']);
  assert.deepEqual(parseConfig('').config, { default: true });
});

// --- the credential ---------------------------------------------------------------------------

test('with no App configured (BOT_TOKEN only), the author endpoints refuse rather than act as another account', async () => {
  const saved = { ...process.env };
  for (const k of Object.keys(APP_ENV)) delete process.env[k];
  process.env.BOT_TOKEN = 'ghp_someone';
  let fresh;
  try {
    fresh = (await import(`../author/author-read.js?bot=${Date.now()}`)).default;
  } finally {
    Object.assign(process.env, saved);
    delete process.env.BOT_TOKEN;
  }
  const r = await call(fresh, { method: 'GET', url: `/api/author-read?what=tree&book=${BOOK.slug}` });
  assert.equal(r.statusCode, 502);
  assert.ok(!gh.state.calls.some((c) => c.auth === 'Bearer ghp_someone'));
});

// --- sign-in and the registry -----------------------------------------------------------------

test('github-auth starts a sign-in for the author site (a platform page with github-auth), not for the portal', async () => {
  const start = async (origin) => {
    const res = mockRes();
    await auth({ method: 'GET', url: `/api/github-auth?origin=${encodeURIComponent(origin)}`, headers: { host: 'fn.example' } }, res);
    return res;
  };
  const ok = await start(ORIGIN);
  assert.equal(ok.statusCode, 302);
  assert.equal((await start(PREVIEW_ORIGIN)).statusCode, 302);
  assert.equal((await start(`https://${BUNDLE.registry.platform.portal.domain}`)).statusCode, 403);
  assert.equal((await start('https://author.evil.example')).statusCode, 403);
});

test('the page resolver reads platform.pages; a page on a book\'s domain is refused at load', () => {
  const reg = structuredClone(BUNDLE.registry);
  const r = createPageResolver(reg, 'author-api');
  assert.ok(r.resolve(ORIGIN).ok);
  assert.ok(!r.resolve(`https://${BUNDLE.registry.platform.portal.domain}`).ok);
  assert.ok(!createPageResolver(reg, 'github-auth').resolve(`https://${BUNDLE.registry.platform.portal.domain}`).ok);
  reg.platform.pages.push({ name: 'x', domain: BOOK.site.domain, host: { kind: 'static', provider: 'cloudflare-pages', project: 'x' }, services: ['author-api'] });
  assert.throws(() => validateRegistry(reg), /platform page x has site\.domain/);
});

test('request-book never proposes a platform page\'s label as a slug', () => {
  assert.equal(proposeSlug('Author'), 'book-author');
});

// --- the author site's Chapters and Drafts (08 Oct) ---------------------------------------

test('import: .odt, .doc and .rtf are taken when their bytes match; a mismatch is refused', async () => {
  const { safeWordName, looksLike } = await import('../lib/author-import.mjs');
  const kinds = { 'Ch.docx': 'PK\x03\x04', 'Ch.odt': 'PK\x03\x04', 'Ch.doc': '\xD0\xCF\x11\xE0', 'Ch.rtf': '{\\rtf1 hi}' };
  for (const [name, bytes] of Object.entries(kinds)) {
    assert.equal(safeWordName(name), name);
    assert.equal(looksLike(name, Buffer.from(bytes, 'binary')), true, name);
  }
  assert.equal(looksLike('Ch.rtf', Buffer.from('PK\x03\x04', 'binary')), false);
  assert.equal(looksLike('Ch.doc', Buffer.from('PK\x03\x04', 'binary')), false);
  for (const name of ['Ch.pdf', 'Ch.pages', '.rtf', 'Ch']) assert.equal(safeWordName(name), '', name);
});

test('drafts: what drafts hold beyond live, readers\' files only, each with who changed it last', async () => {
  resetBook();
  gh.commitFiles(REPO, DRAFTS, { 'chapters/chapter-03.md': NEW3, 'chapter-sources.json': '{}\n' });
  const r = await get('drafts', { book: BOOK.slug });
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  assert.deepEqual(r.payload.files.map((f) => [f.path, f.status]), [['chapters/chapter-03.md', 'modified']]);
  assert.ok(r.payload.files[0].when);
  assert.equal(r.payload.drafts, gh.repo(REPO).refs.get(DRAFTS));
  assert.equal(r.payload.live, gh.repo(REPO).refs.get(LIVE));
});

test('publish: with no request open yet, the drafts\' own lint comes back', async () => {
  resetBook();
  gh.commitFiles(REPO, DRAFTS, { 'chapters/chapter-03.md': NEW3 });
  const p = (await get('publish', { book: BOOK.slug })).payload.publish;
  assert.equal(p.state, 'not_open');
  assert.ok(Array.isArray(p.lint), JSON.stringify(p));
});
