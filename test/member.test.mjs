// Members signed in by email on the author site (batch 2b): the request binding, the
// read-back of a single-use assertion, what a member may reach, and how their work
// is attributed. The author site's answer is stubbed at fetch; the function's own
// code (authorise, booksFor, commitAuthor, byline) runs as shipped.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUTHOR_SITE_ORIGIN, bindingOf, bookOfRequest, canonicalQuery, notifyAuthors } from '../lib/member.mjs';
import { withBookPeople, membersOf } from '../author/author-sync.js';

const { authorise, booksFor, commitAuthor, byline } = await import('../lib/author.mjs');
const { default: BUNDLE } = await import('../registry/bundled.mjs');

const BOOK = BUNDLE.registry.books.find((b) => b.status !== 'retired' && b.slug === 'platform-test-book');
const OTHER = BUNDLE.registry.books.find((b) => b.status !== 'retired' && b.slug !== BOOK.slug);
const ID = 'A'.repeat(43);

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

/** The author site's read-back, as stubbed: answers only for `want` (the binding). */
function authorSite(want, answer) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), body: opts.body ? JSON.parse(opts.body) : null });
    if (String(url) !== `${AUTHOR_SITE_ORIGIN}/api/internal/assertion`) throw new Error(`unexpected ${url}`);
    const { id, binding } = JSON.parse(opts.body);
    if (id !== ID || binding !== want) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => answer };
  };
  return { calls, restore: () => (globalThis.fetch = real) };
}

const req = ({ method = 'GET', url, body }) => ({
  method,
  url,
  headers: { origin: AUTHOR_SITE_ORIGIN, authorization: `Member ${ID}` },
  body,
});

test('the binding: method, endpoint, query (sorted, without route), body and book', () => {
  const params = new URLSearchParams('what=tree&book=b&route=read');
  assert.equal(canonicalQuery(params), 'book=b&what=tree');
  const a = bindingOf({ method: 'GET', endpoint: 'author-read', params, bodyText: '', book: 'b' });
  assert.equal(a, bindingOf({ method: 'GET', endpoint: 'author-read', params: new URLSearchParams('book=b&what=tree'), bodyText: '', book: 'b' }));
  for (const other of [
    { method: 'POST', endpoint: 'author-read', params, bodyText: '', book: 'b' },
    { method: 'GET', endpoint: 'author-act', params, bodyText: '', book: 'b' },
    { method: 'GET', endpoint: 'author-read', params: new URLSearchParams('book=b&what=file'), bodyText: '', book: 'b' },
    { method: 'GET', endpoint: 'author-read', params, bodyText: '{}', book: 'b' },
    { method: 'GET', endpoint: 'author-read', params, bodyText: '', book: 'c' },
  ]) assert.notEqual(bindingOf(other), a);
  assert.equal(bookOfRequest('GET', new URLSearchParams('book=x'), null), 'x');
  assert.equal(bookOfRequest('POST', new URLSearchParams('book=x'), { book: 'y' }), 'y');
  assert.equal(bookOfRequest('POST', new URLSearchParams(), { book: 5 }), '');
});

test('a member assertion read back for this exact request: the member, on the asserted book only', async () => {
  const body = { book: BOOK.slug, action: 'publish-prepare' };
  const want = bindingOf({ method: 'POST', endpoint: 'author-act', params: new URLSearchParams('route=act'), bodyText: JSON.stringify(body), book: BOOK.slug });
  const site = authorSite(want, { member: { id: '0a1b2c3d4e', name: 'Mo Member', github: null }, book: BOOK.slug, books: [BOOK.slug] });
  try {
    const res = mockRes();
    const auth = await authorise(req({ method: 'POST', url: '/api/author?route=act', body }), res, 'POST');
    assert.ok(auth, JSON.stringify(res.payload));
    assert.equal(auth.identity.login, 'm-0a1b2c3d4e');
    assert.deepEqual(booksFor(auth.identity).map((b) => b.slug), [BOOK.slug]);
    assert.deepEqual(commitAuthor(auth.identity), { name: 'Mo Member', email: 'm-0a1b2c3d4e@users.noreply.confused4now.org' });
    assert.equal(byline(auth.identity), 'by Mo Member (member m-0a1b2c3d4e) via the author site');
    assert.deepEqual(site.calls.map((c) => c.url), [`${AUTHOR_SITE_ORIGIN}/api/internal/assertion`]);
    assert.deepEqual(site.calls[0].body, { id: ID, binding: want });
  } finally {
    site.restore();
  }
});

test('refused: another request than the one asserted, another book, no read-back, a Bearer-less garble', async () => {
  const body = { book: BOOK.slug, action: 'publish' };
  const asserted = bindingOf({ method: 'POST', endpoint: 'author-act', params: new URLSearchParams(), bodyText: JSON.stringify({ book: BOOK.slug, action: 'publish-prepare' }), book: BOOK.slug });
  const site = authorSite(asserted, { member: { id: '0a1b2c3d4e', name: 'Mo', github: null }, book: BOOK.slug, books: [BOOK.slug] });
  try {
    // The body differs from the asserted one (publish, not publish-prepare).
    let res = mockRes();
    assert.equal(await authorise(req({ method: 'POST', url: '/api/author-act', body }), res, 'POST'), null);
    assert.equal(res.statusCode, 401);
    // The author site answers for one book, the request names another.
    const otherBody = { book: OTHER.slug, action: 'publish-prepare' };
    site.restore();
    const w = bindingOf({ method: 'POST', endpoint: 'author-act', params: new URLSearchParams(), bodyText: JSON.stringify(otherBody), book: OTHER.slug });
    const s2 = authorSite(w, { member: { id: '0a1b2c3d4e', name: 'Mo', github: null }, book: BOOK.slug, books: [BOOK.slug] });
    res = mockRes();
    assert.equal(await authorise(req({ method: 'POST', url: '/api/author-act', body: otherBody }), res, 'POST'), null);
    assert.equal(res.statusCode, 401);
    s2.restore();
    // A malformed id is never even sent.
    const s3 = authorSite('x', {});
    res = mockRes();
    const bad = { ...req({ url: '/api/author-read?what=books' }), headers: { origin: AUTHOR_SITE_ORIGIN, authorization: 'Member ../../evil' } };
    assert.equal(await authorise(bad, res, 'GET'), null);
    assert.equal(s3.calls.length, 0);
    s3.restore();
  } finally {
    site.restore();
  }
});

test('the registry keeps a book\'s people on one line each; nothing else changes', () => {
  const reg = structuredClone(BUNDLE.registry);
  const text = `${JSON.stringify(reg, null, 2).replace(/"(authors|mentions_off)": \[\s*([^\]]*?)\s*\]/g, (_, k, l) => `"${k}": [${l.split(/,\s*/).filter(Boolean).join(', ')}]`)}\n`;
  const people = { authors: ['textbookproject2026-alt'], members: [{ id: 'm-0a1b2c3d4e', name: 'Alec Gordon' }], mentionsOff: [] };
  const out = withBookPeople(text, JSON.parse(text), BOOK.slug, people);
  const parsed = JSON.parse(out);
  const b = parsed.books.find((x) => x.slug === BOOK.slug);
  assert.deepEqual([b.authors, b.members, b.mentions_off], [people.authors, people.members, []]);
  assert.match(out, /"members": \[\{ "id": "m-0a1b2c3d4e", "name": "Alec Gordon" \}\]/);
  assert.equal(out.split('\n').length - text.split('\n').length, (BOOK.mentions_off ? 0 : 1) + 1);
});

test('the author site\'s member list is taken for ids, names and logins only', async () => {
  const fake = async () => ({ ok: true, json: async () => ({
    members: [{ id: 'm-0a1b2c3d4e', name: 'Ann', email: 'ann@example.org' }, { id: 'nope', name: 'X' }, { id: 'm-1111111111', name: 'a@b.c' }, { id: 'm-2222222222', name: 'Bo\u202Eb\u200B  Lee\n' }, { id: 'm-3333333333', name: '\u200B' }],
    github: ['ann-gh', 'bad login!'], mentionsOff: [],
  }) });
  assert.deepEqual(await membersOf('platform-test-book', fake), { members: [{ id: 'm-0a1b2c3d4e', name: 'Ann' }, { id: 'm-2222222222', name: 'Bob Lee' }], authors: ['ann-gh'], mentionsOff: [] });
});

test('notify: the book and the number only, to the hard-coded author site', async () => {
  const calls = [];
  await notifyAuthors('b', 'https://github.com/o/r/issues/12', async (url, opts) => calls.push([url, JSON.parse(opts.body)]));
  await notifyAuthors('b', 'https://github.com/o/r/pull/7', async (url, opts) => calls.push([url, JSON.parse(opts.body)]));
  await notifyAuthors('b', 'nonsense', async () => calls.push('no'));
  assert.deepEqual(calls, [[`${AUTHOR_SITE_ORIGIN}/api/internal/notify`, { book: 'b', number: 12 }], [`${AUTHOR_SITE_ORIGIN}/api/internal/notify`, { book: 'b', number: 7 }]]);
});
