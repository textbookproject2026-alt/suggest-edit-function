/**
 * What the author site's endpoints (api/author-*.js) share.
 *
 * Who may do anything is decided here, on every request, from three things only:
 *
 *   1. the Origin is a platform page whose registry entry lists `author-api`
 *      (platform.pages: the author site and its Pages previews);
 *   2. the request carries an identity token (lib/identity.mjs) that
 *      api/github-auth.js issued to that very origin, in `Authorization: Bearer`;
 *   3. that login is in the target book's `authors` (the registry), compared
 *      case-insensitively. Repository collaborator status plays no part.
 *
 * No GitHub token of the author's exists anywhere. Every read and write is made by
 * the GitHub App, and every write names the author: a commit's author is their
 * noreply address, and every comment, merge message and publish description says
 * "by @login via the author site".
 *
 * The App is the only credential: the BOT_TOKEN fallback the reader endpoints
 * still accept is refused here, since it would put an author's work under some
 * other account.
 */
import { createHash } from 'node:crypto';
import BUNDLE from '../registry/bundled.mjs';
import { validateRegistry, createPageResolver } from './registry.mjs';
import { createCredentials, createRateLimiter, detailOf, githubFetch, send } from './common.mjs';
import { noreplyEmail, readIdentity, readIdentitySecret } from './identity.mjs';

export const REGISTRY = validateRegistry(BUNDLE.registry);
const PAGES = createPageResolver(REGISTRY, 'author-api');
export const IDENTITY_SECRET = readIdentitySecret(process.env);

// The App's bot account commits on the author's behalf (the author is the commit's
// author). Public facts: GET /users/textbook-suggest-edit%5Bbot%5D.
const BOT = {
  name: (process.env.AUTHOR_BOT_LOGIN ?? '').trim() || 'textbook-suggest-edit[bot]',
  id: (process.env.AUTHOR_BOT_ID ?? '').trim() || '329478423',
};
export const COMMITTER = { name: BOT.name, email: `${BOT.id}+${BOT.name}@users.noreply.github.com` };

const REPO_RE = /^[A-Za-z0-9](-?[A-Za-z0-9]){0,38}\/[A-Za-z0-9._-]{1,100}$/;
export const REQUESTS_REPO = REPO_RE.test(process.env.REQUESTS_REPO ?? '')
  ? process.env.REQUESTS_REPO
  : 'textbookproject2026-alt/book-requests';
export const REQUESTS_BOOK = { slug: 'book-requests', content: { repo: REQUESTS_REPO } };

export const SHA_RE = /^[0-9a-f]{40}$/;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const TOP_FILES = new Set(['index.md', 'glossary.md', 'chapter-sources.json']);
const TOP_DIRS = ['chapters/', 'assets/'];
export const MAX_PATH = 300;

/**
 * The only paths the author site may read or write: anything under chapters/ or
 * assets/, and exactly index.md, glossary.md and chapter-sources.json at the top.
 * No traversal, no empty or dot segments, no backslash, control character or
 * leading slash, and nothing GitHub would read differently from how it is written.
 */
export function isAuthorPath(path) {
  if (typeof path !== 'string' || !path || path.length > MAX_PATH) return false;
  if (/[\u0000-\u001f\u007f\\]/.test(path) || path.startsWith('/') || path.endsWith('/')) return false;
  if (path.normalize('NFC') !== path) return false;
  const parts = path.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..' || p.trim() !== p)) return false;
  if (TOP_FILES.has(path)) return true;
  return TOP_DIRS.some((d) => path.startsWith(d) && path.length > d.length);
}

const TEXT_EXT = /\.(md|markdown|json|txt|csv|bib|yml|yaml)$/i;
export const isTextPath = (path) => TEXT_EXT.test(path);
export const encodePath = (path) => path.split('/').map(encodeURIComponent).join('/');

/** git's blob id for these bytes: what GitHub will call the file once written. */
export function blobSha(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** Per login, per instance (see createRateLimiter's honest limitation). */
export const limits = {
  read: createRateLimiter(600, 60 * 60 * 1000),
  write: createRateLimiter(60, 60 * 60 * 1000),
  people: createRateLimiter(10, 60 * 60 * 1000), // registry pull requests: few, and each one runs CI
};

function cors(res, origin, methods) {
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Cache-Control', 'no-store');
}

/**
 * The origin and the signed-in author, or a response already sent (returns null).
 * Handles the CORS preflight. `methods` is what the endpoint answers.
 */
export function authorise(req, res, methods) {
  res.setHeader('X-Registry-Version', BUNDLE.sha);
  res.setHeader('X-Function-Version', BUNDLE.function_sha ?? 'local');
  const page = PAGES.resolve(req.headers.origin);
  if (!page.ok) {
    console.warn(`author: origin rejected: ${req.headers.origin ?? '<none>'} (${page.reason})`);
    send(res, 403, { error: req.headers.origin ? 'origin not allowed' : 'origin required' });
    return null;
  }
  cors(res, page.origin, `${methods}, OPTIONS`);
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return null;
  }
  if (!methods.split(', ').includes(req.method)) {
    res.setHeader('Allow', `${methods}, OPTIONS`);
    send(res, 405, { error: 'method not allowed' });
    return null;
  }
  const raw = req.headers.authorization;
  const header = Array.isArray(raw) ? raw[0] : raw;
  const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const identity = token && IDENTITY_SECRET ? readIdentity(IDENTITY_SECRET, token, page.origin) : null;
  if (!identity) {
    console.warn(`author: ${token ? 'identity invalid or for another origin' : 'no identity'} from ${page.origin}`);
    send(res, 401, { error: 'identity required', userMessage: 'Please sign in with GitHub again.' });
    return null;
  }
  return { origin: page.origin, identity, tag: `login=${identity.login}` };
}

const lower = (s) => String(s).toLowerCase();

/** Books this login may work on: live or preview, with the login in `authors`. */
export function booksFor(identity) {
  const me = lower(identity.login);
  return REGISTRY.books.filter((b) => b.status !== 'retired' && (b.authors ?? []).some((a) => lower(a) === me));
}

/**
 * The book named by `slug`, if this author may work on it, else a response is sent
 * and null returned. The same answer for a book that doesn't exist, a retired book
 * and one they aren't an author of: which books exist is not the point here.
 */
export function bookFor(slug, auth, res) {
  const book = typeof slug === 'string' ? booksFor(auth.identity).find((b) => b.slug === slug) : undefined;
  if (!book) {
    console.warn(`author: @${auth.identity.login} is not an author of ${JSON.stringify(slug)}`);
    send(res, 403, { error: 'not an author of that book', userMessage: "Your account isn't one of this book's authors." });
    return null;
  }
  if (!book.content.drafts_branch || book.content.drafts_branch === book.content.live_branch) {
    send(res, 409, { error: 'no drafts branch', userMessage: 'This book has no drafts area separate from what readers see.' });
    return null;
  }
  return book;
}

/** "by @login via the author site": every write says who did it. */
export const byline = (identity) => `by @${identity.login} via the author site`;

/** The commit author for work an author sends. */
export const commitAuthor = (identity) => ({ name: identity.name || identity.login, email: noreplyEmail(identity) });

// ---------------------------------------------------------------------------
// GitHub, as the App
// ---------------------------------------------------------------------------

export class GitHubError extends Error {
  constructor(what, status, userMessage) {
    super(`${what} failed (status ${status})`);
    this.status = status;
    if (userMessage) this.userMessage = userMessage;
  }
}

/** Refused with a message the author can act on, and nothing written. */
export class Refusal extends Error {
  constructor(status, error, userMessage, extra = {}) {
    super(error);
    Object.assign(this, { status, userMessage, extra });
  }
}

/** A clock for one request: each call gets min(perCall, what's left). */
export function budget(ms, perCall = 8000) {
  const deadline = Date.now() + ms;
  return () => {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error('github budget exhausted');
    return Math.min(perCall, left);
  };
}

/**
 * One App credential per endpoint module, downscoped per repository. Returns
 * `{ token, refused() }`, or throws a Refusal the author can read. Pass `used` (an
 * array) to collect every credential a request took, so a 401 can drop them all.
 */
export function appCredentials(permissions) {
  const credentials = createCredentials(process.env, permissions);
  return async function appToken(book, tag, used) {
    const c = await credentials.acquire(book, tag);
    if (!c.ok) {
      throw new Refusal(c.status, c.error, c.error.includes("isn't installed")
        ? "The author site isn't switched on for this book yet. Ask the platform's technical contact."
        : 'GitHub could not be reached just now. Please try again in a moment.');
    }
    if (c.kind !== 'app') {
      console.error(`credential=${c.kind} refused for the author site: only the App may act for an author ${tag}`);
      throw new Refusal(502, 'github: app credential unavailable',
        'GitHub could not be reached just now. Please try again in a moment.');
    }
    console.log(`credential=app for ${book.content.repo} ${tag}`);
    const out = { token: c.token, refused: () => credentials.refused(book, c) };
    used?.push(out);
    return out;
  };
}

/** A GitHub call that throws GitHubError on anything but `ok` (or an allowed status). */
export async function gh(pathname, token, left, { method = 'GET', body, allow = [] } = {}) {
  const res = await githubFetch(pathname, { token, method, body, timeoutMs: left() });
  if (res.ok || allow.includes(res.status)) return res;
  console.error(`github: ${method} ${pathname.split('?')[0]} returned ${res.status} — ${await detailOf(res)}`);
  throw new GitHubError(`${method} ${pathname.split('?')[0]}`, res.status);
}

export const ghJson = async (...args) => {
  const res = await gh(...args);
  return res.status === 204 ? null : res.json();
};

/** The drafts branch's head commit. */
export async function draftsHead(book, token, left) {
  const ref = await ghJson(`/repos/${book.content.repo}/git/ref/heads/${encodePath(book.content.drafts_branch)}`, token, left);
  const sha = ref?.object?.sha;
  if (typeof sha !== 'string') throw new Error('drafts ref returned no sha');
  return sha;
}

/**
 * The whole tree at a commit: { tree, files: Map<path, { sha, size, type }> }. A
 * truncated listing is refused: a partial one could hide a file a send would clobber.
 */
export async function treeAt(repo, commit, token, left) {
  const c = await ghJson(`/repos/${repo}/git/commits/${commit}`, token, left);
  const treeSha = c?.tree?.sha;
  if (typeof treeSha !== 'string') throw new Error('commit returned no tree');
  const t = await ghJson(`/repos/${repo}/git/trees/${treeSha}?recursive=1`, token, left);
  if (t?.truncated) throw new Refusal(413, 'tree truncated', 'This book is too large to be read in one go. Ask the technical contact.');
  const files = new Map();
  for (const e of t?.tree ?? []) {
    if (e?.type === 'blob' && typeof e.path === 'string') files.set(e.path, { sha: e.sha, size: e.size ?? 0 });
  }
  return { tree: treeSha, files };
}

/** A blob's bytes. */
export async function blobBytes(repo, sha, token, left) {
  const b = await ghJson(`/repos/${repo}/git/blobs/${sha}`, token, left);
  if (b?.encoding !== 'base64' || typeof b.content !== 'string') throw new Error(`blob ${sha} has encoding ${b?.encoding}`);
  return Buffer.from(b.content.replace(/\s+/g, ''), 'base64');
}

// ---------------------------------------------------------------------------
// The one send path: a commit on drafts, on top of the head the author read
// ---------------------------------------------------------------------------

const MAX_PATCH = 20_000;

/**
 * What changed on drafts between the author's base and the head now, for the
 * conflict view: the commits and files, each file with its patch (trimmed).
 */
export async function changesSince(book, base, head, token, left) {
  const c = await ghJson(`/repos/${book.content.repo}/compare/${base}...${head}`, token, left);
  return {
    head,
    commits: (c?.commits ?? []).slice(-40).map((x) => ({
      sha: x.sha,
      who: x.author?.login || x.commit?.author?.name || 'someone',
      when: x.commit?.author?.date ?? null,
      message: String(x.commit?.message ?? '').split('\n')[0],
      url: x.html_url ?? '',
    })),
    files: (c?.files ?? []).slice(0, 100).map((f) => ({
      path: f.filename,
      status: f.status,
      added: f.additions ?? 0,
      removed: f.deletions ?? 0,
      patch: typeof f.patch === 'string' ? (f.patch.length > MAX_PATCH ? `${f.patch.slice(0, MAX_PATCH)}\n… (trimmed)` : f.patch) : null,
    })),
  };
}

/** Nothing was written; the author is shown what moved (409 { conflict }). */
async function conflict(book, base, head, token, left, tag) {
  console.warn(`conflict: drafts moved from ${base.slice(0, 7)} to ${head.slice(0, 7)}; nothing written ${tag}`);
  let changes = { head, commits: [], files: [] };
  try {
    changes = await changesSince(book, base, head, token, left);
  } catch (err) {
    console.warn(`conflict: could not describe the change — ${err.message} ${tag}`);
  }
  return new Refusal(409, 'conflict', 'Something else changed the drafts area since you looked, so nothing was sent.', { conflict: changes });
}

/**
 * One commit on the drafts branch, whose parent is exactly `base`, then the branch
 * moved to it without force. If drafts is not at `base` (before, or by the time the
 * branch is moved) nothing is written and a 409 Refusal carries what moved.
 *
 * @param {object} o
 * @param {Array<{ path: string, bytes?: Buffer, blob?: string }>} o.writes
 *   bytes to upload, or `blob`, a sha already created in this repo
 * @param {string[]} o.deletes paths to remove (ignored if already absent)
 * @param {string | ((written: string[], deleted: string[]) => string)} o.message
 *   the subject line, or a function of what is actually being changed
 * @returns {{ sha, url, written: string[], deleted: string[] }}
 */
export async function commitToDrafts({ book, token, left, base, writes, deletes = [], message, identity, tag }) {
  const repo = book.content.repo;
  const head = await draftsHead(book, token, left);
  if (head !== base) throw await conflict(book, base, head, token, left, tag);

  const { tree, files } = await treeAt(repo, base, token, left);
  const entries = [];
  const written = [];
  for (const w of writes) {
    const sha = w.blob ?? blobSha(w.bytes);
    if (files.get(w.path)?.sha === sha) continue; // already exactly this
    let blob = w.blob;
    if (!blob) {
      const made = await ghJson(`/repos/${repo}/git/blobs`, token, left, {
        method: 'POST', body: { content: w.bytes.toString('base64'), encoding: 'base64' },
      });
      blob = made?.sha;
      if (blob !== sha) throw new Error(`blob for ${w.path} came back as ${blob}, expected ${sha}`);
    }
    entries.push({ path: w.path, mode: '100644', type: 'blob', sha: blob });
    written.push(w.path);
  }
  const deleted = [];
  for (const path of deletes) {
    if (!files.has(path)) continue;
    entries.push({ path, mode: '100644', type: 'blob', sha: null });
    deleted.push(path);
  }
  if (!entries.length) throw new Refusal(400, 'nothing to send', 'The drafts area already has exactly this, so there was nothing to send.');

  const subject = typeof message === 'function' ? message(written, deleted) : message;
  const newTree = await ghJson(`/repos/${repo}/git/trees`, token, left, { method: 'POST', body: { base_tree: tree, tree: entries } });
  const now = new Date().toISOString();
  const commit = await ghJson(`/repos/${repo}/git/commits`, token, left, {
    method: 'POST',
    body: {
      message: `${subject}\n\nSent ${byline(identity)}.`,
      tree: newTree.sha,
      parents: [base],
      author: { ...commitAuthor(identity), date: now },
      committer: { ...COMMITTER, date: now },
    },
  });
  const moved = await gh(`/repos/${repo}/git/refs/heads/${encodePath(book.content.drafts_branch)}`, token, left, {
    method: 'PATCH', body: { sha: commit.sha, force: false }, allow: [409, 422],
  });
  if (!moved.ok) {
    const now2 = await draftsHead(book, token, left);
    if (now2 !== base) throw await conflict(book, base, now2, token, left, tag);
    throw new GitHubError('move drafts', moved.status);
  }
  console.log(`sent ${commit.sha.slice(0, 7)} to ${repo}@${book.content.drafts_branch}: ${written.length} written, ${deleted.length} deleted ${tag}`);
  return { sha: commit.sha, url: `https://github.com/${repo}/commit/${commit.sha}`, written, deleted };
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/** Turn anything thrown in a handler into the response the author sees. */
export function fail(res, err, tag, refusedCredential) {
  if (err instanceof Refusal) {
    send(res, err.status, { error: err.message, userMessage: err.userMessage, ...err.extra });
    return;
  }
  if (err.status === 401 && refusedCredential) refusedCredential();
  console.error(`author: ${err.message} ${tag}`);
  send(res, 502, {
    error: `github: ${err.message}`,
    userMessage: err.userMessage ?? 'GitHub could not be reached just now. Nothing was changed. Please try again.',
  });
}

/** Query parameters of a GET. */
export const query = (req) => new URL(req.url ?? '/', 'https://local.invalid').searchParams;

/** A handler wrapper: nothing thrown reaches Vercel as an unlabelled 500. */
export function wrap(handle) {
  return async function handler(req, res) {
    try {
      await handle(req, res);
    } catch (err) {
      console.error('author unhandled:', err);
      if (!res.headersSent) send(res, 500, { error: 'unhandled server error' });
      else res.end();
    }
  };
}
