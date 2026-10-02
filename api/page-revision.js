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
 * Only registered, non-retired books, only commits on the book's live branch, and
 * only a file that commit changed. A commit never changes, so a 200 is cached at the
 * edge for a year; refusals for five minutes. Rate-limited per IP (best effort, as
 * every limiter here: lib/common.mjs).
 */
import { REGISTRY, SHA_RE, Refusal, appCredentials, budget, encodePath, gh, ghJson, query, wrap } from '../lib/author.mjs';
import { clientIp, createRateLimiter, isSafePath, send } from '../lib/common.mjs';

const appToken = appCredentials({ contents: 'read', pull_requests: 'read' });
const isRateLimited = createRateLimiter(120, 60 * 60 * 1000);
const MAX_NAME = 80;
const MAX_SHAS = 30;

/** Commits already shown to be on a live branch: "<repo>@<sha>". Never stops being true. */
const onLive = new Set();

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

/** Whether `sha` is on the book's live branch (remembered once it is). */
async function isOnLive(book, sha, token, left) {
  const repo = book.content.repo;
  if (onLive.has(`${repo}@${sha}`)) return true;
  const live = encodePath(book.content.live_branch);
  const cmp = await gh(`/repos/${repo}/compare/${sha}...${live}?per_page=1`, token, left, { allow: [404] });
  const status = cmp.status === 404 ? 'missing' : (await cmp.json())?.status;
  if (status !== 'ahead' && status !== 'identical') return false;
  onLive.add(`${repo}@${sha}`);
  return true;
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
  const sha = (q.get('sha') ?? '').toLowerCase();
  const path = q.get('path') ?? '';
  const shas = q.has('shas') ? [...new Set((q.get('shas') ?? '').toLowerCase().split(','))] : null;
  const book = REGISTRY.books.find((b) => b.slug === slug && b.status !== 'retired');
  if (!book) return refuse(res, 404, 'unknown book', 'This book isn’t on the platform.');
  if (shas
    ? !shas.length || shas.length > MAX_SHAS || !shas.every((s) => SHA_RE.test(s))
    : !SHA_RE.test(sha) || !isSafePath(path)) return refuse(res, 400, 'bad request', 'That revision link isn’t valid.');
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

    if (!(await isOnLive(book, sha, token, left))) {
      return refuse(res, 404, 'not on the live branch', 'That revision isn’t part of the published book.');
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
