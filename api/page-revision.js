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
 * "compared". Either may be any public version.
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
 * Only registered, non-retired books, only commits on the book's live branch or its
 * drafts branch (`branch` in the answer says which; batch 2a: what is being edited is
 * public in the repository too), and only a file that commit changed. A commit never
 * changes, so a 200 is cached at the edge for a year; refusals for five minutes.
 * Rate-limited per IP (best effort, as every limiter here: lib/common.mjs).
 */
import { REGISTRY, SHA_RE, Refusal, appCredentials, budget, encodePath, gh, ghJson, query, wrap } from '../lib/author.mjs';
import { clientIp, createRateLimiter, isSafePath, send } from '../lib/common.mjs';

const appToken = appCredentials({ contents: 'read', pull_requests: 'read' });
const isRateLimited = createRateLimiter(120, 60 * 60 * 1000);
const MAX_NAME = 80;
const MAX_SHAS = 30;

/** Commits already shown to be on a live branch: "<repo>@<sha>". Never stops being true. */
const onLive = new Set();
/** The open-items answer per book (and page), for OPEN_TTL_MS: { at, items }. */
const openCache = new Map();
const OPEN_TTL_MS = 90_000;
const OPEN_MAX = 100;

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
  const res = await gh(`/repos/${repo}/contents/${encodePath(path)}?ref=${ref}`, token, left, { allow: [404] });
  if (res.status === 404) return '';
  const file = await res.json();
  if (file?.type !== 'file' || typeof file.content !== 'string') return '';
  // ponytail: files over 1 MB come back without content; chapters are far smaller.
  return Buffer.from(file.content, 'base64').toString('utf8').replace(/\r\n/g, '\n');
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

/** Whether `sha` is on `branch` of the book's repository. */
async function isOn(repo, branch, sha, token, left) {
  const cmp = await gh(`/repos/${repo}/compare/${sha}...${encodePath(branch)}?per_page=1`, token, left, { allow: [404] });
  const status = cmp.status === 404 ? 'missing' : (await cmp.json())?.status;
  return status === 'ahead' || status === 'identical';
}

/** Whether `sha` is on the book's live branch (remembered once it is). */
async function isOnLive(book, sha, token, left) {
  const repo = book.content.repo;
  if (onLive.has(`${repo}@${sha}`)) return true;
  if (!(await isOn(repo, book.content.live_branch, sha, token, left))) return false;
  onLive.add(`${repo}@${sha}`);
  return true;
}

/** "live", "drafts" (being edited, not yet published) or null (neither: not public here). */
async function branchOf(book, sha, token, left) {
  if (await isOnLive(book, sha, token, left)) return 'live';
  const drafts = book.content.drafts_branch;
  return drafts && (await isOn(book.content.repo, drafts, sha, token, left)) ? 'drafts' : null;
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

/** The book's open proposals and notes (all pages), newest first. */
async function openItems(book, token, left) {
  const repo = book.content.repo;
  const [pulls, notes, suggestions] = await Promise.all([
    ghJson(`/repos/${repo}/pulls?state=open&per_page=${OPEN_MAX}`, token, left),
    ghJson(`/repos/${repo}/issues?state=open&labels=section-note&per_page=${OPEN_MAX}`, token, left),
    ghJson(`/repos/${repo}/issues?state=open&labels=suggested-edit&per_page=${OPEN_MAX}`, token, left),
  ]);
  const seen = new Set();
  const items = [];
  for (const pr of pulls ?? []) if (labelled(pr, 'proposed-edit')) items.push(openItem(pr, 'edit'));
  for (const i of [...(notes ?? []), ...(suggestions ?? [])]) {
    if (i.pull_request || seen.has(i.number)) continue;
    seen.add(i.number);
    items.push(openItem(i, labelled(i, 'section-note') ? 'note' : labelled(i, 'proposed-edit') ? 'edit' : 'suggestion'));
  }
  return items.sort((a, b) => b.date.localeCompare(a.date) || b.number - a.number);
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
  const sha = (q.get('sha') ?? '').toLowerCase();
  const path = q.get('path') ?? '';
  const shas = q.has('shas') ? [...new Set((q.get('shas') ?? '').toLowerCase().split(','))] : null;
  const base = q.has('base') ? (q.get('base') ?? '').toLowerCase() : null;
  const book = REGISTRY.books.find((b) => b.slug === slug && b.status !== 'retired');
  if (!book) return refuse(res, 404, 'unknown book', 'This book isn’t on the platform.');
  if (shas
    ? !shas.length || shas.length > MAX_SHAS || !shas.every((s) => SHA_RE.test(s))
    : !SHA_RE.test(sha) || !isSafePath(path) || (base !== null && !SHA_RE.test(base))) return refuse(res, 400, 'bad request', 'That revision link isn’t valid.');
  if (isRateLimited(clientIp(req), Date.now())) {
    res.setHeader('Retry-After', '600');
    return refuse(res, 429, 'rate limit exceeded', 'Too many revisions opened from here in the last hour. Please try again later.');
  }

  const repo = book.content.repo;
  const tag = shas ? `[page-revision ${slug} names ×${shas.length}]` : `[page-revision ${slug} ${sha.slice(0, 7)} ${path}]`;
  const left = budget(20_000);
  let credential;
  try {
    credential = await appToken(book, tag);
    const { token } = credential;

    if (shas) {
      const found = await Promise.all(shas.map(async (s) =>
        (await isOnLive(book, s, token, left)) ? proposalName(repo, s, token, left) : null));
      res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400');
      return send(res, 200, { names: Object.fromEntries(shas.map((s, i) => [s, found[i]])) });
    }

    const branch = await branchOf(book, sha, token, left);
    if (!branch) {
      return refuse(res, 404, 'not on the live branch', 'That revision isn’t part of the published book.');
    }

    if (base !== null) {
      // Compare: the page at two versions, both public (published or being edited).
      if (!(await branchOf(book, base, token, left))) {
        return refuse(res, 404, 'not on the live branch', 'That revision isn’t part of the published book.');
      }
      const [before, after] = await Promise.all([text(repo, path, base, token, left), text(repo, path, sha, token, left)]);
      const rendered = after
        ? await gh('/markdown', token, left, { method: 'POST', body: { text: forPreview(after), mode: 'markdown' } })
        : null;
      res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=31536000, immutable');
      return send(res, 200, { sha, base, path, status: 'compared', branch, before, after, html: rendered ? await rendered.text() : '' });
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

    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=31536000, immutable');
    send(res, 200, {
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

/** mode=open (/api/history): the book's, or a page's, open proposals and notes. */
async function open(req, res, q) {
  const slug = q.get('book') ?? '';
  const path = q.get('path') ?? '';
  const book = REGISTRY.books.find((b) => b.slug === slug && b.status !== 'retired');
  if (!book) return refuse(res, 404, 'unknown book', 'This book isn’t on the platform.');
  if (path && !isSafePath(path)) return refuse(res, 400, 'bad request', 'That page isn’t valid.');
  const key = book.slug;
  const hit = openCache.get(key);
  let items = hit && Date.now() - hit.at < OPEN_TTL_MS ? hit.items : null;
  if (!items) {
    if (isRateLimited(clientIp(req), Date.now())) {
      res.setHeader('Retry-After', '600');
      return refuse(res, 429, 'rate limit exceeded', 'Too many requests from here in the last hour. Please try again later.');
    }
    const tag = `[history ${slug}]`;
    let credential;
    try {
      credential = await appToken(book, tag);
      items = await openItems(book, credential.token, budget(15_000));
      openCache.set(key, { at: Date.now(), items });
    } catch (err) {
      if (err.status === 401) credential?.refused();
      console.error(`history: ${err.message} ${tag}`);
      return refuse(res, err instanceof Refusal ? err.status : 502, `github: ${err.message}`, 'GitHub couldn’t be reached just now. Please try again in a moment.');
    }
  }
  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=90');
  send(res, 200, { items: path ? items.filter((i) => i.files.includes(path)) : items });
}
