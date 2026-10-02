/**
 * GET /api/author-history — the drafts area's revision history, as the GitHub App, for
 * a signed-in author of the book (lib/author.mjs says who may). Read here rather than
 * from the browser so authors don't share GitHub's 60-an-hour unauthenticated limit.
 *
 *   ?book=<slug>[&path=<path>][&page=<n>]
 *     -> { commits: [{ sha, who, when, message, live }], next }
 *        the commits on drafts, newest first, 30 a page; with `path`, only those that
 *        changed that file. `live` is false while the commit is still waiting in drafts.
 *   ?book=<slug>&sha=<commit>[&path=<path>]
 *     -> { sha, who, when, message, live, parent, files: [{ path, status, added, removed, patch }],
 *          page?: { path, text, before } }
 *        one commit and the author files it changed; with `path`, that file's text at the
 *        commit and at its parent (null where it didn't exist, or isn't UTF-8 text).
 *
 * Refused as author-read refuses (403 / 401 / 403 / 400), and a sha or page that
 * isn't one (400).
 */
import {
  SHA_RE, appCredentials, authorise, blobBytes, bookFor, budget, encodePath, fail, ghJson,
  isAuthorPath, isTextPath, limits, query, treeAt, wrap, Refusal,
} from '../lib/author.mjs';
import { send } from '../lib/common.mjs';
import { compareDrafts } from '../lib/author-console-reads.mjs';

const appToken = appCredentials({ contents: 'read' });
const PER_PAGE = 30;
const MAX_FILE = 5 * 1024 * 1024;
const MAX_PATCH = 20_000;

const describe = (c, waiting) => ({
  sha: c.sha,
  who: c.author?.login || c.commit?.author?.name || 'someone',
  when: c.commit?.author?.date ?? null,
  message: String(c.commit?.message ?? '').split('\n')[0],
  live: !waiting.has(c.sha),
});

// ponytail: compare lists at most 250 commits, so drafts more than 250 ahead of live
// would show the oldest extras as live. Page the compare if a book ever gets there.
async function waitingInDrafts(book, token, left) {
  const c = await compareDrafts(book, token, left);
  return new Set((c?.commits ?? []).map((x) => x.sha));
}

function checkPath(path) {
  if (path && !isAuthorPath(path)) throw new Refusal(400, 'validation: path rejected', 'That file is outside what the author site works on.');
  return path;
}

async function textAt(repo, commit, path, token, left) {
  if (!commit || !isTextPath(path)) return null;
  const entry = (await treeAt(repo, commit, token, left)).files.get(path);
  if (!entry) return null;
  if (entry.size > MAX_FILE) throw new Refusal(413, 'file too large', 'That file is too large to open here.');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(await blobBytes(repo, entry.sha, token, left));
  } catch {
    return null;
  }
}

async function list(book, token, left, params) {
  const path = checkPath(params.get('path') ?? '');
  const page = Number(params.get('page') ?? 1);
  if (!Number.isSafeInteger(page) || page < 1 || page > 100) throw new Refusal(400, 'validation: page', 'Please reload the history and try again.');
  const [commits, waiting] = await Promise.all([
    ghJson(`/repos/${book.content.repo}/commits?sha=${encodeURIComponent(book.content.drafts_branch)}`
      + `${path ? `&path=${encodeURIComponent(path)}` : ''}&per_page=${PER_PAGE}&page=${page}`, token, left),
    waitingInDrafts(book, token, left),
  ]);
  const out = (commits ?? []).filter((c) => c?.sha);
  return { commits: out.map((c) => describe(c, waiting)), next: out.length === PER_PAGE };
}

async function revision(book, token, left, params) {
  const sha = params.get('sha');
  const path = checkPath(params.get('path') ?? '');
  const repo = book.content.repo;
  const [c, waiting] = await Promise.all([ghJson(`/repos/${repo}/commits/${encodePath(sha)}`, token, left), waitingInDrafts(book, token, left)]);
  const parent = c?.parents?.[0]?.sha ?? null;
  const files = (c?.files ?? []).filter((f) => isAuthorPath(f.filename)).map((f) => ({
    path: f.filename,
    status: f.status,
    added: f.additions ?? 0,
    removed: f.deletions ?? 0,
    patch: typeof f.patch === 'string' ? (f.patch.length > MAX_PATCH ? `${f.patch.slice(0, MAX_PATCH)}\n… (trimmed)` : f.patch) : null,
  }));
  const out = { ...describe(c, waiting), parent, files };
  if (path) {
    const [text, before] = await Promise.all([textAt(repo, sha, path, token, left), textAt(repo, parent, path, token, left)]);
    out.page = { path, text, before };
  }
  return out;
}

export default wrap(async (req, res) => {
  const auth = authorise(req, res, 'GET');
  if (!auth) return;
  const params = query(req);
  const { identity, tag } = auth;
  if (limits.read(identity.login.toLowerCase(), Date.now())) {
    send(res, 429, { error: 'rate limit exceeded', userMessage: 'Too many requests — try again in a little while.' });
    return;
  }
  const sha = params.get('sha');
  if (sha !== null && !SHA_RE.test(sha)) {
    send(res, 400, { error: 'validation: sha', userMessage: "That isn't a revision the author site listed." });
    return;
  }
  const book = bookFor(params.get('book'), auth, res);
  if (!book) return;
  let credential;
  try {
    credential = await appToken(book, `${tag} book=${book.slug}`);
    send(res, 200, await (sha ? revision : list)(book, credential.token, budget(20_000), params));
  } catch (err) {
    fail(res, err, `${tag} book=${book.slug} history${sha ? ` sha=${sha.slice(0, 7)}` : ''}`, credential?.refused);
  }
});
