/**
 * POST /api/author-sync { book } — brings the registry's public record of a book's
 * people in line with the author site (batch 2b). Who is on a book, and access, live
 * in the author site's database; the registry keeps `members` (member ids and display
 * names, never emails), `authors` (the GitHub logins still linked) and `mentions_off`.
 *
 * No sign-in and no secret: it reads the author site's public member list
 * (AUTHOR_SITE_ORIGIN/api/internal/members) and writes only that, so a call can do
 * nothing but sync the truth. It keeps one pull request per book (branch
 * people/<slug>/sync), updated in place, which merges itself on green. A slow or
 * failed sync never affects access. Rate-limited per book and overall.
 *
 *   -> 200 { inSync: true } | { number, url, updated: boolean }
 */
import { isDeepStrictEqual } from 'node:util';
import { REGISTRY, Refusal, appCredentials, budget, encodePath, fail, gh, ghJson } from '../lib/author.mjs';
import { createRateLimiter, parseBody, send } from '../lib/common.mjs';
import { REGISTRY_REPO, registryCredential } from '../lib/author-people.mjs';
import { AUTHOR_SITE_ORIGIN } from '../lib/member.mjs';

const appToken = appCredentials({ contents: 'write', pull_requests: 'write' });
const perBook = createRateLimiter(20, 60 * 60 * 1000);
const overall = createRateLimiter(100, 60 * 60 * 1000);
const ID_RE = /^m-[0-9a-f]{10}$/;
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/** The author site's public list for a book, checked hard: ids, names, logins only. */
export async function membersOf(slug, fetchImpl = fetch) {
  const res = await fetchImpl(`${AUTHOR_SITE_ORIGIN}/api/internal/members?book=${encodeURIComponent(slug)}`, { redirect: 'error', signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`members: HTTP ${res.status}`);
  const d = await res.json();
  // Names go into the public registry: cleaned again here (control, bidi and
  // zero-width characters out), whatever the author site already did.
  const clean = (n) => (typeof n === 'string' ? n.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 80) : '');
  const members = (d.members ?? []).map((m) => ({ id: m?.id ?? '', name: clean(m?.name) }))
    .filter((m) => ID_RE.test(m.id) && m.name && !m.name.includes('@'));
  const logins = (list) => [...new Set((list ?? []).filter((l) => typeof l === 'string' && LOGIN_RE.test(l)))];
  return { members, authors: logins(d.github), mentionsOff: logins(d.mentionsOff) };
}

/**
 * The registry's text with one book's authors, members and mentions_off set, each
 * on one line in the file's own style; nothing else changes (checked by parsing).
 */
export function withBookPeople(text, registry, slug, { authors, members, mentionsOff }) {
  const at = text.indexOf(`"slug": ${JSON.stringify(slug)}`);
  if (at < 0) throw new Refusal(404, 'no such book', 'No such book.');
  let out = text;
  const end = () => {
    const n = out.indexOf('"slug":', at + 1);
    return n < 0 ? out.length : n;
  };
  const authorsLine = () => {
    // A list of logins, on one line or spread over several (logins have no "]").
    const re = /^([ \t]*)"authors":\s*\[[^\]]*\]/gm;
    re.lastIndex = at;
    const m = re.exec(out);
    if (!m || m.index > end()) throw new Refusal(409, 'no authors line', "This book's people can't be synced automatically.");
    return m;
  };
  // The end of the JSON array starting at i (strings skipped, so a name may hold "]").
  const arrayEnd = (i) => {
    let depth = 0;
    for (let j = i; j < out.length; j++) {
      const c = out[j];
      if (c === '"') {
        for (j++; out[j] !== '"'; j++) if (out[j] === '\\') j++;
      } else if (c === '[' || c === '{') depth++;
      else if ((c === ']' || c === '}') && --depth === 0) return j + 1;
    }
    return -1;
  };
  const set = (key, value) => {
    const line = `"${key}": ${value}`;
    const re = new RegExp(`"${key}":\\s*\\[`, 'g');
    re.lastIndex = at;
    const m = re.exec(out);
    if (m && m.index < end()) {
      // On one line or spread over several (as JSON.stringify or a hand edit leaves it).
      const close = arrayEnd(m.index + m[0].length - 1);
      out = `${out.slice(0, m.index)}${line}${out.slice(close)}`;
      return;
    }
    const a = authorsLine();
    const after = a.index + a[0].length;
    out = `${out.slice(0, after)},\n${a[1]}${line}${out.slice(after)}`;
  };
  set('authors', `[${authors.map((a) => JSON.stringify(a)).join(', ')}]`);
  set('members', `[${members.map((m) => `{ "id": ${JSON.stringify(m.id)}, "name": ${JSON.stringify(m.name)} }`).join(', ')}]`);
  set('mentions_off', `[${mentionsOff.map((a) => JSON.stringify(a)).join(', ')}]`);
  const expected = structuredClone(registry);
  const book = expected.books.find((b) => b.slug === slug);
  Object.assign(book, { authors, members, mentions_off: mentionsOff });
  if (!isDeepStrictEqual(JSON.parse(out), expected)) throw new Error('people sync changed more than people');
  return out;
}

async function registryAtMain(token, left) {
  const ref = await ghJson(`/repos/${REGISTRY_REPO}/git/ref/heads/main`, token, left);
  const commit = await ghJson(`/repos/${REGISTRY_REPO}/git/commits/${ref.object.sha}`, token, left);
  const tree = await ghJson(`/repos/${REGISTRY_REPO}/git/trees/${commit.tree.sha}`, token, left);
  const entry = (tree?.tree ?? []).find((e) => e.path === 'registry.json');
  const blob = await ghJson(`/repos/${REGISTRY_REPO}/git/blobs/${entry.sha}`, token, left);
  const text = Buffer.from(blob.content.replace(/\s+/g, ''), 'base64').toString('utf8');
  return { head: ref.object.sha, tree: commit.tree.sha, text, registry: JSON.parse(text) };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  let body;
  try {
    body = parseBody(req);
  } catch {
    return send(res, 400, { error: 'bad body' });
  }
  const slug = typeof body.book === 'string' ? body.book : '';
  const book = REGISTRY.books.find((b) => b.slug === slug && b.status !== 'retired');
  if (!book) return send(res, 404, { error: 'no such book' });
  const now = Date.now();
  if (overall('all', now) || perBook(slug, now)) return send(res, 429, { error: 'rate limit exceeded' });
  const tag = `sync book=${slug}`;
  let credential;
  try {
    const left = budget(25_000);
    const people = await membersOf(slug);
    if (!people.members.length) return send(res, 409, { error: 'no members', userMessage: 'The author site lists nobody on this book; nothing synced.' });
    const matches = (entry) => isDeepStrictEqual(entry.members ?? null, people.members)
      && isDeepStrictEqual(entry.authors ?? [], people.authors)
      && isDeepStrictEqual(entry.mentions_off ?? [], people.mentionsOff);
    credential = await registryCredential(appToken, tag);
    const token = credential.token;
    const branch = `people/${slug}/sync`;
    const open = await ghJson(`/repos/${REGISTRY_REPO}/pulls?state=open&head=${encodeURIComponent(`${REGISTRY_REPO.split('/')[0]}:${branch}`)}`, token, left);
    // Anyone can ask for a sync, so the common case costs one GitHub call: the
    // registry this deployment was built with already says this, and no sync pull
    // request is open (one open could carry an older list, so it is always checked).
    if (!open?.length && matches(book)) return send(res, 200, { inSync: true });
    const main = await registryAtMain(token, left);
    const entry = main.registry.books.find((b) => b.slug === slug);
    if (matches(entry)) {
      // Main already says this: a sync pull request still open is out of date.
      for (const pr of open ?? []) await ghJson(`/repos/${REGISTRY_REPO}/pulls/${pr.number}`, token, left, { method: 'PATCH', body: { state: 'closed' } });
      return send(res, 200, { inSync: true });
    }
    const text = withBookPeople(main.text, main.registry, slug, people);
    const blob = await ghJson(`/repos/${REGISTRY_REPO}/git/blobs`, token, left, { method: 'POST', body: { content: text, encoding: 'utf-8' } });
    const tree = await ghJson(`/repos/${REGISTRY_REPO}/git/trees`, token, left, { method: 'POST', body: { base_tree: main.tree, tree: [{ path: 'registry.json', mode: '100644', type: 'blob', sha: blob.sha }] } });
    const subject = `${slug}: people from the author site`;
    const commit = await ghJson(`/repos/${REGISTRY_REPO}/git/commits`, token, left, { method: 'POST', body: { message: subject, tree: tree.sha, parents: [main.head] } });
    const moved = await gh(`/repos/${REGISTRY_REPO}/git/refs/heads/${encodePath(branch)}`, token, left, { method: 'PATCH', body: { sha: commit.sha, force: true }, allow: [404, 422] });
    if (!moved.ok) await ghJson(`/repos/${REGISTRY_REPO}/git/refs`, token, left, { method: 'POST', body: { ref: `refs/heads/${branch}`, sha: commit.sha } });
    if (open?.length) {
      console.log(`sync: updated #${open[0].number} ${tag}`);
      return send(res, 200, { number: open[0].number, url: open[0].html_url, updated: true });
    }
    const pr = await ghJson(`/repos/${REGISTRY_REPO}/pulls`, token, left, { method: 'POST', body: {
      title: subject, head: branch, base: 'main',
      body: [`The people on **${entry.title}**, as the author site has them: ${people.members.length} member${people.members.length === 1 ? '' : 's'} (ids and display names; emails are never in the registry), the GitHub logins still linked (\`authors\`) and who has reader-suggestion emails off (\`mentions_off\`).`, '',
        'Access already follows the author site; this is the public record. It merges by itself once the registry\'s checks are green, and later changes update this pull request.'].join('\n'),
    } });
    await gh('/graphql', token, left, { method: 'POST', body: {
      query: 'mutation($id: ID!) { enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: SQUASH }) { pullRequest { number } } }',
      variables: { id: pr.node_id },
    } }).catch((err) => console.warn(`sync: auto-merge not switched on for #${pr.number}: ${err.message}`));
    console.log(`sync: opened #${pr.number} ${tag}`);
    return send(res, 200, { number: pr.number, url: pr.html_url, updated: false });
  } catch (err) {
    return fail(res, err, tag, credential?.refused);
  }
}
