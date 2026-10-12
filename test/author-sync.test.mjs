/**
 * author-sync's handler against the in-memory GitHub: in sync costs one small
 * GraphQL query; out of sync reads main in one query and commits the text inline.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createFakeGitHub } from './fake-github.mjs';

const { privateKey: PEM } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
delete process.env.GITHUB_APP_INSTALLATION_ID;
delete process.env.BOT_TOKEN;
Object.assign(process.env, { GITHUB_APP_ID: '123456', GITHUB_APP_PRIVATE_KEY: Buffer.from(PEM).toString('base64') });

const gh = createFakeGitHub();
const { default: BUNDLE } = await import('../registry/bundled.mjs');
const { REGISTRY_REPO } = await import('../lib/author-people.mjs');
const { default: sync } = await import('../author/author-sync.js');

const book = BUNDLE.registry.books.find((b) => b.status === 'live' && b.members?.length);
const TEXT = `${JSON.stringify(BUNDLE.registry, null, 2)}\n`;
gh.commitFiles(REGISTRY_REPO, 'main', { 'registry.json': TEXT }, { message: 'registry' });
let members = { members: book.members, github: book.authors ?? [], mentionsOff: book.mentions_off ?? [] };
const graphql = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(String(url));
  if (u.pathname === '/api/internal/members') return new Response(JSON.stringify(members), { status: 200 });
  if (u.pathname === '/graphql') {
    const body = JSON.parse(opts.body);
    graphql.push(body.query);
    if (body.query.includes('headRefName')) return new Response(JSON.stringify({ data: { repository: { pullRequests: { nodes: [] } } } }));
    if (body.query.includes('registry.json')) {
      const r = gh.repo(REGISTRY_REPO);
      const head = r.refs.get('main');
      return new Response(JSON.stringify({ data: { repository: { ref: { target: { oid: head, tree: { oid: r.commits.get(head).tree }, file: { object: { text: TEXT } } } } } } }));
    }
  }
  return gh.fetch(url, opts);
};
const call = async (body) => {
  const res = { statusCode: 0, payload: null, headers: {}, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(p) { this.payload = p; return this; }, end() { return this; } };
  await sync({ method: 'POST', url: '/api/author-sync', headers: {}, body }, res);
  return res;
};
const repoCalls = () => gh.state.calls.filter((c) => c.url.includes(REGISTRY_REPO) && !c.url.endsWith('/installation'));

test('author-sync: in sync is one small query (no pull request list, no registry read)', async (t) => {
  if (!book) return t.skip('no live book with members in the bundle');
  const res = await call({ book: book.slug });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload, { inSync: true });
  assert.equal(graphql.length, 1);
  assert.deepEqual(repoCalls().map((c) => c.url), [], 'only the installation token');
});

test('author-sync: out of sync reads main in one query and commits the text inline (no blob)', async (t) => {
  if (!book) return t.skip('no live book with members in the bundle');
  graphql.length = 0;
  members = { ...members, members: [...book.members, { id: 'm-0123456789', name: 'New Person' }] };
  const res = await call({ book: book.slug });
  assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
  assert.equal(typeof res.payload.number, 'number');
  assert.equal(graphql.filter((q) => q.includes('registry.json')).length, 1);
  const calls = repoCalls().map((c) => `${c.method} ${new URL(c.url).pathname.replace(`/repos/${REGISTRY_REPO}`, '')}`);
  assert.ok(!calls.some((c) => c.includes('/git/blobs')), calls.join(', '));
  const tree = repoCalls().find((c) => c.url.endsWith('/git/trees'));
  assert.match(tree.body.tree[0].content, /New Person/);
});
