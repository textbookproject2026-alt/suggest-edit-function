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

test('names in one call: live-branch proposals only, cached a day, bounded', async () => {
  const res = await get({ book: BOOK.slug, shas: [v2, v3, draftsOnly, v2].join(',') });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload.names, { [v2]: 'Jo Reader', [v3]: null, [draftsOnly]: null });
  assert.match(res.headers['cache-control'], /s-maxage=86400/);
  assert.equal(res.headers['access-control-allow-origin'], '*');
  assert.equal((await get({ book: BOOK.slug, shas: '' })).statusCode, 400);
  assert.equal((await get({ book: BOOK.slug, shas: `${v2},nope` })).statusCode, 400);
  assert.equal((await get({ book: BOOK.slug, shas: Array.from({ length: 31 }, (_, i) => i.toString(16).padStart(40, 'a')).join(',') })).statusCode, 400);
  assert.equal((await get({ book: 'no-such-book', shas: v2 })).statusCode, 404);
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

// --- batch 2a: what is being edited, Compare, and what is proposed -----------------

const { attributionOf, openItem } = await import('../api/page-revision.js');
const DRAFTS = BOOK.content.drafts_branch;

test('a drafts revision (being edited) is served too, and says so; Compare gives any two public versions', async () => {
  const d1 = gh.commitFiles(REPO, DRAFTS, { [PAGE]: '# One\n\nDrafted words.\n' }, { message: 'Edit ¶1 of one.md: a better word' });
  const live = await get({ book: BOOK.slug, sha: v3, path: PAGE });
  assert.equal(live.payload.branch, 'live');
  const drafted = await get({ book: BOOK.slug, sha: d1, path: PAGE });
  assert.equal(drafted.statusCode, 200);
  assert.equal(drafted.payload.branch, 'drafts');
  assert.equal(drafted.payload.after, '# One\n\nDrafted words.\n');
  const cmp = await get({ book: BOOK.slug, sha: d1, base: v1, path: PAGE });
  assert.equal(cmp.statusCode, 200);
  assert.deepEqual([cmp.payload.status, cmp.payload.before, cmp.payload.after], ['compared', '# One\n\nFirst words.\n', '# One\n\nDrafted words.\n']);
  assert.match(cmp.headers['cache-control'], /immutable/);
  // A branch that is neither: refused, either way round.
  assert.equal((await get({ book: BOOK.slug, sha: draftsOnly, base: v1, path: PAGE })).statusCode, 404);
  assert.equal((await get({ book: BOOK.slug, sha: v1, base: draftsOnly, path: PAGE })).statusCode, 404);
  assert.equal((await get({ book: BOOK.slug, sha: v1, base: 'nope', path: PAGE })).statusCode, 400);
});

const PR_BODY = '### Summary\n\n```text\nFixed the spelling of receive.\n```\n\n**File:** [`chapters/one.md`](x)\n**Where:** ¶2\n\n---\n\n**Proposed by:** @ada-l (signed in with GitHub)\n\n_proposed with the in-site editor._';
const NOTE_BODY = '**File:** [`chapters/one.md`](x)\n**Where:** [¶4](https://b.example/chapters/one#p4)\n\n### Suggested edit\n\n```text\nThis needs a source.\n```\n\n---\n\n**Submitted by:** `Bea Reader`\n';

test('what is proposed: open proposals and notes, public fields only, by page; cached 90 seconds', async () => {
  const pr = gh.addPull(REPO, { head: 'proposed-edits/x', base: DRAFTS, title: 'Edit ¶2 of one.md: Fixed the spelling of receive.' });
  Object.assign(gh.repo(REPO).pulls.get(pr), { body: PR_BODY, labels: [{ name: 'proposed-edit' }] });
  const other = gh.addPull(REPO, { head: 'chore/x', base: DRAFTS, title: 'Housekeeping' });
  Object.assign(gh.repo(REPO).pulls.get(other), { body: '', labels: [] });
  const note = gh.addIssue(REPO, { title: 'Note on ¶4: chapters/one.md', body: NOTE_BODY, labels: [{ name: 'suggested-edit' }, { name: 'section-note' }] });
  gh.addIssue(REPO, { title: 'Elsewhere', body: '**File:** [`chapters/two.md`](x)\n\n**Submitted by:** `C`\n', labels: [{ name: 'suggested-edit' }] });
  const res = await get({ book: BOOK.slug, mode: 'open', path: PAGE });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], 'public, max-age=60, s-maxage=90');
  assert.deepEqual(res.payload.items.map((i) => [i.kind, i.number, i.summary, i.who, i.paragraph ?? null]), [
    ['note', note, 'This needs a source.', { name: 'Bea Reader' }, 4],
    ['edit', pr, 'Fixed the spelling of receive.', { name: 'ada-l', github: 'ada-l' }, 2],
  ].sort((a, b) => b[1] - a[1]));
  for (const i of res.payload.items) assert.deepEqual(Object.keys(i).sort(), ['date', 'files', 'kind', 'number', 'paragraph', 'summary', 'url', 'who'].filter((k) => k !== 'paragraph' || 'paragraph' in i).sort());
  // GitHub lists no issues (and no error) for a token without issues: read.
  assert.ok(gh.state.tokenRequests.at(-1).permissions.issues === 'read', 'the token can read the notes');
  const whole = await get({ book: BOOK.slug, mode: 'open' });
  assert.equal(whole.payload.items.length, 3, 'the whole book: both pages');
  const calls = gh.state.calls.length;
  await get({ book: BOOK.slug, mode: 'open', path: PAGE });
  assert.equal(gh.state.calls.length, calls, 'within 90 seconds: from the cache, no GitHub call');
  assert.equal((await get({ book: 'nope', mode: 'open' })).statusCode, 404);
  assert.equal((await get({ book: BOOK.slug, mode: 'open', path: '../x' })).statusCode, 400);
});

test('attribution and an open item, as the panel shows them', () => {
  assert.deepEqual(attributionOf('**Submitted by:** @gobi10k (signed in with GitHub)'), { name: 'gobi10k', github: 'gobi10k' });
  assert.deepEqual(attributionOf('**Proposed by:** `Jo` (`j***@x`)'), { name: 'Jo' });
  assert.equal(attributionOf('**Proposed by:** a reader (`j***@x`)'), null);
  const item = openItem({ number: 7, html_url: 'u', created_at: '2026-10-09T10:00:00Z', title: 'Update one.md', body: '### Summary\n\n```text\n(no summary given)\n```\n' }, 'edit');
  assert.equal(item.summary, 'Update one.md', 'no summary: the title');
});

test('mode=item: a reader item the App opened or attributed, labelled; anything else is 404 (batch 2b notify)', async () => {
  const note = gh.addIssue(REPO, { title: 'Note on ¶4', body: NOTE_BODY, labels: [{ name: 'suggested-edit' }, { name: 'section-note' }], user: { login: 'someone', type: 'User' } });
  const byApp = gh.addIssue(REPO, { title: 'Suggestion', body: 'no attribution here', labels: [{ name: 'suggested-edit' }], user: { login: 'textbook-suggest-edit[bot]', type: 'Bot' } });
  const unlabelled = gh.addIssue(REPO, { title: 'A bug', body: NOTE_BODY, labels: [{ name: 'bug' }], user: { login: 'someone', type: 'User' } });
  const plain = gh.addIssue(REPO, { title: 'Hand-made', body: 'no attribution', labels: [{ name: 'section-note' }], user: { login: 'someone', type: 'User' } });
  const ok = await get({ book: BOOK.slug, mode: 'item', number: String(note) });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual([ok.payload.kind, ok.payload.number, ok.payload.summary, ok.payload.paragraph], ['note', note, 'This needs a source.', { n: 4, url: 'https://b.example/chapters/one#p4' }]);
  assert.equal((await get({ book: BOOK.slug, mode: 'item', number: String(byApp) })).statusCode, 200);
  for (const n of [unlabelled, plain, 99999]) assert.equal((await get({ book: BOOK.slug, mode: 'item', number: String(n) })).statusCode, 404, `#${n}`);
  assert.equal((await get({ book: 'nope', mode: 'item', number: '1' })).statusCode, 404);
  assert.equal((await get({ book: BOOK.slug, mode: 'item', number: 'x' })).statusCode, 404);
});
