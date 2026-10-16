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

// book-requests' author-lint workflow, answering each dispatch at once with LINT (what
// the real one does in about a minute): the first read says 'checking', the next 'done'.
let LINT = [];
gh.state.hooks['/book-requests/dispatches'] = ({ body }) => {
  const { book, sha } = body.client_payload;
  gh.commitFiles(REQUESTS, `author-lint/${book}/${sha}`, { 'lint/result.json': JSON.stringify({ version: 1, book, sha, ok: true, problems: LINT, files: 3 }) });
};
const MD036 = [{ path: 'chapters/chapter-03.md', line: 9, rule: 'MD036', description: 'Emphasis used instead of a heading', detail: 'Bold as a heading', fixable: false }];

function resetBook() {
  LINT = [];
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
    // A body written by send() as JSON already (RawJson) reads back as the payload.
    end(b) { if (b) this.body = b; if (b && /json/.test(this.headers['content-type'] ?? '')) this.payload = JSON.parse(b); this.ended = true; return this; },
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

test('send: text goes inline in the tree; a one-file send is four GitHub calls', async () => {
  resetBook();
  const before = gh.state.calls.length;
  const r = await call(sendEp, { body: { book: BOOK.slug, base: BASE, files: [{ path: 'chapters/chapter-03.md', text: NEW3 }] } });
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  const calls = gh.state.calls.slice(before).filter((c) => c.url.startsWith('https://api.github.com/') && !c.url.includes('/access_tokens') && !c.url.endsWith('/installation'))
    .map((c) => `${c.method} ${new URL(c.url).pathname.replace(/^\/repos\/[^/]+\/[^/]+/, '')}`);
  assert.deepEqual(calls, ['POST /graphql', 'POST /git/trees', 'POST /git/commits', `PATCH /git/refs/heads/${DRAFTS}`]);
  const tree = gh.state.calls.find((c, i) => i >= before && c.url.endsWith('/git/trees'));
  assert.equal(tree.body.tree[0].content, NEW3);
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

test('import: the parts go on the import\'s own branch in the private requests repo as they came, for the workflow to join', async () => {
  resetBook();
  const receipts = await upload(DOCX);
  assert.equal(receipts.length, 2);
  const r = await call(importEp, { body: { action: 'start', book: BOOK.slug, name: 'My Chapter.docx', parts: receipts } });
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.match(r.payload.id, /^[0-9a-f]{20}$/);
  assert.equal(r.payload.base, BASE);
  const branchHead = gh.repo(REQUESTS).refs.get(`author-imports/${r.payload.id}`);
  const files = gh.filesAt(REQUESTS, branchHead);
  assert.deepEqual([...files.keys()].sort(), ['README.md', 'import/request.json', 'import/source.parts/000', 'import/source.parts/001']);
  const blobs = gh.repo(REQUESTS).blobs;
  assert.ok(Buffer.concat([blobs.get(files.get('import/source.parts/000')), blobs.get(files.get('import/source.parts/001'))]).equals(DOCX));
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
  const n = gh.addPull(REPO, { head: 'proposed-edits/x', base: DRAFTS, title: 'Fix typo', commits: [
    { commit: { author: { name: 'Reader', email: '5+reader@users.noreply.github.com' } }, author: { login: 'reader', type: 'User' } },
    { commit: { author: { name: 'textbook-suggest-edit[bot]', email: 'x@bot' } }, author: { login: 'textbook-suggest-edit[bot]', type: 'Bot' } },
  ] });
  gh.repo(REPO).pulls.get(n).body = '**Proposed by:** `Reader` (`r***@example.org`)';
  return n;
}

test('accepting a draft change: squash-merged with the byline and the proposer\'s credit, then put in line', async () => {
  resetBook();
  const n = draftChange();
  const list = await get('changes', { book: BOOK.slug });
  assert.equal(list.payload.changes[0].number, n);
  // The reader the body names, never the App that opened it.
  assert.equal(list.payload.changes[0].who, 'Reader');
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

// Suggestions are separate pull requests against the drafts as they were; git merges by
// line and a paragraph is one line, so after one is accepted the rest used to fail.
const CH3_PATH = 'chapters/chapter-03.md';
const P1 = 'The cat sat on mat and looked at dog.';
const P2 = 'Second paragraph stays as it is.';
function proposal(branch, from, text, { title = branch, user = 'textbook-suggest-edit[bot]' } = {}) {
  gh.repo(REPO).refs.set(`proposed-edits/${branch}`, from);
  gh.commitFiles(REPO, `proposed-edits/${branch}`, { [CH3_PATH]: text }, { author: { name: 'Reader', email: '5+reader@users.noreply.github.com' } });
  const n = gh.addPull(REPO, { head: `proposed-edits/${branch}`, base: DRAFTS, title, user });
  gh.repo(REPO).pulls.get(n).body = `### Summary\n\n\`\`\`text\n${title}\n\`\`\`\n\n**File:** [\`${CH3_PATH}\`](https://example.invalid)`;
  return n;
}
const para3 = (p1, p2 = P2) => `# Chapter 3\n\n${p1}\n\n${p2}\n`;

test('suggestions on one paragraph: word-level fixes all land, an overlapping rewrite offers the choice', async () => {
  resetBook();
  gh.commitFiles(REPO, DRAFTS, { [CH3_PATH]: para3(P1) });
  const from = gh.repo(REPO).refs.get(DRAFTS);
  const a = proposal('a', from, para3('The cat sat on the mat and looked at dog.'), { title: 'missing word' });
  const b = proposal('b', from, para3('The cat sat on mat and looked at the dog.'), { title: 'another missing word' });
  const c = proposal('c', from, para3('A dog sat on the rug.'), { title: 'rewrite' });
  const d = proposal('d', from, para3(P1, 'Second paragraph stays as it was.'), { title: 'other paragraph' });

  gh.state.dispatches.length = 0;
  const ra = await call(act, { body: { book: BOOK.slug, action: 'change-accept', number: a } });
  assert.equal(ra.statusCode, 200, JSON.stringify(ra.payload));
  assert.ok(ra.payload.steps.some((x) => /being brought up to date/.test(x)), ra.payload.steps.join(' | '));
  // proposals.yml, which the accept started for this page: b and d now merge cleanly; c is marked before anyone clicks.
  assert.deepEqual(gh.state.dispatches.filter((x) => x.event_type === 'c4n-proposals').map((x) => x.client_payload), [{ book: BOOK.slug, path: CH3_PATH }]);
  const { refreshProposals } = await import('../lib/reapply.mjs');
  const { budget } = await import('../lib/author.mjs');
  const r = await refreshProposals(BOOK, 'ghs_test', budget(20_000), { paths: new Set([CH3_PATH]), wait: async () => {} });
  assert.deepEqual([r.refreshed.sort(), r.overlap], [[b, d].sort(), [c]]);
  const listed = (await get('changes', { book: BOOK.slug })).payload.changes;
  assert.deepEqual(listed.map((x) => [x.number, x.needsLook]).sort(), [[b, false], [c, true], [d, false]].sort());

  const rb = await call(act, { body: { book: BOOK.slug, action: 'change-accept', number: b } });
  assert.equal(rb.statusCode, 200, JSON.stringify(rb.payload));
  assert.equal(gh.textAt(REPO, gh.repo(REPO).refs.get(DRAFTS), CH3_PATH), para3('The cat sat on the mat and looked at the dog.'));

  // The rewrite overlaps: a 409 with the paragraph as it is now and as suggested, nothing written.
  const before = gh.repo(REPO).refs.get(DRAFTS);
  const rc = await call(act, { body: { book: BOOK.slug, action: 'change-accept', number: c } });
  assert.equal(rc.statusCode, 409);
  assert.equal(rc.payload.userMessage, 'This suggestion was made on an older version of this paragraph.');
  assert.deepEqual(rc.payload.overlap.paragraphs.map(({ merged, ...p }) => p), [{ path: CH3_PATH, line: 2, base: P1, current: 'The cat sat on the mat and looked at the dog.', suggested: 'A dog sat on the rug.' }]);
  assert.equal(gh.repo(REPO).refs.get(DRAFTS), before);

  const rd = await call(act, { body: { book: BOOK.slug, action: 'change-accept', number: d } });
  assert.equal(rd.statusCode, 200, JSON.stringify(rd.payload));

  const { CHOICES } = await import('../lib/author-console.mjs');
  // "Use the suggestion" is the same word-by-word accept: the clash is refused, nothing written,
  // never the suggester's copy over the changed paragraph. The ways on come with the refusal.
  const drafted = gh.repo(REPO).refs.get(DRAFTS);
  const use = await call(act, { body: { book: BOOK.slug, action: 'change-accept', number: c, resolve: CHOICES.use.resolve } });
  assert.equal(use.statusCode, 409);
  assert.deepEqual(use.payload.choices, JSON.parse(JSON.stringify(CHOICES)));
  assert.equal(gh.repo(REPO).refs.get(DRAFTS), drafted);
  assert.equal(gh.textAt(REPO, drafted, CH3_PATH), para3('The cat sat on the mat and looked at the dog.', 'Second paragraph stays as it was.'));
  // Anything else is refused as before.
  assert.equal((await call(act, { body: { book: BOOK.slug, action: 'change-accept', number: c, resolve: 'theirs' } })).statusCode, 400);
});

test('every choice the page is sent is one the API takes, on a fresh and on an outdated suggestion', async () => {
  const listed = async () => (await get('changes', { book: BOOK.slug })).payload.changes;
  for (const key of ['accept', 'use', 'edit']) {
    // Fresh: GitHub merges it as it is.
    resetBook();
    gh.commitFiles(REPO, DRAFTS, { [CH3_PATH]: para3(P1) });
    const n = proposal(`fresh-${key}`, gh.repo(REPO).refs.get(DRAFTS), para3('The cat sat on the mat and looked at dog.'));
    const choice = (await listed()).find((x) => x.number === n).choices[key];
    const r = await call(act, { body: { book: BOOK.slug, action: choice.action, number: n, ...(choice.resolve ? { resolve: choice.resolve } : {}) } });
    assert.equal(r.statusCode, 200, `${key}: ${JSON.stringify(r.payload)}`);
    // Outdated: the drafts made a glossary link of a word next to the reader's insertion since.
    resetBook();
    gh.commitFiles(REPO, DRAFTS, { [CH3_PATH]: para3('The **cat** sat on mat and looked at dog.') });
    const m = proposal(`old-${key}`, gh.repo(REPO).refs.get(DRAFTS), para3('The black **cat** sat on mat and looked at dog.'));
    gh.commitFiles(REPO, DRAFTS, { [CH3_PATH]: para3('The **[[glossary#cat|cat]]** sat on mat and looked at dog.') });
    const r2 = await call(act, { body: { book: BOOK.slug, action: choice.action, number: m, ...(choice.resolve ? { resolve: choice.resolve } : {}) } });
    assert.equal(r2.statusCode, 200, `${key}: ${JSON.stringify(r2.payload)}`);
    assert.equal(drafts3(), para3('The black **[[glossary#cat|cat]]** sat on mat and looked at dog.'), key);
  }
  resetBook();
  gh.commitFiles(REPO, DRAFTS, { [CH3_PATH]: para3(P1) });
  const d = proposal('old-decline', gh.repo(REPO).refs.get(DRAFTS), para3('A dog sat on the rug.'));
  gh.commitFiles(REPO, DRAFTS, { [CH3_PATH]: para3('The cat sat on the rug and looked at dog.') });
  const choice = (await listed()).find((x) => x.number === d).choices.decline;
  const r = await call(act, { body: { book: BOOK.slug, action: choice.action, number: d, reason: 'The paragraph has changed since this suggestion was made.' } });
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
});

test('Edit before accepting: the reader\'s other words go in, the drafts\' words where both changed them, the reader credited', async () => {
  const { CHOICES } = await import('../lib/author-console.mjs');
  resetBook();
  gh.commitFiles(REPO, DRAFTS, { [CH3_PATH]: para3(P1) });
  // The reader: "mat" -> "rug" and "dog." -> "a dog."; the author since: "dog." -> "the dog." (the same place).
  const n = proposal('edit', gh.repo(REPO).refs.get(DRAFTS), para3('The cat sat on rug and looked at a dog.'));
  gh.commitFiles(REPO, DRAFTS, { [CH3_PATH]: para3('The cat sat on mat and looked at the dog.') });
  await overlapOf(n);
  const r = await call(act, { body: { book: BOOK.slug, action: 'change-accept', number: n, resolve: CHOICES.edit.resolve } });
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  assert.equal(drafts3(), para3('The cat sat on rug and looked at the dog.'));
  assert.deepEqual(r.payload.edit, { path: CH3_PATH, line: 2, paragraphs: [{ path: CH3_PATH, line: 2, base: P1, current: 'The cat sat on mat and looked at the dog.', suggested: 'The cat sat on rug and looked at a dog.', merged: 'The cat sat on rug and looked at the dog.' }] });
  assert.match(r.payload.steps[0], /your wording was kept/);
  const pr = gh.repo(REPO).pulls.get(n);
  assert.match(pr.mergeBody.commit_message, /Co-authored-by: Reader <5\+reader@users\.noreply\.github\.com>/);
  assert.match(pr.mergeBody.commit_message, /Accepted by @brandonandcaroline via the author site\./);
});

test('accepting a draft change: a second click (or the Actions fallback after the API was cut off) is done, not an error', async () => {
  resetBook();
  gh.commitFiles(REPO, DRAFTS, { [CH3_PATH]: para3(P1) });
  const n = proposal('twice', gh.repo(REPO).refs.get(DRAFTS), para3('The cat sat on the mat and looked at dog.'));
  assert.equal((await call(act, { body: { book: BOOK.slug, action: 'change-accept', number: n } })).statusCode, 200);
  const again = await call(act, { body: { book: BOOK.slug, action: 'change-accept', number: n } });
  assert.equal(again.statusCode, 200);
  assert.deepEqual(again.payload.steps, ['This change is already in the drafts area.']);
});

// Item 5 (14 Oct): Accept is a three-way merge against the proposal's base, never the
// suggester's copy of the page over the drafts.
const drafts3 = () => gh.textAt(REPO, gh.repo(REPO).refs.get(DRAFTS), CH3_PATH);
const publishDrafts = () => gh.repo(REPO).refs.set(LIVE, gh.repo(REPO).refs.get(DRAFTS));
const overlapOf = async (n) => {
  const before = gh.repo(REPO).refs.get(DRAFTS);
  const r = await call(act, { body: { book: BOOK.slug, action: 'change-accept', number: n } });
  assert.equal(r.statusCode, 409, JSON.stringify(r.payload));
  assert.equal(r.payload.error, 'overlap');
  assert.equal(r.payload.userMessage, 'This suggestion was made on an older version of this paragraph.');
  assert.equal(gh.repo(REPO).refs.get(DRAFTS), before, 'nothing written');
  return r.payload.overlap.paragraphs;
};

test('three-way accept: a clean merge applies both sides, after a draft edit to another paragraph of the page', async () => {
  resetBook();
  gh.commitFiles(REPO, DRAFTS, { [CH3_PATH]: para3(P1) });
  const n = proposal('clean', gh.repo(REPO).refs.get(DRAFTS), para3(P1, 'Second paragraph stays as it was.'));
  gh.commitFiles(REPO, DRAFTS, { [CH3_PATH]: para3('The cat sat on the mat and looked at the dog.') }); // the author, since
  const r = await call(act, { body: { book: BOOK.slug, action: 'change-accept', number: n } });
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  assert.equal(drafts3(), para3('The cat sat on the mat and looked at the dog.', 'Second paragraph stays as it was.'));
});

test('three-way accept: overlap after a draft edit is refused with old, suggested and current', async () => {
  resetBook();
  gh.commitFiles(REPO, DRAFTS, { [CH3_PATH]: para3(P1) });
  const n = proposal('over-draft', gh.repo(REPO).refs.get(DRAFTS), para3('The cat sat on mat and looked at a dog.'));
  const now = para3('The cat sat on the mat and looked at the dog.');
  gh.commitFiles(REPO, DRAFTS, { [CH3_PATH]: now });
  assert.deepEqual(await overlapOf(n), [{ path: CH3_PATH, line: 2, base: P1, current: 'The cat sat on the mat and looked at the dog.', suggested: 'The cat sat on mat and looked at a dog.', merged: 'The cat sat on the mat and looked at the dog.' }]);
  assert.equal(drafts3(), now);
});

test('three-way accept: overlap after publish is refused the same way; neither drafts nor the live book changes', async () => {
  resetBook();
  gh.commitFiles(REPO, DRAFTS, { [CH3_PATH]: para3(P1) });
  publishDrafts();
  const n = proposal('over-live', gh.repo(REPO).refs.get(DRAFTS), para3('The cat sat on mat and looked at a dog.'));
  const now = para3('The cat sat on the mat and looked at the dog.');
  gh.commitFiles(REPO, DRAFTS, { [CH3_PATH]: now });
  publishDrafts();
  const live = gh.repo(REPO).refs.get(LIVE);
  const paragraphs = await overlapOf(n);
  assert.deepEqual(paragraphs.map((p) => [p.base, p.current, p.suggested]), [[P1, 'The cat sat on the mat and looked at the dog.', 'The cat sat on mat and looked at a dog.']]);
  assert.equal(gh.repo(REPO).refs.get(LIVE), live);
  assert.equal(gh.textAt(REPO, live, CH3_PATH), now);
});

test('three-way accept: a whole-page proposal against a chapter changed since keeps every draft change', async () => {
  resetBook();
  const page = (title, p1, p2) => `# ${title}\n\n${p1}\n\n${p2}\n`;
  gh.commitFiles(REPO, DRAFTS, { [CH3_PATH]: page('Chapter 3', P1, P2) });
  // The reader's whole page: one fix in each paragraph.
  const n = proposal('whole', gh.repo(REPO).refs.get(DRAFTS), page('Chapter 3', 'The cat sat on mat and looked at the dog.', 'Second paragraph stays as it was.'));
  // The author since: a new title and another fix in the first paragraph.
  gh.commitFiles(REPO, DRAFTS, { [CH3_PATH]: page('Chapter 3: Cats', 'The cat sat on the mat and looked at dog.', P2) });
  const r = await call(act, { body: { book: BOOK.slug, action: 'change-accept', number: n } });
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  assert.equal(drafts3(), page('Chapter 3: Cats', 'The cat sat on the mat and looked at the dog.', 'Second paragraph stays as it was.'));
  // And one that rewrote the title the author also changed: refused, the drafts' title kept.
  const m = proposal('whole-2', gh.repo(REPO).refs.get(DRAFTS), page('Chapter Three', 'The cat sat on the mat and looked at the dog.', 'Second paragraph stays as it was.'));
  gh.commitFiles(REPO, DRAFTS, { [CH3_PATH]: page('Chapter 3: Felines', 'The cat sat on the mat and looked at the dog.', 'Second paragraph stays as it was.') });
  assert.deepEqual((await overlapOf(m)).map((p) => [p.base, p.current, p.suggested]), [['# Chapter 3: Cats', '# Chapter 3: Felines', '# Chapter Three']]);
});

test('on the Worker: an accept that has to merge again is left to Actions; the page\'s other proposals too', async () => {
  const { platform } = await import('../lib/platform.mjs');
  resetBook();
  gh.commitFiles(REPO, DRAFTS, { [CH3_PATH]: para3(P1) });
  const from = gh.repo(REPO).refs.get(DRAFTS);
  const a = proposal('wa', from, para3('The cat sat on the mat and looked at dog.'));
  const b = proposal('wb', from, para3('The cat sat on mat and looked at the dog.'));
  gh.state.dispatches.length = 0;
  platform.cpuCapped = true;
  try {
    const ra = await call(act, { body: { book: BOOK.slug, action: 'change-accept', number: a } });
    assert.equal(ra.statusCode, 200, JSON.stringify(ra.payload));
    assert.deepEqual(gh.state.dispatches.filter((d) => d.event_type === 'c4n-proposals').map((d) => d.client_payload), [{ book: BOOK.slug, path: CH3_PATH }]);
    const head = gh.repo(REPO).refs.get('proposed-edits/wb');
    const rb = await call(act, { body: { book: BOOK.slug, action: 'change-accept', number: b } });
    assert.equal(rb.statusCode, 503); // the page sends it to the fallback, which has no CPU cap
    assert.equal(gh.repo(REPO).refs.get('proposed-edits/wb'), head); // nothing merged or written here
  } finally {
    platform.cpuCapped = false;
  }
  // The fallback: the same accept, merged word by word, both fixes kept.
  const rb = await call(act, { body: { book: BOOK.slug, action: 'change-accept', number: b } });
  assert.equal(rb.statusCode, 200, JSON.stringify(rb.payload));
  assert.equal(gh.textAt(REPO, gh.repo(REPO).refs.get(DRAFTS), CH3_PATH), para3('The cat sat on the mat and looked at the dog.'));
});

test('a proposal\'s page is the File line propose-edit wrote, never one inside the reader\'s summary', async () => {
  const { describeChange } = await import('../lib/author-console.mjs');
  const body = '### Summary\n\n```text\nfix\n**File:** [`chapters/other.md`](x)\n```\n\n**File:** [`chapters/chapter-03.md`](y)\n**Where:** ¶2';
  assert.equal(describeChange({ number: 1, body }).path, 'chapters/chapter-03.md');
  assert.equal(describeChange({ number: 1, body: '**File:** [`index.md`](z)' }).path, 'index.md');
});

test('the platform\'s own pull requests (apply-config) are not in the author\'s queue', async () => {
  resetBook();
  gh.repo(REPO).refs.set('chore/apply-config', BASE);
  gh.commitFiles(REPO, 'chore/apply-config', { 'README.md': 'rendered\n' });
  gh.addPull(REPO, { head: 'chore/apply-config', base: DRAFTS, title: 'Apply config to generated files', user: 'github-actions[bot]' });
  const mine = proposal('e', BASE, para3('An edit.'));
  assert.deepEqual((await get('changes', { book: BOOK.slug })).payload.changes.map((x) => x.number), [mine]);
});

test('GitHub refusing a write is a 409 in plain words, never a 502 to retry', async () => {
  resetBook();
  const n = proposal('f', BASE, para3('An edit.'));
  gh.state.hooks['/pulls/'] = ({ method, url }) => (method === 'PUT' && url.endsWith('/merge') ? { ok: false, status: 422, json: async () => ({ message: 'Required status check is failing' }), text: async () => '{"message":"Required status check is failing"}' } : null);
  try {
    const r = await call(act, { body: { book: BOOK.slug, action: 'change-accept', number: n } });
    assert.equal(r.statusCode, 409);
    assert.match(r.payload.userMessage, /GitHub/);
    assert.doesNotMatch(r.payload.userMessage, /could not be reached/);
  } finally {
    delete gh.state.hooks['/pulls/'];
  }
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
  assert.equal(gh.state.dispatches.at(-1).event_type, 'author-lint');

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

test('publishing stops on the book\'s lint (the author-lint job), with the problems listed; dead links are only a notice', async () => {
  resetBook();
  gh.commitFiles(REPO, DRAFTS, { 'chapters/chapter-03.md': `${NEW3}\n**Bold as a heading**\n\nText.\n` });
  LINT = MD036;
  // The job doesn't answer yet.
  const workflow = gh.state.hooks['/book-requests/dispatches'];
  gh.state.hooks['/book-requests/dispatches'] = () => {};
  let n;
  let pr;
  try {
    const prep = await call(act, { body: { book: BOOK.slug, action: 'publish-prepare' } });
    n = prep.payload.publish.number;
    pr = gh.repo(REPO).pulls.get(n);
    pr.head.sha = gh.repo(REPO).refs.get(DRAFTS);
    pr.comments.push(`<!-- link-check sha=${pr.head.sha} -->\nLinks that didn't work:\n- https://gone.example/x in chapters/chapter-03.md (404 Not Found)`);
    gh.state.dispatches.length = 0;

    // Not answered yet: being checked, the job asked for with the book and commit, and
    // publishing refused until it answers.
    const checking = (await get('publish', { book: BOOK.slug })).payload.publish;
    assert.equal(checking.state, 'checking');
    assert.equal(checking.can_publish, false);
    assert.deepEqual(checking.lint_job, { sha: pr.head.sha });
    assert.deepEqual(gh.state.dispatches.map((d) => [d.repo, d.event_type, d.client_payload]),
      [[REQUESTS, 'author-lint', { book: BOOK.slug, repo: REPO, sha: pr.head.sha }]]);
    const early = await call(act, { body: { book: BOOK.slug, action: 'publish', number: n, confirm: true } });
    assert.equal(early.statusCode, 409);
    assert.equal(early.payload.state, 'checking');
    const poll = (await get('lint', { book: BOOK.slug, sha: pr.head.sha })).payload;
    assert.deepEqual(poll, { lint: { state: 'checking' } });
    assert.equal(gh.state.dispatches.length, 2, 'the poll only reads: only publish and the refused publish asked');
  } finally {
    gh.state.hooks['/book-requests/dispatches'] = workflow;
  }

  // Answered: the problems come back, and stop publishing.
  await get('publish', { book: BOOK.slug });
  assert.deepEqual((await get('lint', { book: BOOK.slug, sha: pr.head.sha })).payload,
    { lint: { state: 'done', problems: MD036, count: 1 } });
  const state = (await get('publish', { book: BOOK.slug })).payload.publish;
  assert.equal(state.state, 'lint');
  assert.equal(state.can_publish, false);
  assert.deepEqual(state.lint.map((p) => [p.path, p.rule]), [['chapters/chapter-03.md', 'MD036']]);
  assert.deepEqual(state.links, { checked: true, dead: [{ url: 'https://gone.example/x', file: 'chapters/chapter-03.md', status: '404 Not Found' }] });

  const refused = await call(act, { body: { book: BOOK.slug, action: 'publish', number: n, confirm: true } });
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.payload.state, 'lint');
  assert.match(refused.payload.userMessage, /1 formatting problem in 1 page.*chapters\/chapter-03\.md line 9 \(emphasis used instead of a heading\)/);
  assert.equal(gh.repo(REPO).refs.get(LIVE), BASE, 'nothing went live');

  // A new commit with nothing to fix publishes, dead link and all.
  LINT = [];
  gh.commitFiles(REPO, DRAFTS, { 'chapters/chapter-03.md': NEW3 });
  pr.head.sha = gh.repo(REPO).refs.get(DRAFTS);
  await get('publish', { book: BOOK.slug });
  const after = (await get('publish', { book: BOOK.slug })).payload.publish;
  assert.equal(after.state, 'clean');
  assert.equal(after.links.checked, false, 'the link check spoke of an earlier commit');
  assert.equal((await call(act, { body: { book: BOOK.slug, action: 'publish', number: n, confirm: true } })).statusCode, 200);
});

test('lint: an answer for another book or commit, or a failed run, is never taken as clean', async () => {
  resetBook();
  const sha = gh.repo(REPO).refs.get(DRAFTS);
  const answer = (o) => gh.commitFiles(REQUESTS, `author-lint/${BOOK.slug}/${sha}`, { 'lint/result.json': JSON.stringify({ version: 1, book: BOOK.slug, sha, ok: true, problems: [], files: 1, ...o }) });
  for (const [o, want] of [[{ ok: false }, 'failed'], [{ book: 'another' }, 'failed'], [{ sha: 'a'.repeat(40) }, 'failed'], [{}, 'done']]) {
    answer(o);
    assert.equal((await get('lint', { book: BOOK.slug, sha })).payload.lint.state, want, JSON.stringify(o));
  }
  assert.equal((await get('lint', { book: BOOK.slug, sha: 'nope' })).payload.lint.state, 'failed');
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
  const first = (await get('publish', { book: BOOK.slug })).payload.publish;
  assert.equal(first.state, 'not_open');
  assert.deepEqual(first.lint_job, { sha: gh.repo(REPO).refs.get(DRAFTS) }, JSON.stringify(first));
  const p = (await get('publish', { book: BOOK.slug })).payload.publish;
  assert.ok(Array.isArray(p.lint), JSON.stringify(p));
  assert.equal(p.lint_job, undefined);
});

test('a suggestion: the text the reader started from, only when the whole of it is there', async () => {
  const { parseSuggestion } = await import('../lib/author-console.mjs');
  const issue = (quote) => ({
    number: 5, title: 'Note on ¶2: chapters/a.md', labels: ['suggested-edit'], state: 'open',
    body: ['**File:** [`chapters/a.md`](x)', '**Where:** [¶2](y)', ...(quote ? ['', '```text', quote, '```'] : []),
      '', '### Suggested edit', '', '```text', 'The new words.', '```'].join('\n'),
  });
  assert.equal(parseSuggestion(issue('The old words.')).original, 'The old words.');
  assert.equal(parseSuggestion(issue('The old start…')).original, '');
  assert.equal(parseSuggestion(issue('')).original, '');
  assert.equal(parseSuggestion(issue('')).suggestion, 'The new words.');
});

// --- Review all in chapter (lib/review.mjs) ---------------------------------------------

const Q1 = 'The cat sat on mat.';
const Q2 = 'Dogs bark at night.';
const page2 = (a, b) => `# Chapter 3\n\n${a}\n\n${b}\n`;
function written(number, original, suggestion) {
  return gh.addIssue(REPO, { title: `Note on ¶2: ${CH3_PATH}`, labels: [{ name: 'suggested-edit' }, { name: 'section-note' }, { name: 'needs-triage' }],
    body: `**File:** [\`${CH3_PATH}\`](https://example.invalid)\n**Where:** [¶2](https://example.invalid#p2)\n\n\`\`\`text\n${original}\n\`\`\`\n\n### Suggested edit\n\n\`\`\`text\n${suggestion}\n\`\`\`\n\n---\n\n**Submitted by:** \`Sam\`` });
}
const reviewOf = async () => {
  const r = await get('review', { book: BOOK.slug, path: CH3_PATH });
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  return r.payload;
};
const hunksOf = (view, n) => view.items.find((i) => i.number === n).hunks;

test('review: a mixed batch lands as one drafts commit; whole proposals merged, a partial one closed and credited, the suggestion closed', async () => {
  resetBook();
  gh.commitFiles(REPO, DRAFTS, { [CH3_PATH]: page2(Q1, Q2) });
  const from = gh.repo(REPO).refs.get(DRAFTS);
  const a = proposal('ra', from, page2('The cat sat on the mat.', Q2), { title: 'missing word' });
  const b = proposal('rb', from, page2(Q1, 'Dogs bark loudly at night.'), { title: 'louder' });
  const whole = proposal('rc', from, page2('The cat sat on the mat today.', 'Dogs bark at midnight.'), { title: 'whole page' });
  const s = written(0, 'Dogs bark', 'Hounds bark');
  const view = await reviewOf();
  assert.equal(view.drafts, from);
  assert.equal(view.paragraphs.join(''), page2(Q1, Q2));
  // whole's first paragraph overlaps a's; its second overlaps b's and the suggestion's.
  const [w1, w2] = hunksOf(view, whole);
  assert.deepEqual(view.hunks.find((x) => x.id === w1).overlaps, hunksOf(view, a));
  // Tick a and b whole, and nothing of `whole` that clashes: it can't be all of it.
  const refused = await call(act, { body: { book: BOOK.slug, action: 'review-accept', path: CH3_PATH, drafts: from, hunks: [...hunksOf(view, a), w1] } });
  assert.equal(refused.statusCode, 409);
  assert.deepEqual(refused.payload.invalid.map((x) => x.why), ['it overlaps another ticked change']);
  assert.equal(gh.repo(REPO).refs.get(DRAFTS), from, 'nothing written');

  const heads = { a: gh.repo(REPO).pulls.get(a).head.sha, b: gh.repo(REPO).pulls.get(b).head.sha };
  const ok = await call(act, { body: { book: BOOK.slug, action: 'review-accept', path: CH3_PATH, drafts: from, hunks: [...hunksOf(view, a), w2] } });
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.payload));
  const head = gh.repo(REPO).refs.get(DRAFTS);
  assert.equal(gh.textAt(REPO, head, CH3_PATH), page2('The cat sat on the mat.', 'Dogs bark at midnight.'));
  const c = gh.repo(REPO).commits.get(head);
  assert.deepEqual(c.parents, [from, heads.a], 'the drafts, then each proposal accepted whole');
  assert.match(c.message, new RegExp(`^Accept 2 reader suggestions on chapter-03\\n\\n- #${a} proposed edit “missing word” by .+\\n- #${whole} proposed edit “whole page” by .+ \\(1 of 2 changes\\)\\n\\nAccepted by @brandonandcaroline via the author site\\.$`));
  assert.equal(gh.repo(REPO).pulls.get(a).merged, true, 'GitHub marks it merged');
  const w = gh.repo(REPO).pulls.get(whole);
  assert.equal(w.state, 'closed');
  assert.ok(!w.merged);
  assert.ok(w.labels.some((l) => (l.name ?? l) === 'accepted-in-part'));
  assert.match(w.comments.at(-1), /Part of it was accepted .*\n\nThe part accepted:\n\n> Dogs bark at midnight\./s);
  assert.deepEqual(ok.payload.accepted.map((x) => [x.number, x.all]), [[a, true], [whole, false]]);
  // Still open, untouched: b and the suggestion.
  assert.equal(gh.repo(REPO).pulls.get(b).state, 'open');
  assert.equal(gh.repo(REPO).issues.get(s).state, 'open');
  // A proposal accepted in part is never listed as declined.
  const declined = await get('declined', { book: BOOK.slug });
  assert.ok(!declined.payload.items.some((x) => x.number === whole));

  // The suggestion's words are gone now ("at midnight" replaced its paragraph's end, not "Dogs bark"):
  // it is still exact, and accepted alone it closes as completed with the thank-you.
  const v2 = await reviewOf();
  const r2 = await call(act, { body: { book: BOOK.slug, action: 'review-accept', path: CH3_PATH, drafts: v2.drafts, hunks: hunksOf(v2, s) } });
  assert.equal(r2.statusCode, 200, JSON.stringify(r2.payload));
  const issue = gh.repo(REPO).issues.get(s);
  assert.equal(issue.state, 'closed');
  assert.equal(issue.state_reason, 'completed');
  assert.ok(issue.comments.at(-1).includes(r2.payload.url));
  assert.equal(gh.textAt(REPO, gh.repo(REPO).refs.get(DRAFTS), CH3_PATH), page2('The cat sat on the mat.', 'Hounds bark at midnight.'));

  // Its leftover part: declined with a reason (a comment), then kept open (open again).
  const d = await call(act, { body: { book: BOOK.slug, action: 'part-decline', number: whole, reason: 'The first sentence reads better as it is.', part: 'The cat sat on the mat today.' } });
  assert.equal(d.statusCode, 200, JSON.stringify(d.payload));
  assert.match(w.comments.at(-1), /tb-declined[\s\S]*The part declined:\n\n> The cat sat on the mat today\./);
  const short = await call(act, { body: { book: BOOK.slug, action: 'part-decline', number: whole, reason: 'no', part: 'x' } });
  assert.equal(short.statusCode, 400, 'never declined without a reason');
  const k = await call(act, { body: { book: BOOK.slug, action: 'part-keep', number: whole } });
  assert.equal(k.statusCode, 200, JSON.stringify(k.payload));
  assert.equal(w.state, 'open');
});

test('review: drafts moved since the view (a second tab saved): rebuilt, good ticks kept, the rest named, nothing written', async () => {
  resetBook();
  gh.commitFiles(REPO, DRAFTS, { [CH3_PATH]: page2(Q1, Q2) });
  const from = gh.repo(REPO).refs.get(DRAFTS);
  const a = proposal('ma', from, page2('The cat sat on the mat.', Q2));
  const b = proposal('mb', from, page2(Q1, 'Dogs bark loudly at night.'));
  const view = await reviewOf();
  gh.commitFiles(REPO, DRAFTS, { [CH3_PATH]: page2('The cat sat on a mat.', Q2) }); // the other tab
  const moved = gh.repo(REPO).refs.get(DRAFTS);
  const ticks = [...hunksOf(view, a), ...hunksOf(view, b)];
  const r = await call(act, { body: { book: BOOK.slug, action: 'review-accept', path: CH3_PATH, drafts: from, hunks: ticks } });
  assert.equal(r.statusCode, 409);
  assert.match(r.payload.userMessage, /changed while you were reviewing/);
  assert.equal(r.payload.view.drafts, moved);
  assert.deepEqual(r.payload.kept, hunksOf(view, b));
  assert.deepEqual(r.payload.invalid, [{ id: hunksOf(view, a)[0], why: 'its paragraph changed in the drafts since' }]);
  assert.equal(gh.repo(REPO).refs.get(DRAFTS), moved, 'nothing written');
  assert.equal(gh.repo(REPO).pulls.get(a).state, 'open');
});

test('review: an empty batch is refused; on the Worker the batch goes to Actions before any work', async () => {
  resetBook();
  gh.commitFiles(REPO, DRAFTS, { [CH3_PATH]: page2(Q1, Q2) });
  const from = gh.repo(REPO).refs.get(DRAFTS);
  const empty = await call(act, { body: { book: BOOK.slug, action: 'review-accept', path: CH3_PATH, drafts: from, hunks: [] } });
  assert.equal(empty.statusCode, 400);
  assert.equal(empty.payload.userMessage, 'Tick at least one change, or edit a paragraph, to save.');
  const { platform } = await import('../lib/platform.mjs');
  platform.cpuCapped = true;
  try {
    const before = gh.state.calls.length;
    const r = await call(act, { body: { book: BOOK.slug, action: 'review-accept', path: CH3_PATH, drafts: from, hunks: ['p1-x'] } });
    assert.equal(r.statusCode, 503);
    assert.ok(!gh.state.calls.slice(before).some((x) => x.url.includes('/graphql') || x.method !== 'POST' || !x.url.includes('access_tokens')), 'no GitHub reads');
  } finally {
    platform.cpuCapped = false;
  }
});

test('review on the Worker: read in parts (the page, then each proposal), the same hunks as read whole', async () => {
  resetBook();
  gh.commitFiles(REPO, DRAFTS, { [CH3_PATH]: page2(Q1, Q2) });
  const from = gh.repo(REPO).refs.get(DRAFTS);
  const a = proposal('pa', from, page2('The cat sat on the mat.', 'Dogs bark at midnight.'));
  written(0, 'Dogs bark', 'Hounds bark');
  const whole = await reviewOf();
  const { platform } = await import('../lib/platform.mjs');
  platform.cpuCapped = true;
  try {
    const light = await reviewOf();
    const item = light.items.find((i) => i.number === a);
    assert.equal(item.deferred, true);
    assert.deepEqual(item.hunks, []);
    const one = await get('review', { book: BOOK.slug, path: CH3_PATH, number: String(a) });
    assert.equal(one.statusCode, 200, JSON.stringify(one.payload));
    assert.equal(one.payload.drafts, light.drafts);
    assert.deepEqual(one.payload.hunks.map(({ overlaps, ...x }) => x), whole.hunks.filter((x) => x.item === `p${a}`).map(({ overlaps, ...x }) => x));
  } finally {
    platform.cpuCapped = false;
  }
});

test('review: a stale edit ticked with clean ones lands in the same one commit, the suggestion\'s words in place', async () => {
  resetBook();
  gh.commitFiles(REPO, DRAFTS, { [CH3_PATH]: page2(Q1, Q2) });
  const from = gh.repo(REPO).refs.get(DRAFTS);
  const a = proposal('sa', from, page2('The cat sat on the mat.', Q2));
  const b = proposal('sb', from, page2(Q1, 'Dogs bark at midnight.'));
  gh.commitFiles(REPO, DRAFTS, { [CH3_PATH]: page2('The cat sat on a mat.', Q2) }); // the same words, changed since
  const view = await reviewOf();
  const [stale] = hunksOf(view, a);
  assert.ok(stale.endsWith('-old'));
  const r = await call(act, { body: { book: BOOK.slug, action: 'review-accept', path: CH3_PATH, drafts: view.drafts, hunks: [stale, ...hunksOf(view, b)] } });
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  assert.equal(gh.textAt(REPO, gh.repo(REPO).refs.get(DRAFTS), CH3_PATH), page2('The cat sat on the mat.', 'Dogs bark at midnight.'));
  assert.equal(gh.repo(REPO).pulls.get(a).merged, true);
  assert.equal(gh.repo(REPO).pulls.get(b).merged, true);
});

test('review: the author\'s paragraph edit and two ticked edits land as one drafts commit; an unticked one in the edited paragraph stays open', async () => {
  resetBook();
  gh.commitFiles(REPO, DRAFTS, { [CH3_PATH]: page2(Q1, Q2) });
  const from = gh.repo(REPO).refs.get(DRAFTS);
  const a = proposal('ea', from, page2('The cat sat on the mat.', Q2));
  const b = proposal('eb', from, page2(Q1, 'Dogs bark at midnight.'));
  const c = proposal('ec', from, page2('A cat sat on mat.', Q2)); // overlaps a, left unticked
  const view = await reviewOf();
  const P = view.paragraphs;
  const k = P.findIndex((p) => p.startsWith('The cat'));
  // The editor started from paragraph 1 with tick a in it; the author rewrote it.
  const r = await call(act, { body: { book: BOOK.slug, action: 'review-accept', path: CH3_PATH, drafts: view.drafts, hunks: [...hunksOf(view, a), ...hunksOf(view, b)],
    edits: [{ at: k, end: k + 1, orig: P[k], text: 'The cat sat on the old mat, purring.' }] } });
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  assert.equal(r.payload.edited, 1);
  assert.match(r.payload.steps[0], /^2 changes from 2 reader items and one paragraph you edited went into the drafts as one change\.$/);
  const head = gh.repo(REPO).refs.get(DRAFTS);
  assert.equal(gh.textAt(REPO, head, CH3_PATH), page2('The cat sat on the old mat, purring.', 'Dogs bark at midnight.'));
  assert.equal(gh.repo(REPO).commits.get(head).parents.length, 3, 'one commit: the drafts and both proposals, accepted whole');
  assert.match(gh.repo(REPO).commits.get(head).message, /one paragraph edited by the author/);
  assert.equal(gh.repo(REPO).pulls.get(a).merged, true, 'a ticked edit inside the edited paragraph is accepted, with credit');
  assert.equal(gh.repo(REPO).pulls.get(c).state, 'open', 'the unticked one stays to decide');
  // Published on its own, the chapter names the review's commit (it holds the author's
  // words) and both proposals' as going live.
  const pub = await call(act, { body: { book: BOOK.slug, action: 'publish-chapter', path: CH3_PATH } });
  assert.equal(pub.statusCode, 200, JSON.stringify(pub.payload));
  const named = [...gh.state.autoMerge.at(-1).b.matchAll(/^Publishes-commit: ([0-9a-f]{40})$/gm)].map((m) => m[1]);
  assert.ok(named.includes(head), 'the review commit');
  for (const p of gh.repo(REPO).commits.get(head).parents.slice(1)) assert.ok(named.includes(p), 'each proposal');
});

test('review: the drafts moved under a paragraph the author edited — refused, the edit named, nothing written over', async () => {
  resetBook();
  gh.commitFiles(REPO, DRAFTS, { [CH3_PATH]: page2(Q1, Q2) });
  const view = await reviewOf();
  const P = view.paragraphs;
  const k = P.findIndex((p) => p.startsWith('The cat'));
  gh.commitFiles(REPO, DRAFTS, { [CH3_PATH]: page2('The cat sat on a rug.', Q2) }); // another tab
  const moved = gh.repo(REPO).refs.get(DRAFTS);
  // Built on the moved drafts (no sha mismatch), the paragraph check still catches it.
  const r = await call(act, { body: { book: BOOK.slug, action: 'review-accept', path: CH3_PATH, drafts: moved, hunks: [], edits: [{ at: k, end: k + 1, orig: P[k], text: 'Mine.' }] } });
  assert.equal(r.statusCode, 409);
  assert.match(r.payload.userMessage, /changed a paragraph you edited/);
  assert.deepEqual(r.payload.edits, [{ edit: 0, why: 'its paragraph changed in the drafts since you edited it' }]);
  assert.equal(gh.repo(REPO).refs.get(DRAFTS), moved);
  assert.equal(gh.textAt(REPO, moved, CH3_PATH), page2('The cat sat on a rug.', Q2));
});

// --- Publish this chapter (lib/publish-chapter.mjs) -----------------------------------------

const LIVE_INDEX = '# Book\n\n## Contents\n\n- **[[chapters/chapter-03|Chapter 3]]**\n';
const filesOf = (sha) => [...gh.repo(REPO).trees.get(gh.repo(REPO).commits.get(sha).tree).keys()];
const openPublish = () => [...gh.repo(REPO).pulls.values()].filter((p) => p.state === 'open' && p.head.ref.startsWith('publish-chapter/')).at(-1);
const publishOne = (path, extra = {}) => call(act, { body: { book: BOOK.slug, action: 'publish-chapter', path, ...extra } });

test('publish one chapter: only its text goes to the live branch, three ways; the other chapter, settings and the rest of index.md wait', async () => {
  resetBook();
  gh.commitFiles(REPO, LIVE, { 'chapters/chapter-04.md': '# Chapter 4\n\nRocks.\n', 'index.md': `${LIVE_INDEX}- [[chapters/chapter-04|Chapter 4]]\n` });
  gh.repo(REPO).refs.set(DRAFTS, gh.repo(REPO).refs.get(LIVE));
  // Drafts: both chapters edited, the front page's introduction and the book's type changed.
  gh.commitFiles(REPO, DRAFTS, { [CH3_PATH]: CH3.replace('Second paragraph.', 'Second paragraph, edited.'), 'chapters/chapter-04.md': '# Chapter 4\n\nHard rocks.\n',
    'index.md': `---\nresource_type: Paper\n---\n# Book\n\nAn introduction.\n\n## Contents\n\n- **[[chapters/chapter-03|Chapter 3]]**\n- [[chapters/chapter-04|Chapter 4]]\n` }, { message: 'Edit chapters 3 and 4' });
  // Meanwhile a fix on the live book, in chapter 3's first paragraph.
  gh.commitFiles(REPO, LIVE, { [CH3_PATH]: CH3.replace('The the domains', 'The domains') });
  const liveBefore = gh.repo(REPO).refs.get(LIVE);
  const r = await publishOne(CH3_PATH);
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  const pr = openPublish();
  assert.equal(pr.base.ref, LIVE);
  assert.equal(pr.title, 'Publish “Chapter 3”');
  const head = gh.repo(REPO).refs.get(pr.head.ref);
  assert.deepEqual(gh.repo(REPO).commits.get(head).parents, [liveBefore], 'one commit on the live branch');
  // Only chapter 3 changed: the live fix and the drafts edit both in it.
  assert.equal(gh.textAt(REPO, head, CH3_PATH), CH3.replace('The the domains', 'The domains').replace('Second paragraph.', 'Second paragraph, edited.'));
  assert.equal(gh.textAt(REPO, head, 'chapters/chapter-04.md'), '# Chapter 4\n\nRocks.\n');
  assert.equal(gh.textAt(REPO, head, 'index.md'), `${LIVE_INDEX}- [[chapters/chapter-04|Chapter 4]]\n`);
  // It merges itself (squash) once the checks pass, saying what it publishes.
  const auto = gh.state.autoMerge.at(-1);
  assert.equal(auto.h, 'Published “Chapter 3”');
  assert.match(auto.b, /^Published by @brandonandcaroline via the author site: this chapter only\. The rest of the drafts waits for Publish all\.\n\nPublishes-commit: [0-9a-f]{40}$/);
});

test('publish a new chapter: the chapter and only its Contents line in index.md', async () => {
  resetBook();
  gh.commitFiles(REPO, DRAFTS, { 'chapters/chapter-05.md': '# Chapter 5\n\nNew things.\n',
    'index.md': '# Book\n\nA new introduction.\n\n## Contents\n\n- **[[chapters/chapter-03|Chapter 3]]**\n- [[chapters/chapter-05|Chapter 5]]\n' });
  const r = await publishOne('chapters/chapter-05.md');
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  const head = gh.repo(REPO).refs.get(openPublish().head.ref);
  assert.equal(gh.textAt(REPO, head, 'chapters/chapter-05.md'), '# Chapter 5\n\nNew things.\n');
  assert.equal(gh.textAt(REPO, head, 'index.md'), '# Book\n\n## Contents\n\n- **[[chapters/chapter-03|Chapter 3]]**\n- [[chapters/chapter-05|Chapter 5]]\n', 'the introduction stays in the drafts');
});

test('publish a chapter linking to a concept page only in the drafts: asked first; with it, or without it (said plainly)', async () => {
  resetBook();
  gh.commitFiles(REPO, DRAFTS, { [CH3_PATH]: `${CH3}\nSee [[chapters/Definitions/Realism|realism]].\n`, 'chapters/Definitions/Realism.md': '# Realism (a concept)\n\nThe view that…\n' });
  const ask = await publishOne(CH3_PATH);
  assert.equal(ask.statusCode, 409);
  assert.deepEqual(ask.payload.linked, [{ path: 'chapters/Definitions/Realism.md', title: 'Realism (a concept)', why: 'only in the drafts' }]);
  assert.equal(openPublish(), undefined, 'nothing opened yet');
  const without = await publishOne(CH3_PATH, { linked: 'without' });
  assert.equal(without.statusCode, 200, JSON.stringify(without.payload));
  assert.deepEqual(without.payload.linkedLeft.map((l) => l.path), ['chapters/Definitions/Realism.md']);
  assert.ok(!filesOf(gh.repo(REPO).refs.get(openPublish().head.ref)).includes('chapters/Definitions/Realism.md'));
  const first = openPublish();
  const withIt = await publishOne(CH3_PATH, { linked: 'with' });
  assert.equal(first.state, 'closed', 'the earlier publish of the chapter is replaced');
  assert.equal(withIt.statusCode, 200, JSON.stringify(withIt.payload));
  assert.equal(gh.textAt(REPO, gh.repo(REPO).refs.get(openPublish().head.ref), 'chapters/Definitions/Realism.md'), '# Realism (a concept)\n\nThe view that…\n');
});

test('publish a chapter already live as the drafts have it: refused, nothing opened; on the Worker, to Actions at once', async () => {
  resetBook();
  const r = await publishOne(CH3_PATH);
  assert.equal(r.statusCode, 409);
  assert.match(r.payload.userMessage, /already on the live book/);
  const { platform } = await import('../lib/platform.mjs');
  platform.cpuCapped = true;
  try {
    assert.equal((await publishOne(CH3_PATH)).statusCode, 503);
  } finally {
    platform.cpuCapped = false;
  }
});

// --- Publish the rest of the book, a removed chapter, who changed it --------------------------

const publishRest = (extra = {}) => call(act, { body: { book: BOOK.slug, action: 'publish-rest', ...extra } });

test('publish the rest of the book: pages other than chapters, the front page and settings; chapters and a new chapter\'s Contents line wait', async () => {
  resetBook();
  gh.commitFiles(REPO, DRAFTS, {
    [CH3_PATH]: CH3.replace('Second paragraph.', 'Second paragraph, edited.'),
    'chapters/chapter-05.md': '# Chapter 5\n\nNew.\n',
    'chapters/Definitions/Realism.md': '# Realism\n\nThe view that…\n',
    'glossary.md': '# Glossary\n\nRealism: a view.\n',
    'index.md': '---\nresource_type: Paper\n---\n# Book\n\nAn introduction.\n\n## Contents\n\n- **[[chapters/chapter-03|Chapter 3]]**\n- [[chapters/chapter-05|Chapter 5]]\n',
  }, { message: 'Drafts work' });
  // Meanwhile a fix on the live book's front page, elsewhere in it.
  gh.commitFiles(REPO, LIVE, { 'index.md': '# Book\n\n## Contents\n\n- **[[chapters/chapter-03|Chapter 3]]**\n\nFooter.\n' });
  const r = await publishRest();
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  assert.equal(r.payload.title, 'The rest of the book');
  const pr = openPublish();
  assert.equal(pr.title, 'Publish the rest of the book');
  const head = gh.repo(REPO).refs.get(pr.head.ref);
  assert.equal(gh.textAt(REPO, head, 'chapters/Definitions/Realism.md'), '# Realism\n\nThe view that…\n');
  assert.equal(gh.textAt(REPO, head, 'glossary.md'), '# Glossary\n\nRealism: a view.\n');
  assert.equal(gh.textAt(REPO, head, CH3_PATH), CH3, 'a chapter waits for its own Publish');
  assert.ok(!filesOf(head).includes('chapters/chapter-05.md'));
  assert.equal(gh.textAt(REPO, head, 'index.md'), '---\nresource_type: Paper\n---\n# Book\n\nAn introduction.\n\n## Contents\n\n- **[[chapters/chapter-03|Chapter 3]]**\n\nFooter.\n',
    'the front page three ways (the live fix kept), without the new chapter\'s line');
  const auto = gh.state.autoMerge.at(-1);
  assert.equal(auto.h, 'Published the rest of the book');
  assert.match(auto.b, /^Published by @brandonandcaroline via the author site: the rest of the book: .*\n\nPublishes-commit: [0-9a-f]{40}$/);
  // Nothing left: refused.
  gh.repo(REPO).refs.set(LIVE, head);
  gh.repo(REPO).refs.set(DRAFTS, gh.commitFiles(REPO, DRAFTS, { [CH3_PATH]: CH3 }));
  gh.commitFiles(REPO, DRAFTS, { 'chapters/chapter-05.md': null, 'index.md': gh.textAt(REPO, head, 'index.md'), 'glossary.md': gh.textAt(REPO, head, 'glossary.md'), 'chapters/Definitions/Realism.md': gh.textAt(REPO, head, 'chapters/Definitions/Realism.md') });
  const again = await publishRest();
  assert.equal(again.statusCode, 409);
  assert.match(again.payload.userMessage, /already on the live book/);
});

test('publish the rest of the book linking to a chapter only in the drafts: asked first; with it, the chapter and its Contents line go too', async () => {
  resetBook();
  gh.commitFiles(REPO, DRAFTS, {
    'chapters/chapter-05.md': '# Chapter 5\n\nNew.\n',
    'glossary.md': '# Glossary\n\nSee [[chapters/chapter-05|chapter 5]].\n',
    'index.md': '# Book\n\n## Contents\n\n- **[[chapters/chapter-03|Chapter 3]]**\n- [[chapters/chapter-05|Chapter 5]]\n',
  });
  const ask = await publishRest();
  assert.equal(ask.statusCode, 409);
  assert.deepEqual(ask.payload.linked, [{ path: 'chapters/chapter-05.md', title: 'Chapter 5', why: 'only in the drafts' }]);
  const withIt = await publishRest({ linked: 'with' });
  assert.equal(withIt.statusCode, 200, JSON.stringify(withIt.payload));
  const head = gh.repo(REPO).refs.get(openPublish().head.ref);
  assert.equal(gh.textAt(REPO, head, 'chapters/chapter-05.md'), '# Chapter 5\n\nNew.\n');
  assert.match(gh.textAt(REPO, head, 'index.md'), /- \[\[chapters\/chapter-05\|Chapter 5\]\]\n$/);
});

test('publish a chapter removed in the drafts: gone from the live book with its Contents line, nothing else', async () => {
  resetBook();
  gh.commitFiles(REPO, LIVE, { 'chapters/chapter-04.md': '# Chapter 4\n\nRocks.\n', 'index.md': `${LIVE_INDEX}- [[chapters/chapter-04|Chapter 4]]\n` });
  gh.repo(REPO).refs.set(DRAFTS, gh.repo(REPO).refs.get(LIVE));
  gh.commitFiles(REPO, DRAFTS, { 'chapters/chapter-04.md': null, 'index.md': `# Book\n\nIntro.\n\n## Contents\n\n- **[[chapters/chapter-03|Chapter 3]]**\n`, [CH3_PATH]: `${CH3}More.\n` });
  const r = await publishOne('chapters/chapter-04.md');
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  const head = gh.repo(REPO).refs.get(openPublish().head.ref);
  assert.ok(!filesOf(head).includes('chapters/chapter-04.md'));
  assert.equal(gh.textAt(REPO, head, 'index.md'), LIVE_INDEX, 'only its line goes; the intro waits');
  assert.equal(gh.textAt(REPO, head, CH3_PATH), CH3);
  assert.equal(gh.state.autoMerge.at(-1).h, 'Published “Chapter 4”');
});

test('drafts: who changed each page is a person, never a bot or (when the author site knows the name) an account', async () => {
  const { personOf } = await import('../lib/author-console-reads.mjs');
  const bot = (message) => ({ author: { login: 'textbook-suggest-edit[bot]' }, commit: { message, author: { name: 'textbook-suggest-edit[bot]' } } });
  assert.deepEqual(personOf(bot('Edit ch in the review\n\nEdited by Alec Gordon (member m-ab738d332e) via the author site.')), { who: 'Alec Gordon' });
  assert.deepEqual(personOf(bot('Accept 2\n\nAccepted by @someone-1 via the author site.')), { who: null, login: 'someone-1' });
  assert.deepEqual(personOf(bot('Accept 1 reader suggestion on ch\n\n- #168 proposed edit “Rain” by Mara Quinn')), { who: 'Mara Quinn' });
  assert.deepEqual(personOf(bot('Sync contributors')), { who: null });
  assert.deepEqual(personOf({ author: { login: 'jo-author' }, commit: { message: 'Edit', author: { name: 'jo-author' } } }), { who: null, login: 'jo-author' });
  assert.deepEqual(personOf({ author: null, commit: { message: 'Edit', author: { name: 'Platform Test Reader' } } }), { who: 'Platform Test Reader' });
});

test('review: an accepted written suggestion is done, so the review doesn\'t list it', async () => {
  resetBook();
  gh.commitFiles(REPO, DRAFTS, { [CH3_PATH]: page2(Q1, Q2) });
  const open = written(0, 'Dogs bark', 'Hounds bark');
  const accepted = written(0, 'The cat', 'A cat');
  const it = gh.repo(REPO).issues.get(accepted);
  it.labels = [...it.labels, { name: 'accepted' }];
  const view = await reviewOf();
  assert.deepEqual(view.items.map((i) => i.number), [open]);
});

test('a numbered Contents stays counted: a chapter taken out of the middle, or one put in, leaves no gap or repeat', async () => {
  const { withContentsLines, withoutContentsLines, renumbered } = await import('../lib/publish-chapter.mjs');
  const N = (items) => `# Book\n\n## Contents\n\n${items.map(([n, p, t]) => `${n}. [[chapters/${p}|${t}]]`).join('\n')}\n\nAfter.\n`;
  const live = N([[1, 'a', 'A'], [2, 'b', 'B'], [3, 'c', 'C']]);
  // Taken out of the middle (platform-test-book #179: 5, 7 failed MD029).
  assert.equal(withoutContentsLines(live, ['chapters/b.md']), N([[1, 'a', 'A'], [2, 'c', 'C']]));
  // Put in, numbered as the drafts had it (4.), lands counted.
  const drafts = N([[1, 'a', 'A'], [2, 'b', 'B'], [4, 'n', 'New'], [3, 'c', 'C']]);
  assert.equal(withContentsLines(live, drafts, ['chapters/n.md']), N([[1, 'a', 'A'], [2, 'b', 'B'], [3, 'n', 'New'], [4, 'c', 'C']]));
  // Bullets, and a Contents nothing changed, are left as they are.
  assert.equal(renumbered('# B\n\n## Contents\n\n- [[a|A]]\n- [[b|B]]\n'), '# B\n\n## Contents\n\n- [[a|A]]\n- [[b|B]]\n');
  assert.equal(withContentsLines(live, live, ['chapters/a.md']), null);
});

test('publish a chapter removed from the middle of a numbered Contents: the rest counted again', async () => {
  resetBook();
  const N = (items) => `# Book\n\n## Contents\n\n${items.map(([n, p, t]) => `${n}. [[chapters/${p}|${t}]]`).join('\n')}\n`;
  gh.commitFiles(REPO, LIVE, { 'chapters/chapter-04.md': '# Chapter 4\n\nRocks.\n', 'chapters/chapter-05.md': '# Chapter 5\n\nSand.\n',
    'index.md': N([[1, 'chapter-03', 'Chapter 3'], [2, 'chapter-04', 'Chapter 4'], [3, 'chapter-05', 'Chapter 5']]) });
  gh.repo(REPO).refs.set(DRAFTS, gh.repo(REPO).refs.get(LIVE));
  gh.commitFiles(REPO, DRAFTS, { 'chapters/chapter-04.md': null, 'index.md': N([[1, 'chapter-03', 'Chapter 3'], [2, 'chapter-05', 'Chapter 5']]) });
  const r = await publishOne('chapters/chapter-04.md');
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  assert.equal(gh.textAt(REPO, gh.repo(REPO).refs.get(openPublish().head.ref), 'index.md'), N([[1, 'chapter-03', 'Chapter 3'], [2, 'chapter-05', 'Chapter 5']]));
});
