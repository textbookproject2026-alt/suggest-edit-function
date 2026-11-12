/**
 * /api/maintainer/test-books (api/maintainer.js): only a member in MAINTAINER_MEMBER_IDS,
 * asserted by the author site, makes or removes a test book; the request is filed as the
 * portal's form files one, with sandbox: true and the maintainer + approved labels.
 * Against a small in-memory GitHub and a stubbed author-site read-back. Run with `npm test`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';

const { privateKey: PEM } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
delete process.env.GITHUB_APP_INSTALLATION_ID;
delete process.env.BOT_TOKEN;
delete process.env.REQUESTS_REPO;
Object.assign(process.env, { GITHUB_APP_ID: '123456', GITHUB_APP_PRIVATE_KEY: Buffer.from(PEM).toString('base64'), MAINTAINER_MEMBER_IDS: 'ab738d332e, m-0000000001' });

const { default: BUNDLE } = await import('../registry/bundled.mjs');
const { AUTHOR_SITE_ORIGIN } = await import('../lib/member.mjs');
const REPO = 'textbookproject2026-alt/book-requests';
const RAW = 'https://raw.githubusercontent.com/textbookproject2026-alt/textbook-registry/main/registry.json';
const ALEC = { id: 'ab738d332e', name: 'Alec Gordon', github: null };
const OTHER = { id: '1234567890', name: 'Someone Else', github: null };

const gh = { issues: [], blobs: new Map(), live: null, asserting: ALEC };
const json = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  const method = opts.method ?? 'GET';
  const body = opts.body ? JSON.parse(opts.body) : undefined;
  if (url === `${AUTHOR_SITE_ORIGIN}/api/internal/assertion`) {
    // The author site answers for any id here: the binding is member.test.mjs's business.
    return gh.asserting ? json(200, { member: gh.asserting, book: '', books: ['platform-test-book'] }) : json(404, {});
  }
  if (url === RAW) return gh.live ? json(200, gh.live) : json(404, {});
  const u = new URL(url);
  if (/^\/app\/installations\/\d+\/access_tokens$/.test(u.pathname)) return json(201, { token: 'ghs_x', expires_at: new Date(Date.now() + 3600_000).toISOString(), repositories: [{ full_name: REPO }] });
  if (u.pathname === `/repos/${REPO}/installation`) return json(200, { id: 7 });
  if (u.pathname === '/graphql') {
    const oids = [...body.query.matchAll(/(p\d+): object\(oid: "([0-9a-f]{40})"\)/g)];
    return json(200, { data: { repository: Object.fromEntries(oids.map(([, k, sha]) => [k, gh.blobs.has(sha) ? { byteSize: Buffer.from(gh.blobs.get(sha), 'base64').length } : null])) } });
  }
  const rest = u.pathname.slice(`/repos/${REPO}`.length);
  if (rest === '/git/blobs' && method === 'POST') {
    const sha = (gh.blobs.size + 1).toString(16).padStart(40, '0');
    gh.blobs.set(sha, body.content);
    return json(201, { sha });
  }
  if (rest.startsWith('/git/blobs/')) return new Response(Buffer.from(gh.blobs.get(rest.slice(11)) ?? '', 'base64'), { status: 200 });
  if (rest === '/git/ref/heads/main') return json(200, { object: { sha: 'p'.repeat(40) } });
  if (rest.startsWith('/git/commits/')) return json(200, { tree: { sha: 't'.repeat(40) } });
  if (rest === '/git/trees') return json(201, { sha: 'n'.repeat(40) });
  if (rest === '/git/commits') return json(201, { sha: 'c'.repeat(40) });
  if (rest === '/git/refs/heads/main') return json(200, {});
  if (rest === '/issues' && method === 'POST') {
    const issue = { number: gh.issues.length + 1, html_url: `https://github.com/${REPO}/issues/${gh.issues.length + 1}`, state: 'open', ...body, labels: body.labels.map((name) => ({ name })) };
    gh.issues.push(issue);
    return json(201, issue);
  }
  if (rest === '/issues' && method === 'GET') {
    const want = u.searchParams.get('labels');
    const state = u.searchParams.get('state');
    return json(200, gh.issues.filter((i) => (state === 'all' || i.state === state) && i.labels.some((l) => l.name === want)));
  }
  let m;
  if ((m = /^\/issues\/(\d+)\/labels$/.exec(rest)) && method === 'POST') {
    const i = gh.issues[Number(m[1]) - 1];
    i.labels.push(...body.labels.map((name) => ({ name })));
    return json(200, i.labels);
  }
  throw new Error(`unexpected ${method} ${url}`);
};

const { default: handler, testSlug, maintainerIds } = await import('../api/maintainer.js');
const { buildIssueBody, validate } = await import('../api/request-book.js');

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
async function call({ method = 'POST', url = '/api/maintainer/test-books', body, who = ALEC, auth = true } = {}) {
  gh.asserting = who;
  const headers = { origin: AUTHOR_SITE_ORIGIN, 'content-type': 'application/json', ...(auth ? { authorization: `Member ${'a'.repeat(43)}` } : {}) };
  const res = mockRes();
  await handler({ method, headers, url, body: body === undefined ? undefined : JSON.stringify(body), rawBody: body === undefined ? undefined : JSON.stringify(body), socket: {} }, res);
  return res;
}
const block = (issue) => JSON.parse(/```json\n([\s\S]*?)\n```/.exec(issue.body)[1]);

test('the maintainers are MAINTAINER_MEMBER_IDS: ids, with or without m-', () => {
  assert.deepEqual([...maintainerIds()], ['ab738d332e', '0000000001']);
  assert.deepEqual([...maintainerIds({ MAINTAINER_MEMBER_IDS: '' })], []);
  assert.deepEqual([...maintainerIds({ MAINTAINER_MEMBER_IDS: 'nope, ab738d332e' })], ['ab738d332e']);
});

test('anyone else gets 403 and no detail: no sign-in, another member, no assertion', async () => {
  for (const r of [
    await call({ method: 'GET', auth: false }),
    await call({ auth: false, body: { title: 'Smoke' } }),
    await call({ method: 'GET', who: OTHER }),
    await call({ who: OTHER, body: { title: 'Smoke' } }),
    await call({ who: OTHER, url: '/api/maintainer/test-books/test-smoke/remove', body: {} }),
  ]) {
    assert.equal(r.statusCode, 403);
    assert.deepEqual(r.payload, { error: 'forbidden' });
  }
  // An assertion the author site doesn't vouch for: refused before anything happens.
  assert.equal((await call({ method: 'GET', who: null })).statusCode, 401);
  assert.equal(gh.issues.length, 0);
});

test('the maintainer is told so', async () => {
  const r = await call({ method: 'GET' });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.payload, { is_maintainer: true });
});

test('slugs: test- + the title, forced, at most 40 characters', () => {
  assert.equal(testSlug('Smoke'), 'test-smoke');
  assert.equal(testSlug('Anything', 'my-book'), 'test-my-book');
  assert.equal(testSlug('Anything', 'test-mine'), 'test-mine');
  assert.equal(testSlug('A very long title that goes on and on and on and on'), 'test-a-very-long-title-that-goes-on-and');
  assert.ok(testSlug('x'.repeat(80)).length <= 40);
  assert.equal(testSlug('Anything', 'Bad Slug!'), null);
  assert.equal(testSlug('!!!'), null);
});

test('making one files a request as the form does, sandbox: true, labelled maintainer + approved in the same call', async () => {
  gh.issues.length = 0;
  const r = await call({ body: { title: 'Smoke', content_type: 'paper' } });
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.equal(r.payload.slug, 'test-smoke');
  assert.equal(r.payload.issue.number, 1);
  const [issue] = gh.issues;
  assert.deepEqual(issue.labels.map((l) => l.name).sort(), ['approved', 'book-request', 'maintainer', 'needs-review']);
  const b = block(issue);
  assert.equal(b.slug, 'test-smoke');
  assert.equal(b.sandbox, true);
  assert.equal(b.type, 'paper');
  assert.equal(b.email, null);
  assert.equal(b.maintainer_github, null);
  assert.deepEqual(b.authors, ['Alec Gordon']);
  assert.equal(b.requested_by_member, 'm-ab738d332e');
});

test('a file in parts: stored, then committed with the request', async () => {
  gh.issues.length = 0;
  const docx = Buffer.concat([Buffer.from('PK\x03\x04', 'binary'), Buffer.alloc(200)]).toString('base64');
  const part = await call({ body: { part: docx } });
  assert.equal(part.statusCode, 201);
  const r = await call({ body: { title: 'With a Word file', files: [{ name: 'Chapter 1.docx', parts: [part.payload.sha] }] } });
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.deepEqual(block(gh.issues[0]).manuscript, [`requests/${block(gh.issues[0]).reference}/Chapter 1.docx`]);
  const bad = await call({ body: { title: 'Bad file', files: [{ name: 'notes.pdf', parts: [part.payload.sha] }] } });
  assert.equal(bad.statusCode, 400);
});

test('a slug any registry entry has, or a test book still being set up has, is refused', async () => {
  gh.issues.length = 0;
  gh.live = { books: [{ slug: 'test-taken', sandbox: true }] };
  assert.equal((await call({ body: { title: 'Taken' } })).statusCode, 409);
  gh.live = null;
  assert.equal((await call({ body: { title: 'Twice' } })).statusCode, 201);
  const again = await call({ body: { title: 'Twice' } });
  assert.equal(again.statusCode, 409);
  assert.match(again.payload.userMessage, /already taken/);
});

test('removing: only a registry entry with sandbox: true; then the remove label on its issue', async () => {
  gh.issues.length = 0;
  await call({ body: { title: 'Smoke' } });
  // Not in the registry yet.
  assert.equal((await call({ url: '/api/maintainer/test-books/test-smoke/remove', body: {} })).statusCode, 404);
  // A real book is refused, whatever its slug.
  const real = BUNDLE.registry.books.find((b) => b.sandbox !== true && b.status === 'live').slug;
  const refused = await call({ url: `/api/maintainer/test-books/${real}/remove`, body: {} });
  assert.equal(refused.statusCode, 403);
  assert.equal(refused.payload.error, 'not a test book');
  gh.live = { books: [{ slug: 'test-real-looking', status: 'live' }] };
  assert.equal((await call({ url: '/api/maintainer/test-books/test-real-looking/remove', body: {} })).statusCode, 403);
  // In the registry as a sandbox book: labelled.
  gh.live = { books: [{ slug: 'test-smoke', sandbox: true }] };
  const r = await call({ url: '/api/maintainer/test-books/test-smoke/remove', body: {} });
  gh.live = null;
  assert.equal(r.statusCode, 202, JSON.stringify(r.payload));
  assert.ok(gh.issues[0].labels.some((l) => l.name === 'remove'));
});

test('the public form can never make a sandbox book: a sandbox field is dropped', () => {
  const v = validate({
    title: 'Soil Ecology', authors: 'Ada', email: 'ada@example.com', summary: 'An open textbook on soil ecology for students.',
    agreeLicence: true, sandbox: true, requested_by_member: 'm-ab738d332e', labels: ['approved', 'maintainer'],
  });
  assert.equal(v.ok, true);
  assert.equal('sandbox' in v.data, false);
  const body = buildIssueBody('2026-11-12-abc', { ...v.data, sandbox: true }, { slug: 'soil-ecology', committed: false });
  const b = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(body)[1]);
  assert.equal(b.sandbox, false);
  assert.equal('requested_by_member' in b, false);
});
