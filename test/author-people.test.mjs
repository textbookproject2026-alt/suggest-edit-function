/**
 * The People panel's endpoints (api/author-people.js, api/author-people-change.js)
 * against the in-memory GitHub (test/fake-github.mjs): a change to a book's authors is
 * a registry pull request with auto-merge, and it stays pending until this function's
 * registry includes its merge. Run with `npm test`.
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
const { withAuthors, outcome, PLATFORM_OWNER, REGISTRY_REPO, STALLED_MS } = await import('../lib/author-people.mjs');
const { default: peopleEp } = await import('../author/author-people.js');
const { default: changeEp } = await import('../author/author-people-change.js');

const PAGE = BUNDLE.registry.platform.pages.find((p) => p.services.includes('author-api'));
const ORIGIN = `https://${PAGE.domain}`;
const SLUG = 'ontology-for-social-research-a-criti';
const BOOK = BUNDLE.registry.books.find((b) => b.slug === SLUG);
const AUTHOR = { login: 'BrandonAndCaroline', id: 777, name: 'Brandon' };
const STRANGER = { login: 'someone-else', id: 999, name: 'Someone' };

// registry.json as the registry writes it: two-space JSON, each `authors` on one line.
const registryText = (reg) => `${JSON.stringify(reg, null, 2).replace(/"authors": \[\s*([^\]]*?)\s*\]/g, (_, list) => `"authors": [${list.split(/,\s*/).join(', ')}]`)}\n`;
function resetRegistry(edit = () => {}) {
  const reg = structuredClone(BUNDLE.registry);
  edit(reg);
  gh.repo(REGISTRY_REPO).refs.clear();
  gh.repo(REGISTRY_REPO).pulls.clear();
  gh.commitFiles(REGISTRY_REPO, 'main', { 'registry.json': registryText(reg), 'README.md': 'registry\n' }, { message: 'registry' });
  gh.state.autoMerge.length = 0;
  gh.state.clock = Date.now(); // merges happen now, as far as "recent" goes
  gh.state.hooks = {};
}
gh.state.users.set('newperson', { login: 'NewPerson', id: 4242, type: 'User' });
gh.state.users.set('some-org', { login: 'some-org', id: 5, type: 'Organization' });

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
async function call(handler, { method = 'POST', url = '/', body, who = AUTHOR } = {}) {
  const headers = { origin: ORIGIN, 'content-type': 'application/json', authorization: `Bearer ${issueIdentity(process.env.IDENTITY_SECRET, who, ORIGIN)}` };
  const res = mockRes();
  await handler({ method, headers, url, body, socket: {} }, res);
  return res;
}
const list = (who) => call(peopleEp, { method: 'GET', url: `/api/author-people?book=${SLUG}`, who });
const change = (action, login, who) => call(changeEp, { body: { book: SLUG, action, login }, who });
const registryOn = (ref) => JSON.parse(gh.textAt(REGISTRY_REPO, gh.repo(REGISTRY_REPO).refs.get(ref), 'registry.json'));
const merge = (n) => gh.fetch(`https://api.github.com/repos/${REGISTRY_REPO}/pulls/${n}/merge`, { method: 'PUT', body: JSON.stringify({ merge_method: 'squash', commit_title: 'x' }) });

test('the panel: who has access now, from the registry this function runs, for the book\'s authors only', async () => {
  resetRegistry();
  const r = await list();
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.payload, { authors: BOOK.authors, owner: PLATFORM_OWNER, registry: BUNDLE.sha, pending: [] });
  assert.equal(r.headers['x-registry-version'], BUNDLE.sha);
  assert.equal((await list(STRANGER)).statusCode, 403);
  assert.equal((await change('add', 'NewPerson', STRANGER)).statusCode, 403);
});

test('invite: a registry pull request changing only this book\'s authors line, by the inviter, @-mentioning the invitee, with auto-merge', async () => {
  resetRegistry();
  const before = gh.textAt(REGISTRY_REPO, gh.repo(REGISTRY_REPO).refs.get('main'), 'registry.json');
  const r = await change('add', '@newperson');
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.equal(r.payload.login, 'NewPerson', 'the account\'s own case, as github-facts requires');
  assert.equal(r.payload.state, 'open');
  assert.equal(r.payload.warning, undefined);

  const pr = gh.repo(REGISTRY_REPO).pulls.get(r.payload.number);
  assert.match(pr.head.ref, new RegExp(`^people/${SLUG}/add-NewPerson-\\d+$`));
  assert.equal(pr.base.ref, 'main');
  assert.match(pr.body, /^@NewPerson: you've been invited/);
  assert.match(pr.body, /sign in at https:\/\/author\.confused4now\.org/);
  assert.match(pr.body, /Added by @BrandonAndCaroline via the author site\./);
  assert.deepEqual(gh.state.autoMerge, [{ id: pr.node_id, method: 'SQUASH' }]);

  const after = gh.textAt(REGISTRY_REPO, gh.repo(REGISTRY_REPO).refs.get(pr.head.ref), 'registry.json');
  const changed = after.split('\n').filter((l, i) => l !== before.split('\n')[i]);
  assert.deepEqual(changed, ['      "authors": ["BrandonAndCaroline", "textbookproject2026-alt", "NewPerson"],']);
  const commit = gh.repo(REGISTRY_REPO).commits.get(gh.repo(REGISTRY_REPO).refs.get(pr.head.ref));
  assert.match(commit.message, /add NewPerson to authors \(by @BrandonAndCaroline via the author site\)/);
  assert.match(commit.author.email, /777\+BrandonAndCaroline@users\.noreply\.github\.com/);
  assert.deepEqual(registryOn('main'), BUNDLE.registry, 'main untouched: nothing lands without the checks');

  // Pending while open; one change per book at a time.
  assert.deepEqual((await list()).payload.pending.map((c) => [c.action, c.login, c.by, c.state]), [['add', 'NewPerson', 'BrandonAndCaroline', 'open']]);
  assert.equal((await change('remove', 'BrandonAndCaroline')).statusCode, 409);

  // Merged but not in this function's registry yet: still pending. Live: gone.
  await merge(r.payload.number);
  assert.deepEqual((await list()).payload.pending.map((c) => c.state), ['merged']);
  gh.state.hooks[`/compare/`] = () => ({ ok: true, status: 200, json: async () => ({ behind_by: 0, ahead_by: 1 }) });
  assert.deepEqual((await list()).payload.pending, []);
});

test('invite refused: not a username, no such account, an organisation, already an author (any case)', async () => {
  resetRegistry();
  for (const [login, status, words] of [
    ['-bad-', 400, /isn't a GitHub username/],
    ['nobody-here', 404, /no GitHub account called “nobody-here”/],
    ['some-org', 400, /organization, and only a person can sign in/],
    ['textbookproject2026-ALT', 409, /already one of this book's authors/],
  ]) {
    const r = await change('add', login);
    assert.equal(r.statusCode, status, login);
    assert.match(r.payload.userMessage, words, login);
  }
  assert.equal(gh.repo(REGISTRY_REPO).pulls.size, 0);
});

test('remove: never the platform owner, never the last author; otherwise the same kind of pull request, without a mention', async () => {
  resetRegistry();
  const owner = await change('remove', PLATFORM_OWNER);
  assert.equal(owner.statusCode, 403);
  assert.match(owner.payload.userMessage, /author of every book/);

  resetRegistry((reg) => { reg.books.find((b) => b.slug === SLUG).authors = ['BrandonAndCaroline']; });
  const last = await change('remove', 'brandonandcaroline');
  assert.equal(last.statusCode, 409);
  assert.match(last.payload.userMessage, /only author/);

  resetRegistry((reg) => { reg.books.find((b) => b.slug === SLUG).authors.push('NewPerson'); });
  const r = await change('remove', 'newperson');
  assert.equal(r.statusCode, 201);
  const pr = gh.repo(REGISTRY_REPO).pulls.get(r.payload.number);
  assert.doesNotMatch(pr.body, /@NewPerson/, 'a removal notifies nobody');
  assert.match(pr.body, /Removed by @BrandonAndCaroline via the author site\./);
  assert.deepEqual(registryOn(pr.head.ref).books.find((b) => b.slug === SLUG).authors, ['BrandonAndCaroline', 'textbookproject2026-alt']);
});

test('auto-merge refused by GitHub: the pull request stands, and the author is told who merges it', async () => {
  resetRegistry();
  gh.state.hooks['/graphql'] = () => ({ ok: true, status: 200, json: async () => ({ errors: [{ message: 'Auto merge is not allowed for this repository' }] }) });
  const r = await change('add', 'NewPerson');
  assert.equal(r.statusCode, 201);
  assert.match(r.payload.warning, /technical contact to merge it/);
});

test('a failed change shows as failed, with the registry\'s reasons, and the next change closes it', async () => {
  resetRegistry();
  // Made as the endpoint makes one (directly: the endpoint's per-login limit is spent by now).
  gh.repo(REGISTRY_REPO).refs.set(`people/${SLUG}/add-NewPerson-1`, gh.repo(REGISTRY_REPO).refs.get('main'));
  const pr = gh.repo(REGISTRY_REPO).pulls.get(gh.addPull(REGISTRY_REPO, { head: `people/${SLUG}/add-NewPerson-1`, base: 'main', title: 'add' }));
  pr.body = 'Added by @textbookproject2026-alt via the author site.\n\n<!-- people-outcome -->\n**This change did not go through.** Nothing changed.\n- platform-test-book authors: there is no GitHub account called NewPerson';
  const failed = (await list()).payload.pending;
  assert.deepEqual(failed.map((c) => [c.state, c.reasons]), [['failed', ['platform-test-book authors: there is no GitHub account called NewPerson']]]);

  // Not "in progress": the next change goes ahead, and the failed one is closed, saying why.
  const next = await change('remove', 'BrandonAndCaroline');
  assert.equal(next.statusCode, 201, JSON.stringify(next.payload));
  assert.equal(pr.state, 'closed');
  assert.match(pr.comments.at(-1), /didn't go through, and @BrandonAndCaroline has made another change/);
  assert.deepEqual((await list()).payload.pending.map((c) => [c.number, c.state]), [[next.payload.number, 'open']]);
});

test('outcome: open, recorded failure, stalled past the hour, merged', () => {
  const now = Date.parse('2026-10-06T12:00:00Z');
  const at = (ms) => new Date(now - ms).toISOString();
  assert.deepEqual(outcome({ created_at: at(60_000), body: 'x' }, now), { state: 'open' });
  assert.deepEqual(outcome({ created_at: at(60_000), body: 'x\n<!-- people-outcome -->\nno list' }, now).reasons, ["the platform's checks refused it"]);
  assert.equal(outcome({ created_at: at(STALLED_MS + 1), body: 'x' }, now).state, 'failed');
  assert.deepEqual(outcome({ created_at: at(STALLED_MS + 1), merged_at: at(5), body: '' }, now), { state: 'merged' });
});

test('withAuthors rewrites one line in the file\'s own style, and refuses a book with no authors line', () => {
  const reg = structuredClone(BUNDLE.registry);
  const text = registryText(reg);
  const out = withAuthors(text, reg, 'platform-test-book', ['textbookproject2026-alt', 'NewPerson']);
  assert.equal(out.split('\n').length, text.split('\n').length);
  assert.match(out, /"authors": \["textbookproject2026-alt", "NewPerson"\]/);
  assert.throws(() => withAuthors(text, reg, 'social-research-methods', ['x']), (e) => /can't be changed from here/.test(e.userMessage));
});

test('rate-limited per login', async () => {
  resetRegistry();
  const who = { login: 'textbookproject2026-alt', id: 1, name: 'Owner' };
  const codes = [];
  for (let i = 0; i < 11; i++) codes.push((await change('add', 'nobody-here', who)).statusCode);
  assert.deepEqual(codes, [...Array(10).fill(404), 429]);
});
