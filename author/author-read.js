/**
 * GET /api/author-read — everything the author site reads, as the GitHub App, for a
 * signed-in author of the book (lib/author.mjs says who may).
 *
 *   ?what=books
 *     -> { login, books: [{ slug, title, status, repo, drafts_branch, live_branch, domain, zip }] }
 *   ?what=tree&book=<slug>
 *     -> { head, files: [{ path, sha, size }] }      drafts at its head, author paths only
 *   ?what=file&book=<slug>&path=<path>&ref=<commit>
 *     -> { path, sha, text } or { path, sha, base64 }, and `last`: the latest commit
 *        touching it at that ref ({ who, when, message, url }), for "last changed by"
 *   ?what=suggestions&book=<slug>                     open reader suggestions
 *     -> { suggestions: [...] }
 *   ?what=suggestion-changes&book=<slug>&number=<n>   commits on drafts that changed the
 *     -> { page, changes: [...] }                     suggestion's page since it was accepted
 *   ?what=changes&book=<slug>                          draft changes (open PRs into drafts)
 *     -> { changes: [...] }
 *   ?what=change&book=<slug>&number=<n>               one draft change as before/after lines
 *     -> { readable, why, pages }
 *   ?what=publish&book=<slug>                         what stands between drafts and live
 *     -> { publish: null | {...} }
 *
 * Refused: another origin (403), no or another origin's identity (401), a book the
 * login isn't an author of (403), a path outside chapters/, assets/, index.md,
 * glossary.md, chapter-sources.json (400).
 */
import {
  SHA_RE, appCredentials, authorise, blobBytes, bookFor, booksFor, budget, draftsHead, encodePath, fail, ghJson,
  isAuthorPath, isTextPath, limits, query, treeAt, wrap, Refusal,
} from '../lib/author.mjs';
import { send } from '../lib/common.mjs';
import { SUGGESTED, describeChange, parseSuggestion, readableChange } from '../lib/author-console.mjs';
import { acceptedAt, changesSince, publishState, suggestion } from '../lib/author-console-reads.mjs';

const appToken = appCredentials({ contents: 'read', pull_requests: 'read', issues: 'read' });
const MAX_FILE = 5 * 1024 * 1024;

function zipUrl(book) {
  return `https://github.com/${book.content.repo}/archive/refs/heads/${encodePath(book.content.drafts_branch)}.zip`;
}

async function tree(book, token, left) {
  const head = await draftsHead(book, token, left);
  const { files } = await treeAt(book.content.repo, head, token, left);
  return {
    head,
    files: [...files].filter(([p]) => isAuthorPath(p)).map(([path, f]) => ({ path, sha: f.sha, size: f.size })),
  };
}

async function file(book, token, left, params) {
  const path = params.get('path') ?? '';
  const ref = params.get('ref') ?? '';
  if (!isAuthorPath(path)) throw new Refusal(400, 'validation: path rejected', 'That file is outside what the author site works on.');
  if (!SHA_RE.test(ref)) throw new Refusal(400, 'validation: ref', 'Please reload the book and try again.');
  const repo = book.content.repo;
  const { files } = await treeAt(repo, ref, token, left);
  const entry = files.get(path);
  if (!entry) throw new Refusal(404, 'file not found', "That file isn't in the drafts area.");
  if (entry.size > MAX_FILE) throw new Refusal(413, 'file too large', 'That file is too large to open here.');
  const [bytes, commits] = await Promise.all([
    blobBytes(repo, entry.sha, token, left),
    ghJson(`/repos/${repo}/commits?sha=${ref}&path=${encodeURIComponent(path)}&per_page=1`, token, left),
  ]);
  const c = commits?.[0];
  const last = c ? {
    who: c.author?.login || c.commit?.author?.name || 'someone',
    when: c.commit?.author?.date ?? null,
    message: String(c.commit?.message ?? '').split('\n')[0],
    url: c.html_url ?? '',
  } : null;
  if (isTextPath(path)) {
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      text = null;
    }
    // Never decoded with replacements: a character that came back as "?" would be
    // sent back as one, changing a line nobody meant to touch.
    if (text !== null) return { path, sha: entry.sha, text, last };
  }
  return { path, sha: entry.sha, base64: bytes.toString('base64'), last };
}

async function suggestions(book, token, left) {
  const items = await ghJson(
    `/repos/${book.content.repo}/issues?labels=${SUGGESTED}&state=open&sort=created&direction=desc&per_page=50`, token, left);
  return { suggestions: (items ?? []).map(parseSuggestion).filter(Boolean) };
}

async function suggestionChanges(book, token, left, params) {
  const s = await suggestion(book, Number(params.get('number')), token, left);
  if (!s.accepted) throw new Refusal(409, 'not accepted', "This suggestion hasn't been accepted yet.");
  if (!isAuthorPath(s.path)) throw new Refusal(409, 'page outside the book', 'This suggestion names a page outside the book, so there is no change to link it to. Reply to it on GitHub instead.');
  const since = await acceptedAt(book, s.number, token, left);
  return { page: s.page, changes: since ? await changesSince(book, s.path, since, token, left) : [] };
}

async function changes(book, token, left) {
  const prs = await ghJson(
    `/repos/${book.content.repo}/pulls?state=open&sort=created&direction=desc&per_page=50&base=${encodeURIComponent(book.content.drafts_branch)}`,
    token, left);
  return { changes: (prs ?? []).map(describeChange) };
}

async function change(book, token, left, params) {
  const number = Number(params.get('number'));
  if (!Number.isSafeInteger(number) || number <= 0) throw new Refusal(400, 'validation: number', "That change isn't one the author site listed.");
  const files = await ghJson(`/repos/${book.content.repo}/pulls/${number}/files?per_page=100`, token, left);
  return readableChange(files ?? []);
}

const READS = { tree, file, suggestions, 'suggestion-changes': suggestionChanges, changes, change, publish: (book, token, left) => publishState(book, token, left, 1) };

export default wrap(async (req, res) => {
  const auth = authorise(req, res, 'GET');
  if (!auth) return;
  const params = query(req);
  const what = params.get('what') ?? '';
  const { identity, tag } = auth;

  if (limits.read(identity.login.toLowerCase(), Date.now())) {
    send(res, 429, { error: 'rate limit exceeded', userMessage: 'Too many requests — try again in a little while.' });
    return;
  }
  if (what === 'books') {
    send(res, 200, {
      login: identity.login,
      books: booksFor(identity).map((b) => ({
        slug: b.slug, title: b.title, status: b.status, repo: b.content.repo,
        drafts_branch: b.content.drafts_branch, live_branch: b.content.live_branch,
        domain: b.site.domain, zip: zipUrl(b),
      })),
    });
    return;
  }
  const read = Object.hasOwn(READS, what) ? READS[what] : null;
  if (!read) {
    send(res, 400, { error: 'validation: what', userMessage: 'The author site asked for something it cannot read.' });
    return;
  }
  const book = bookFor(params.get('book'), auth, res);
  if (!book) return;
  let credential;
  try {
    credential = await appToken(book, `${tag} book=${book.slug}`);
    send(res, 200, await read(book, credential.token, budget(20_000), params));
  } catch (err) {
    fail(res, err, `${tag} book=${book.slug} what=${what}`, credential?.refused);
  }
});
