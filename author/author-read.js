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
 *   ?what=declined&book=<slug>                        declined proposals, notes and suggestions,
 *     -> { items: [...] }                               with reasons and comments (lib/declined.mjs), fresh
 *   ?what=declined-change&book=<slug>&number=<n>      a declined proposal's change
 *     -> { number, files: [{ path, before, after }] }   (through the author site's proxy, not the public endpoint)
 *   ?what=review&book=<slug>&path=<path>               Review all in chapter: the drafts' text with
 *     -> { path, drafts, paragraphs, items, hunks, notes } every pending proposal merged in (lib/review.mjs)
 *   ?what=publish&book=<slug>                         what stands between drafts and live
 *     -> { publish: null | {...} }                    (with `lint` whenever it could be run)
 *   ?what=drafts&book=<slug>                          drafts vs live, file by file, readers'
 *     -> { live, drafts, files, more }                files only (lib/author-console-reads.mjs)
 *
 * Refused: another origin (403), no or another origin's identity (401), a book the
 * login isn't an author of (403), a path outside chapters/, assets/, index.md,
 * glossary.md, chapter-sources.json (400).
 */
import {
  SHA_RE, appCredentials, authorise, blobBytes, bookFor, booksFor, budget, draftsHead, encodePath, fail, ghJson,
  graphqlRepo, isAuthorPath, isTextPath, limits, query, treeAt, wrap, Refusal,
} from '../lib/author.mjs';
import { jsonWithBase64, send } from '../lib/common.mjs';
import { SUGGESTED, describeChange, isProposal, parseSuggestion, readableChange } from '../lib/author-console.mjs';
import { acceptedAt, changesSince, draftsDiff, publishState, suggestion } from '../lib/author-console-reads.mjs';
import { declinedChange, declinedItems } from '../lib/declined.mjs';
import { lintAt } from '../lib/lint-job.mjs';
import { gather, viewOf } from '../lib/review.mjs';
import { platform } from '../lib/platform.mjs';

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
  return jsonWithBase64({ path, sha: entry.sha, last }, bytes.toString('base64'));
}

// GraphQL with only the fields the author site shows, not REST's whole issue and pull
// request objects (on the ontology book, 41 KB and 369 KB of JSON to parse, against the
// Worker's 10 ms of CPU). The nodes are put in REST's shape for the shared parsers.
const restOf = (n) => ({
  number: n.number, title: n.title, body: n.body, created_at: n.createdAt, html_url: n.url, state: 'open',
  labels: n.labels?.nodes ?? [],
  user: n.author ? { login: n.author.__typename === 'Bot' ? `${n.author.login}[bot]` : n.author.login } : null,
});

async function suggestions(book, token, left) {
  // ponytail: a book with over 100 open written suggestions shows its newest 100.
  const r = await graphqlRepo(book.content.repo, `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) {
    issues(states: OPEN, labels: ["${SUGGESTED}"], first: 100, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { number title body createdAt url labels(first: 20) { nodes { name } } } }
  } }`, {}, token, left);
  return { suggestions: (r.issues?.nodes ?? []).map(restOf).map(parseSuggestion).filter(Boolean) };
}

async function suggestionChanges(book, token, left, params) {
  const s = await suggestion(book, Number(params.get('number')), token, left);
  if (!s.accepted) throw new Refusal(409, 'not accepted', "This suggestion hasn't been accepted yet.");
  if (!isAuthorPath(s.path)) throw new Refusal(409, 'page outside the book', 'This suggestion names a page outside the book, so there is no change to link it to. Reply to it on GitHub instead.');
  const since = await acceptedAt(book, s.number, token, left);
  return { page: s.page, changes: since ? await changesSince(book, s.path, since, token, left) : [] };
}

async function changes(book, token, left) {
  const r = await graphqlRepo(book.content.repo, `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, baseRefName: ${JSON.stringify(book.content.drafts_branch)}, first: 50, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { number title body createdAt url headRefName author { __typename login } labels(first: 10) { nodes { name } } } }
  } }`, {}, token, left);
  // Readers' proposals only: the platform's own pull requests aren't the author's to answer.
  return { changes: (r.pullRequests?.nodes ?? []).map((n) => ({ ...restOf(n), head: { ref: n.headRefName } })).filter(isProposal).map(describeChange) };
}

async function change(book, token, left, params) {
  const number = Number(params.get('number'));
  if (!Number.isSafeInteger(number) || number <= 0) throw new Refusal(400, 'validation: number', "That change isn't one the author site listed.");
  const files = await ghJson(`/repos/${book.content.repo}/pulls/${number}/files?per_page=100`, token, left);
  return readableChange(files ?? []);
}

async function review(book, token, left, params) {
  const path = params.get('path') ?? '';
  if (!isAuthorPath(path)) throw new Refusal(400, 'validation: path rejected', 'That file is outside what the author site works on.');
  // On the Worker in parts (lib/review.mjs gather): the page asks for each proposal on its own.
  const number = params.has('number') ? Number(params.get('number')) : null;
  if (number !== null && !(Number.isSafeInteger(number) && number > 0)) throw new Refusal(400, 'validation: number', "That change isn't one the author site listed.");
  const g = await gather(book, path, token, left, { number, light: platform.cpuCapped && !number });
  if (!g) throw new Refusal(404, 'file not found', "That page isn't in the drafts area, or isn't text.");
  return viewOf(g, path);
}

const READS = { tree, file, review, drafts: draftsDiff, suggestions, 'suggestion-changes': suggestionChanges, changes, change, declined: async (book, token, left) => ({ items: await declinedItems(book, token, left) }),
  'declined-change': async (book, token, left, params) => {
    const d = await declinedChange(book, Number(params.get('number')), token, left);
    if (!d) throw new Refusal(404, 'not declined', "That isn't a declined proposal of this book.");
    return d;
  }, publish: (book, token, left) => publishState(book, token, left, 1),
  // The author site polls this while `publish` says the lint is being checked. It only
  // reads: the job was asked for when `publish` was read.
  lint: async (book, token, left, params) => {
    const l = await lintAt(book, params.get('sha'), left);
    return { lint: l.state === 'done' ? { state: 'done', problems: l.problems.slice(0, 100), count: l.problems.length } : { state: l.state } };
  } };

export default wrap(async (req, res) => {
  const auth = await authorise(req, res, 'GET');
  if (!auth) return;
  const params = query(req);
  const what = params.get('what') ?? '';
  const { identity, tag } = auth;

  if (await limits.read(identity.login.toLowerCase(), Date.now())) {
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
