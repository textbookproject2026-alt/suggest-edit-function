/**
 * /api/request-book, against an in-memory GitHub. Run with `npm test`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

for (const name of ['GITHUB_APP_ID', 'GITHUB_APP_INSTALLATION_ID', 'GITHUB_APP_PRIVATE_KEY']) delete process.env[name];
process.env.BOT_TOKEN = 'test-token';
delete process.env.REQUESTS_REPO;

const { default: BUNDLE } = await import('../registry/bundled.mjs');
const PORTAL = `https://${BUNDLE.registry.platform.portal.domain}`;
const REPO = 'textbookproject2026-alt/book-requests';

const gh = { calls: [], issues: [], trees: [], failBlobs: false };
const json = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  const method = opts.method ?? 'GET';
  const body = opts.body ? JSON.parse(opts.body) : undefined;
  gh.calls.push({ method, url, body });
  const api = `https://api.github.com/repos/${REPO}`;
  if (!url.startsWith(api)) throw new Error(`unexpected ${method} ${url}`);
  const rest = url.slice(api.length);
  if (rest === '/git/blobs') return gh.failBlobs ? json(500, {}) : json(201, { sha: `blob${gh.calls.length}` });
  if (rest === '/git/ref/heads/main') return json(200, { object: { sha: 'p'.repeat(40) } });
  if (rest.startsWith('/git/commits/')) return json(200, { tree: { sha: 't'.repeat(40) } });
  if (rest === '/git/trees') { gh.trees.push(body); return json(201, { sha: 'n'.repeat(40) }); }
  if (rest === '/git/commits') return json(201, { sha: 'c'.repeat(40) });
  if (rest === '/git/refs/heads/main') return json(200, {});
  if (rest === '/issues') { gh.issues.push(body); return json(201, { html_url: `https://github.com/${REPO}/issues/1` }); }
  return json(200, {}); // labels exist
};

const { default: handler, proposeSlug } = await import('../api/request-book.js');

let ip = 0;
async function call({ body, origin = PORTAL, method = 'POST', contentType = 'application/json' } = {}) {
  gh.issues.length = 0; gh.trees.length = 0;
  const headers = { 'x-forwarded-for': `10.9.0.${++ip}` };
  if (origin) headers.origin = origin;
  if (contentType) headers['content-type'] = contentType;
  const res = {
    headers: {}, statusCode: 0, payload: undefined, ended: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, status(c) { this.statusCode = c; return this; },
    json(p) { this.payload = p; this.ended = true; }, end() { this.ended = true; }, get headersSent() { return this.ended; },
  };
  await handler({ method, headers, body, socket: {} }, res);
  return res;
}

const DOCX = Buffer.concat([Buffer.from('PK\x03\x04', 'binary'), Buffer.alloc(100)]).toString('base64');
const VALID = {
  title: 'Soil Ecology: An Introduction',
  authors: 'Ada Lovelace, Mary Somerville',
  email: 'ada@example.com',
  summary: 'An open textbook on soil ecology for first-year students.',
  topic: 'Ecology',
  agreeLicence: true,
  files: [{ name: 'Chapter 1.docx', data: DOCX }],
};

test('only the portal may call it', async () => {
  assert.equal((await call({ body: VALID, origin: 'https://social-research-methods.confused4now.org' })).statusCode, 403);
  assert.equal((await call({ body: VALID, origin: null })).statusCode, 403);
  const pre = await call({ method: 'OPTIONS' });
  assert.equal(pre.statusCode, 204);
  assert.equal(pre.headers['access-control-allow-origin'], PORTAL);
  assert.equal((await call({ method: 'OPTIONS', origin: 'https://abc.textbook-portal.pages.dev' })).statusCode, 204);
});

test('a valid request commits the files and files a private issue', async () => {
  const r = await call({ body: VALID });
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.match(r.payload.reference, /^\d{4}-\d{2}-\d{2}-[a-z0-9]+$/);
  assert.equal(gh.trees[0].tree[0].path, `requests/${r.payload.reference}/Chapter 1.docx`);
  const issue = gh.issues[0];
  assert.deepEqual(issue.labels, ['book-request', 'needs-review']);
  const block = JSON.parse(issue.body.match(/```json\n([\s\S]*?)\n```/)[1]);
  assert.equal(block.slug, 'soil-ecology-an-introduction');
  assert.deepEqual(block.authors, ['Ada Lovelace', 'Mary Somerville']);
  assert.equal(block.email, 'ada@example.com');
  assert.equal(block.status, 'live');
  assert.equal(block.sandbox, false);
  assert.deepEqual(block.manuscript, [`requests/${r.payload.reference}/Chapter 1.docx`]);
});

test('a failed upload still files the request, and says so', async () => {
  gh.failBlobs = true;
  try {
    const r = await call({ body: VALID });
    assert.equal(r.statusCode, 201);
    assert.match(r.payload.userMessage, /files didn't/);
    assert.match(gh.issues[0].body, /The files did not arrive/);
    assert.deepEqual(JSON.parse(gh.issues[0].body.match(/```json\n([\s\S]*?)\n```/)[1]).manuscript, []);
  } finally { gh.failBlobs = false; }
});

test('validation', async () => {
  const bad = async (patch, re) => {
    const r = await call({ body: { ...VALID, ...patch } });
    assert.equal(r.statusCode, 400, JSON.stringify(patch));
    assert.match(r.payload.userMessage, re);
  };
  await bad({ agreeLicence: false }, /CC BY-SA/);
  await bad({ email: 'nope' }, /email/);
  await bad({ summary: 'short' }, /describe/);
  await bad({ github: 'not a login!' }, /GitHub username/);
  await bad({ manuscriptLink: 'http://x.example/a' }, /https/);
  await bad({ files: [{ name: 'a.pdf', data: DOCX }] }, /\.docx/);
  await bad({ files: [{ name: 'a.docx', data: Buffer.from('hello').toString('base64') }] }, /Word document/);
  await bad({ files: Array.from({ length: 6 }, (_, i) => ({ name: `${i}.md`, data: 'aGk=' })) }, /at most 5/);
  const big = Buffer.alloc(3 * 1024 * 1024 + 1, 97).toString('base64');
  await bad({ files: [{ name: 'a.md', data: big }] }, /3 MB/);
});

test('the honeypot answers success and files nothing', async () => {
  const r = await call({ body: { ...VALID, website: 'x' } });
  assert.equal(r.statusCode, 201);
  assert.equal(gh.issues.length, 0);
});

test('the proposed slug avoids registered slugs and reserved words', () => {
  const reg = { books: [{ slug: 'platform-test-book' }] };
  assert.equal(proposeSlug('Platform Test Book', reg), 'platform-test-book-2');
  assert.equal(proposeSlug('API', reg), 'book-api');
  assert.equal(proposeSlug('Économie politique', reg), 'economie-politique');
});
