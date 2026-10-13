/**
 * GET /api/page-revision?book=<slug>&sha=<commit>&path=<file> — one revision of one
 * page, for the book sites' History panel (quartz-edition-extras' edit-on-github).
 * Public: no sign-in, any origin, because everything it returns is already public
 * in the book's repository. It exists so readers' browsers don't call GitHub
 * unauthenticated (60 requests an hour per IP, shared by a whole classroom's NAT).
 *
 *   -> 200 { sha, parent, path, previousPath, status, before, after, html, proposer }
 *        before/after: the file's text at the parent and at `sha` ("" when absent)
 *        html:         `after` rendered by GitHub's markdown API (the client sanitises
 *                      it again), Obsidian syntax reduced as the editor's Preview does
 *        proposer:     the name an anonymous in-site proposal gave, or null. The
 *                      book's build-time list has it from the commit's Proposed-by:
 *                      trailer; commits from before the trailer say "a reader"
 *                      (their names are only in the pull requests).
 *   -> 4xx/5xx { error, userMessage }
 *
 * GET /api/page-revision?book=<slug>&shas=<sha>,<sha>,… — the names anonymous
 * proposals gave, for a History list's "a reader" rows, in one call (at most
 * MAX_SHAS; one call counts once against the limit).
 *   -> 200 { names: { <sha>: name | null } }   null: not on the live branch, or no
 *        App-written proposal behind it. Cached at the edge for a day, not a year,
 *        so a name a maintainer removes from a pull request goes too.
 *
 * GET /api/page-revision?book=<slug>&sha=<commit>&path=<file>&base=<commit> — two
 * versions of one page, for the History panel's Compare (batch 2a): `before` is the
 * file at `base`, `after` at `sha` (either "" where the page didn't exist), status
 * "compared". Either may be any public version. `html` is "" here (the panel's Compare
 * uses the texts only).
 *
 * GET /api/history?book=<slug>[&path=<file>] (vercel.json rewrites it here, as
 * mode=open) — what is proposed and not yet decided, for the History panel's and the
 * book's /history "Being edited" band (batch 2a): the open proposed-edit pull
 * requests and the open section-note and suggested-edit issues, of the page (by
 * their **File:** line) or of the whole book. Public fields only:
 *   -> 200 { items: [{ kind: "edit"|"note"|"suggestion", number, url, date, summary, who: { name, github? } | null, paragraph? }] }
 * Kept 90 seconds, here and at the edge, so a classroom opening the same page asks
 * GitHub once.
 *
 * With &declined=1 (batch 2c), also what the authors declined, newest first, with
 * the reason, who declined it and the book's people's comments (lib/declined.mjs):
 *   -> 200 { items, declined: [{ kind, number, url, proposed, date, summary, who,
 *            files, paragraph?, reason | null, decliner | null, comments: [{ id,
 *            member, name, date, text }] }] }
 * Kept 2 minutes. GET /api/history?book=<slug>&change=<n> is one declined proposal's
 * change, read from its pull request even after the branch is gone:
 *   -> 200 { number, files: [{ path, before, after }] }
 *
 * Only registered, non-retired books, only commits on the book's live branch or its
 * drafts branch (`branch` in the answer says which; batch 2a: what is being edited is
 * public in the repository too), and only a file that commit changed. A commit never
 * changes, so a 200 is cached at the edge for a year; refusals for five minutes.
 * Rate-limited per IP (best effort, as every limiter here: lib/common.mjs).
 */
import { REGISTRY, SHA_RE, Refusal, appCredentials, budget, encodePath, gh, ghJson, graphqlRepo, query, wrap } from '../lib/author.mjs';
import { RawJson, clientIp, createRateLimiter, isSafePath, send } from '../lib/common.mjs';
import { declinedChange, declinedItems, newestFirst } from '../lib/declined.mjs';
import { ahead, cacheKeys as keys } from '../lib/kv-cache.mjs';
import { platform } from '../lib/platform.mjs';

// issues: read for /api/history's notes and suggestions: without it GitHub lists none (no error).
const appToken = appCredentials({ contents: 'read', pull_requests: 'read', issues: 'read' });
const isRateLimited = createRateLimiter(120, 60 * 60 * 1000, 'page-revision');
const MAX_NAME = 80;
const MAX_SHAS = 30;

/** Commits already shown to be on a live branch: "<repo>@<sha>". Never stops being true. */
const onLive = new Set();
/** A book's open and declined items: kept ahead by scripts/refresh.mjs, or without a recent refresh this long (lib/kv-cache.mjs). */
const OPEN_TTL_MS = 90_000;
const OPEN_MAX = 100;
const DECLINED_TTL_MS = 120_000;
/**
 * A whole revision answer, kept in KV for good once sent: what a commit holds never
 * changes (on drafts as on live: both are public).
 * Its `branch` may say drafts after it went live; the History panel doesn't use it.
 */
export const revKey = (repo, sha, path, base) => `rev:${repo}:${sha}:${base ?? ''}:${path}`;
/** One page at one public commit, { branch, text }: Compare is two of them (kept like revKey). */
export const textKey = (repo, sha, path) => `text:${repo}:${sha}:${path}`;
const keptText = async (repo, sha, path) => (platform.cache ? platform.cache.get(textKey(repo, sha, path), 'json').catch(() => null) : null);
const keepText = (repo, sha, path, value) => platform.cache?.put(textKey(repo, sha, path), JSON.stringify(value)).catch((err) => console.error(`kv cache: write of text ${sha.slice(0, 7)} failed (${err?.message})`));

/** Obsidian syntax GitHub doesn't know, reduced to what a reader would see (editor.ts forPreview). */
export const forPreview = (md) =>
  md
    .replace(/^---\n[\s\S]*?\n---\n?/, '')
    .replace(/!\[\[[^\]]*\]\]/g, '')
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2')
    .replace(/\[\[([^\]]*)\]\]/g, (_m, t) => t.split('/').pop())
    .replace(/\s\^[A-Za-z0-9-]+\s*$/gm, '')
    .replace(/%%[\s\S]*?%%/g, '');

const isBot = (name = '', email = '', user) => user?.type === 'Bot' || /\[bot\]/i.test(`${name} ${email}`);

/** The name in an in-site proposal's PR body: "**Proposed by:** `Name` (`m***@x`)". */
export function proposerName(body) {
  const m = /\*\*Proposed by:\*\* (`+) ?(.+?) ?\1 \(/.exec(String(body ?? ''));
  const name = m?.[2].replace(/\s+/g, ' ').trim() ?? '';
  return name ? name.slice(0, MAX_NAME) : null;
}

async function text(repo, path, ref, token, left) {
  // The raw file: no JSON or base64 to undo.
  const res = await gh(`/repos/${repo}/contents/${encodePath(path)}?ref=${ref}`, token, left, { accept: 'application/vnd.github.raw', allow: [404] });
  // A folder answers with its listing as JSON, raw or not: only a file is raw.
  if (res.status === 404 || !(res.headers.get('content-type') ?? '').startsWith('application/vnd.github.raw')) return '';
  return (await res.text()).replace(/\r\n/g, '\n');
}

/** An App-authored commit with no human co-author: an anonymous proposal's name, from its PR. */
async function proposer(repo, sha, commit, token, left) {
  const a = commit.commit?.author ?? {};
  if (!isBot(a.name, a.email, commit.author)) return null;
  const coAuthors = [...String(commit.commit?.message ?? '').matchAll(/^Co-authored-by: (.*)$/gim)];
  if (coAuthors.some((m) => !/\[bot\]/i.test(m[1]))) return null;
  return proposalName(repo, sha, token, left);
}

/** The name in the App-written pull request behind `sha`, or null. */
async function proposalName(repo, sha, token, left) {
  const pulls = await ghJson(`/repos/${repo}/commits/${sha}/pulls?per_page=5`, token, left).catch(() => []);
  // Only a body the App wrote itself is read as a proposal.
  for (const pr of pulls ?? []) if (pr?.user?.type === 'Bot') return proposerName(pr.body);
  return null;
}

/**
 * Where each of `shas` is: 'live', 'drafts' (being edited, not yet published) or null
 * (neither: not public here). By GraphQL, not REST's compare, whose answer carries
 * every changed file's patch (hundreds of KB to parse for one word). One query does it
 * when every commit exists; a commit GitHub doesn't have fails that query whole, and
 * then two do it (which exist, then where those are). With `names` (a Map), each
 * commit's App-written pull request's name comes in the same query. Live is
 * remembered once true.
 */
export async function branchesOf(book, shas, token, left, { liveOnly = false, names = null } = {}) {
  const repo = book.content.repo;
  const out = new Map(shas.map((s) => [s, onLive.has(`${repo}@${s}`) ? 'live' : null]));
  const ask = names ? shas : shas.filter((s) => !out.get(s));
  if (!ask.length) return out;
  const branches = [book.content.live_branch, ...(liveOnly || !book.content.drafts_branch ? [] : [book.content.drafts_branch])];
  const prs = names ? ' associatedPullRequests(first: 5) { nodes { author { __typename } body } }' : '';
  const objects = (list) => list.map((_, i) => `c${i}: object(oid: $s${i}) { ... on Commit { oid${prs} } }`).join(' ');
  const compares = (list) => branches.map((_, i) => `r${i}: ref(qualifiedName: $b${i}) { ${list.map((_, j) => `x${j}: compare(headRef: $h${j}) { status }`).join(' ')} }`).join(' ');
  const vars = (list, withObjects) => ({
    ...(withObjects ? Object.fromEntries(list.map((s, i) => [`s${i}`, s])) : {}),
    ...Object.fromEntries(list.map((s, j) => [`h${j}`, s])),
    ...Object.fromEntries(branches.map((b, i) => [`b${i}`, `refs/heads/${b}`])),
  });
  const decl = (list, withObjects) => [
    ...(withObjects ? list.map((_, i) => `$s${i}: GitObjectID!`) : []),
    ...list.map((_, j) => `$h${j}: String!`),
    ...branches.map((_, i) => `$b${i}: String!`),
  ].join(', ');

  let found;
  let where;
  let real;
  try {
    const both = await graphqlRepo(repo, `query($owner: String!, $name: String!, ${decl(ask, true)}) { repository(owner: $owner, name: $name) { ${objects(ask)} ${compares(ask)} } }`,
      vars(ask, true), token, left);
    [found, where, real] = [both, both, ask];
  } catch {
    // A commit GitHub doesn't have: which exist first, then where those are.
    found = await graphqlRepo(repo, `query($owner: String!, $name: String!, ${ask.map((_, i) => `$s${i}: GitObjectID!`).join(', ')}) { repository(owner: $owner, name: $name) { ${objects(ask)} } }`,
      Object.fromEntries(ask.map((s, i) => [`s${i}`, s])), token, left);
    real = ask.filter((_, i) => found[`c${i}`]?.oid);
    where = real.length
      ? await graphqlRepo(repo, `query($owner: String!, $name: String!, ${decl(real, false)}) { repository(owner: $owner, name: $name) { ${compares(real)} } }`, vars(real, false), token, left)
      : {};
  }
  if (names) {
    // Only a body the App wrote itself is read as a proposal.
    ask.forEach((s, i) => names.set(s, proposerName((found[`c${i}`]?.associatedPullRequests?.nodes ?? []).find((pr) => pr?.author?.__typename === 'Bot')?.body)));
  }
  // The branch's head compared with the commit: BEHIND or IDENTICAL means the commit
  // is in the branch's history (REST's compare/<sha>...<branch> said ahead or identical).
  const on = (i, j) => ['BEHIND', 'IDENTICAL'].includes(where[`r${i}`]?.[`x${j}`]?.status);
  real.forEach((s, j) => {
    if (on(0, j)) {
      out.set(s, 'live');
      onLive.add(`${repo}@${s}`);
    } else if (!out.get(s) && branches.length > 1 && on(1, j)) out.set(s, 'drafts');
  });
  return out;
}

/** Who a proposal or note is from, by its attribution line (suggest-edit-function writes it). */
export function attributionOf(body) {
  const text = String(body ?? '');
  const signed = /^\*\*(?:Proposed|Submitted) by:\*\* @([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}) \(signed in with GitHub\)\s*$/m.exec(text);
  if (signed) return { name: signed[1], github: signed[1] };
  const named = /^\*\*(?:Proposed|Submitted) by:\*\* (`+) ?(.+?) ?\1(?: \(|\s*$)/m.exec(text);
  const name = named?.[2].replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
  return name ? { name } : null;
}

const fenced = (body, heading) => {
  const m = new RegExp(`^### ${heading}\\n\\n(\`{3,})text\\n([\\s\\S]*?)\\n\\1`, 'm').exec(String(body ?? ''));
  return m ? m[2].replace(/\s+/g, ' ').trim() : '';
};
const cut = (s, n = 200) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const labelled = (item, name) => (item.labels ?? []).some((l) => (typeof l === 'string' ? l : l?.name) === name);

/** One open pull request or issue, as the History panel shows it (public fields only). */
export function openItem(item, kind) {
  const body = String(item.body ?? '');
  const files = [...body.matchAll(/^\*\*File:\*\* \[`([^`]+)`\]/gm)].map((m) => m[1]);
  const para = /^\*\*Where:\*\* (?:\[)?¶(\d+)/m.exec(body)?.[1];
  const summary = kind === 'edit'
    ? fenced(body, 'Summary') || String(item.title ?? '').replace(/^(?:Update|Edit ¶\d+ of) [^:]+: /, '')
    : fenced(body, 'Suggested edit') || String(item.title ?? '');
  return {
    kind,
    number: item.number,
    url: item.html_url,
    date: String(item.created_at ?? '').slice(0, 10),
    summary: cut(summary === '(no summary given)' ? String(item.title ?? '') : summary),
    who: attributionOf(body),
    ...(para ? { paragraph: Number(para) } : {}),
    files,
  };
}

const OPEN_FIELDS = 'number url title body createdAt labels(first: 20) { nodes { name } }';

/** The book's open proposals and notes (all pages), newest first: one GraphQL query, only the fields used. */
export async function openItems(book, token, left) {
  const order = `first: ${OPEN_MAX}, orderBy: { field: CREATED_AT, direction: DESC }`;
  const open = await graphqlRepo(book.content.repo, `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) {
    pulls: pullRequests(states: OPEN, labels: ["proposed-edit"], ${order}) { nodes { ${OPEN_FIELDS} } }
    notes: issues(states: OPEN, labels: ["section-note"], ${order}) { nodes { ${OPEN_FIELDS} } }
    suggestions: issues(states: OPEN, labels: ["suggested-edit"], ${order}) { nodes { ${OPEN_FIELDS} } }
  } }`, {}, token, left);
  const rest = (n) => ({ number: n.number, html_url: n.url, title: n.title, body: n.body, created_at: n.createdAt, labels: n.labels?.nodes ?? [] });
  const seen = new Set();
  const items = (open.pulls?.nodes ?? []).map((n) => openItem(rest(n), 'edit'));
  for (const i of [...(open.notes?.nodes ?? []), ...(open.suggestions?.nodes ?? [])].map(rest)) {
    if (seen.has(i.number)) continue;
    seen.add(i.number);
    items.push(openItem(i, labelled(i, 'section-note') ? 'note' : labelled(i, 'proposed-edit') ? 'edit' : 'suggestion'));
  }
  return items.sort((a, b) => newestFirst(a.date, b.date) || b.number - a.number);
}

/** A 200, also kept in KV for good (revKey). */
async function sendKept(res, key, body) {
  const text = JSON.stringify(body);
  if (platform.cache) await platform.cache.put(key, text).catch((err) => console.error(`kv cache: write of ${key} failed (${err?.message})`));
  send(res, 200, new RawJson(text));
}

function refuse(res, status, error, userMessage) {
  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300');
  send(res, status, { error, userMessage });
}

export default wrap(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Max-Age', '86400');
    res.status(204).end();
    return;
  }
  if (req.method !== 'GET') return refuse(res, 405, 'method not allowed', 'Only GET is supported.');

  const q = query(req);
  const slug = q.get('book') ?? '';
  if (q.get('mode') === 'open') return open(req, res, q);
  if (q.get('mode') === 'item') return item(req, res, q);
  const sha = (q.get('sha') ?? '').toLowerCase();
  const path = q.get('path') ?? '';
  const shas = q.has('shas') ? [...new Set((q.get('shas') ?? '').toLowerCase().split(','))] : null;
  const base = q.has('base') ? (q.get('base') ?? '').toLowerCase() : null;
  const book = REGISTRY.books.find((b) => b.slug === slug && b.status !== 'retired');
  if (!book) return refuse(res, 404, 'unknown book', 'This book isn’t on the platform.');
  if (shas
    ? !shas.length || shas.length > MAX_SHAS || !shas.every((s) => SHA_RE.test(s))
    : !SHA_RE.test(sha) || !isSafePath(path) || (base !== null && !SHA_RE.test(base))) return refuse(res, 400, 'bad request', 'That revision link isn’t valid.');
  const repo = book.content.repo;
  if (shas) {
    // Kept ahead (refresh.mjs): every "a reader" commit the book's history.json lists.
    const kept = await ahead(keys.names(slug), 0, null);
    if (kept && shas.every((s) => s in kept)) {
      res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400');
      return send(res, 200, { names: Object.fromEntries(shas.map((s) => [s, kept[s]])) });
    }
  }
  const rk = shas ? null : revKey(repo, sha, path, base);
  if (rk && platform.cache) {
    // A revision someone opened before: the answer as it was sent, not parsed again.
    const hit = await platform.cache.get(rk).catch(() => null);
    if (hit) {
      res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=31536000, immutable');
      return send(res, 200, new RawJson(hit));
    }
    if (base !== null) {
      // Compare: the two versions' texts, each kept by commit (Show changes and refresh.mjs keep them too).
      const [b, a] = await Promise.all([keptText(repo, base, path), keptText(repo, sha, path)]);
      if (a && b) {
        res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=31536000, immutable');
        return sendKept(res, rk, { sha, base, path, status: 'compared', branch: a.branch, before: b.text, after: a.text, html: '' });
      }
    }
  }
  if (await isRateLimited(clientIp(req), Date.now())) {
    res.setHeader('Retry-After', '600');
    return refuse(res, 429, 'rate limit exceeded', 'Too many revisions opened from here in the last hour. Please try again later.');
  }

  const tag = shas ? `[page-revision ${slug} names ×${shas.length}]` : `[page-revision ${slug} ${sha.slice(0, 7)} ${path}]`;
  const left = budget(20_000);
  let credential;
  try {
    credential = await appToken(book, tag);
    const { token } = credential;

    if (shas) {
      // Where each commit is, and its pull requests' names, in the same two queries.
      const names = new Map();
      const where = await branchesOf(book, shas, token, left, { liveOnly: true, names });
      const found = shas.map((s) => (where.get(s) === 'live' ? names.get(s) ?? null : null));
      res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400');
      return send(res, 200, { names: Object.fromEntries(shas.map((s, i) => [s, found[i]])) });
    }

    const where = await branchesOf(book, base !== null ? [sha, base] : [sha], token, left);
    const branch = where.get(sha);
    if (!branch) {
      return refuse(res, 404, 'not on the live branch', 'That revision isn’t part of the published book.');
    }

    if (base !== null) {
      // Compare: the page at two versions, both public (published or being edited).
      if (!where.get(base)) {
        return refuse(res, 404, 'not on the live branch', 'That revision isn’t part of the published book.');
      }
      const [before, after] = await Promise.all([text(repo, path, base, token, left), text(repo, path, sha, token, left)]);
      await Promise.all([keepText(repo, base, path, { branch: where.get(base), text: before }), keepText(repo, sha, path, { branch, text: after })]);
      res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=31536000, immutable');
      // No html: the History panel's Compare shows the two texts' diff only (the
      // browser works it out), and rendering a chapter costs a GitHub call and its size twice over.
      return sendKept(res, rk, { sha, base, path, status: 'compared', branch, before, after, html: '' });
    }

    // ponytail: a commit's first 300 files only (GitHub's page size); a page edit is one.
    const commit = await ghJson(`/repos/${repo}/commits/${sha}`, token, left);
    const file = (commit.files ?? []).find((f) => f.filename === path);
    if (!file) return refuse(res, 404, 'file not in revision', 'That page didn’t change in this revision.');
    const parent = commit.parents?.[0]?.sha ?? null;
    const previousPath = file.previous_filename ?? path;

    const [before, after, who] = await Promise.all([
      parent && file.status !== 'added' ? text(repo, previousPath, parent, token, left) : '',
      file.status === 'removed' ? '' : text(repo, path, sha, token, left),
      proposer(repo, sha, commit, token, left),
    ]);
    const rendered = after
      ? await gh('/markdown', token, left, { method: 'POST', body: { text: forPreview(after), mode: 'markdown' } })
      : null;

    await keepText(repo, sha, path, { branch, text: after });
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=31536000, immutable');
    await sendKept(res, rk, {
      sha,
      parent,
      path,
      previousPath,
      status: file.status,
      branch,
      before,
      after,
      html: rendered ? await rendered.text() : '',
      proposer: who,
    });
  } catch (err) {
    if (err.status === 401) credential?.refused();
    console.error(`page-revision: ${err.message} ${tag}`);
    refuse(res, err instanceof Refusal ? err.status : 502, `github: ${err.message}`,
      'GitHub couldn’t be reached just now. Please try again in a moment.');
  }
});

/** The App that opens readers' proposals, notes and suggestions on every book. */
const READER_APP_LOGIN = 'textbook-suggest-edit[bot]';
const READER_LABELS = { 'proposed-edit': 'edit', 'section-note': 'note', 'suggested-edit': 'suggestion' };

/**
 * mode=item&book=<slug>&number=<n>: one reader proposal, note or suggestion, read with
 * the App, for the author site's reader-suggestion emails (batch 2b). Only an item
 * that exists, is labelled proposed-edit, section-note or suggested-edit, and was
 * opened by the platform's App or carries the platform's attribution line; anything
 * else is 404. Public fields only, as mode=open.
 */
async function item(req, res, q) {
  const slug = q.get('book') ?? '';
  const number = Number(q.get('number'));
  const book = REGISTRY.books.find((b) => b.slug === slug && b.status !== 'retired');
  if (!book || !Number.isInteger(number) || number < 1 || number > 1e7) return refuse(res, 404, 'not found', 'Not found.');
  if (await isRateLimited(clientIp(req), Date.now())) {
    res.setHeader('Retry-After', '600');
    return refuse(res, 429, 'rate limit exceeded', 'Too many requests from here in the last hour. Please try again later.');
  }
  const tag = `[item ${slug}#${number}]`;
  let credential;
  try {
    credential = await appToken(book, tag);
    const r = await gh(`/repos/${book.content.repo}/issues/${number}`, credential.token, budget(10_000), { allow: [404, 410] });
    if (!r.ok) return refuse(res, 404, 'not found', 'Not found.');
    const it = await r.json();
    const labels = (it.labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name));
    const kinds = labels.map((l) => READER_LABELS[l]).filter(Boolean);
    const byApp = it.user?.type === 'Bot' && it.user?.login === READER_APP_LOGIN;
    if (!kinds.length || (!byApp && !attributionOf(String(it.body ?? '')))) return refuse(res, 404, 'not found', 'Not found.');
    const one = openItem(it, kinds.includes('note') ? 'note' : kinds.includes('edit') ? 'edit' : 'suggestion');
    const where = /^\*\*Where:\*\* \[¶(\d+)\]\((https:\/\/[^)\s]+)\)/m.exec(String(it.body ?? ''));
    res.setHeader('Cache-Control', 'no-store');
    return send(res, 200, {
      number: one.number, kind: one.kind, url: one.url, summary: one.summary, state: it.state, created: it.created_at,
      ...(where ? { paragraph: { n: Number(where[1]), url: where[2] } } : {}),
    });
  } catch (err) {
    if (err.status === 401) credential?.refused();
    console.error(`item: ${err.message} ${tag}`);
    return refuse(res, 502, `github: ${err.message}`, 'GitHub couldn’t be reached just now.');
  }
}

/** mode=open (/api/history): the book's, or a page's, open proposals and notes. */
async function open(req, res, q) {
  const slug = q.get('book') ?? '';
  const path = q.get('path') ?? '';
  const book = REGISTRY.books.find((b) => b.slug === slug && b.status !== 'retired');
  if (!book) return refuse(res, 404, 'unknown book', 'This book isn’t on the platform.');
  if (path && !isSafePath(path)) return refuse(res, 400, 'bad request', 'That page isn’t valid.');
  const key = book.slug;
  const change = q.has('change') ? Number(q.get('change')) : null;
  if (change !== null) return declinedDiff(req, res, book, change);
  const withDeclined = q.get('declined') === '1';
  // The book's lists, shared by every page of it (and on Cloudflare by every data
  // centre, through KV): only a request that finds them older than their TTL asks GitHub.
  const tag = `[history ${slug}]`;
  let credential;
  let limited = false;
  const fromGitHub = (list) => async () => {
    if (await isRateLimited(clientIp(req), Date.now())) {
      limited = true;
      throw new Refusal(429, 'rate limit exceeded');
    }
    credential ??= await appToken(book, tag);
    return list(book, credential.token, budget(20_000));
  };
  let items;
  let declined;
  try {
    [items, declined] = await Promise.all([
      ahead(keys.open(key), OPEN_TTL_MS, fromGitHub(openItems)),
      withDeclined ? ahead(keys.declined(key), DECLINED_TTL_MS, fromGitHub(declinedItems)) : null,
    ]);
  } catch (err) {
    if (limited) {
      res.setHeader('Retry-After', '600');
      return refuse(res, 429, 'rate limit exceeded', 'Too many requests from here in the last hour. Please try again later.');
    }
    if (err.status === 401) credential?.refused();
    console.error(`history: ${err.message} ${tag}`);
    return refuse(res, err instanceof Refusal ? err.status : 502, `github: ${err.message}`, 'GitHub couldn’t be reached just now. Please try again in a moment.');
  }
  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=90');
  const onPage = (list) => (path ? list.filter((i) => i.files.includes(path)) : list);
  send(res, 200, { items: onPage(items), ...(withDeclined ? { declined: onPage(declined) } : {}) });
}

/** &change=<n>: a declined proposal's change (its pull request's files, before and after). */
async function declinedDiff(req, res, book, n) {
  if (!Number.isInteger(n) || n < 1 || n > 1e7) return refuse(res, 400, 'bad request', 'That isn’t a proposal.');
  if (await isRateLimited(clientIp(req), Date.now())) {
    res.setHeader('Retry-After', '600');
    return refuse(res, 429, 'rate limit exceeded', 'Too many requests from here in the last hour. Please try again later.');
  }
  const tag = `[declined ${book.slug}#${n}]`;
  let credential;
  try {
    credential = await appToken(book, tag);
    const d = await declinedChange(book, n, credential.token, budget(15_000), text);
    if (!d) return refuse(res, 404, 'not declined', 'That isn’t a declined proposal of this book.');
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400');
    return send(res, 200, d);
  } catch (err) {
    if (err.status === 401) credential?.refused();
    console.error(`declined change: ${err.message} ${tag}`);
    return refuse(res, 502, `github: ${err.message}`, 'GitHub couldn’t be reached just now. Please try again in a moment.');
  }
}
