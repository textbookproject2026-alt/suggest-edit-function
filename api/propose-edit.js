/**
 * /api/propose-edit — the in-site editor's back end ("Edit this page", and the
 * per-paragraph pencil). A reader's edit becomes a real pull request into the
 * book's drafts branch, opened by the GitHub App, so editors review it in the
 * Files changed tab like any other PR. Nothing reaches the live branch without a
 * human merge.
 *
 *   GET  ?path=<repo path>
 *     -> 200 { path, branch, sha, content, signIn }
 *        The page's source on the drafts branch (LF line endings), and the blob sha
 *        the edit will be based on. `signIn` says whether GitHub sign-in is on.
 *
 *   POST JSON {
 *     mode: "page" | "paragraph", path, baseSha,
 *     content                                   (page: the whole new file)
 *     startLine, original, replacement, paragraph?   (paragraph: 0-based first
 *                                                line of `original` at baseSha)
 *     title, description,
 *     identity                                  (from /api/github-auth), or
 *     name, email, website                      (anonymous; website = honeypot)
 *   }
 *     -> 201 { prUrl }                          applied: a PR is open
 *     -> 201 { issueUrl, fallback: true }       the drafts branch moved under the
 *                                               reader and the edit no longer applies
 *                                               cleanly: their text is filed as an
 *                                               issue instead, so nothing is lost
 *     -> 4xx/5xx { error, userMessage? }        as suggest-edit: `error` is log
 *                                               material, `userMessage` safe to show
 *
 * The book comes from the Origin, against the registry, exactly as suggest-edit.
 * Signed in, the commit's author is the reader's GitHub account (its noreply
 * address), so the contribution counts on their profile and the contributors page.
 * Anonymous, the App is the author and the reader's name and masked email are in
 * the PR body only, never in git history.
 *
 * Needs the App's Contents and Pull requests permissions (README, "The App").
 */
import { randomBytes } from 'node:crypto';
import BUNDLE from '../registry/bundled.mjs';
import { validateRegistry, createResolver } from '../lib/registry.mjs';
import {
  EMAIL_RE, asString, clientIp, corsHeaders, createCredentials, createRateLimiter, detailOf,
  ensureLabels, fence, fileUrl, githubFetch, inlineCode, isJsonContentType, isSafePath, maskEmail,
  parseBody, resolveBook, send,
} from '../lib/common.mjs';
import { noreplyEmail, readIdentity, readIdentitySecret } from '../lib/identity.mjs';

const REGISTRY = validateRegistry(BUNDLE.registry);
const RESOLVER = createResolver(REGISTRY);

const CREDENTIALS = createCredentials(process.env, {
  contents: 'write',
  pull_requests: 'write',
  issues: 'write', // labels, and the fallback issue
});
const IDENTITY_SECRET = readIdentitySecret(process.env);
const SIGN_IN = Boolean(
  IDENTITY_SECRET && process.env.GITHUB_OAUTH_CLIENT_ID?.trim() && process.env.GITHUB_OAUTH_CLIENT_SECRET?.trim(),
);

const LABEL_DEFAULTS = {
  'proposed-edit': { color: '1d76db', description: 'Reader edit from the in-site editor' },
  'needs-triage': { color: 'fbca04', description: 'Not yet reviewed by an editor' },
};

const MAX_CONTENT = 400_000; // characters; chapters are well under this
const MAX_BLOCK = 20_000;
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 5000;
const MAX_NAME = 200;
const MAX_EMAIL = 254;
const MAX_ISSUE_DIFF = 60_000;
const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

// Every GitHub call in one request shares this, inside maxDuration (vercel.json, 25s).
const BUDGET_MS = 20_000;
const LABEL_BUDGET_MS = 2500;

const writeLimited = createRateLimiter(5, 60 * 60 * 1000);
const readLimited = createRateLimiter(60, 60 * 60 * 1000);

const GENERIC = 'Something went wrong sending your edit. Please try again.';
// Setup problems a book owner has to fix (the App not installed, or its permissions
// not yet approved, on that book's repo): the reader is told plainly and pointed at
// the form that still works, instead of a generic "couldn't load".
const NOT_SET_UP =
  "Editing isn't switched on for this book yet. Please use “Suggest an edit” instead.";
const NO_BRANCH =
  "This book isn't set up to take edits yet (it has no drafts branch). Please use “Suggest an edit” instead.";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const encodePath = (path) => path.split('/').map(encodeURIComponent).join('/');
const toLf = (text) => text.replace(/\r\n/g, '\n');
const baseBranch = (book) => book.content.drafts_branch || book.content.live_branch;
const basename = (path) => path.split('/').pop().replace(/\.md$/, '');

class Conflict extends Error {}

/** A clock for one request: each call gets min(8s, what's left). */
function budget(ms = BUDGET_MS) {
  const deadline = Date.now() + ms;
  return () => {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error('github budget exhausted');
    return Math.min(8000, left);
  };
}

async function gh(pathname, token, left, opts = {}) {
  return githubFetch(pathname, { token, timeoutMs: left(), ...opts });
}

async function fail(what, res) {
  console.error(`${what}: GitHub returned ${res.status} — ${await detailOf(res)}`);
  const err = new Error(`${what} failed (status ${res.status})`);
  err.status = res.status;
  return err;
}

/** The branch head's commit sha, and the file's text and blob sha at that commit. */
async function readSource(book, path, token, left) {
  const branch = baseBranch(book);
  const ref = await gh(`/repos/${book.content.repo}/git/ref/heads/${encodePath(branch)}`, token, left);
  if (!ref.ok) {
    const err = await fail(`read ${branch} ref`, ref);
    if (ref.status === 404) err.userMessage = NO_BRANCH;
    throw err;
  }
  const commit = (await ref.json())?.object?.sha;
  if (typeof commit !== 'string') throw new Error('branch ref returned no sha');

  const file = await gh(`/repos/${book.content.repo}/contents/${encodePath(path)}?ref=${commit}`, token, left);
  if (file.status === 404) return { branch, commit, missing: true };
  if (!file.ok) throw await fail('read file', file);
  const data = await file.json();
  if (data?.type !== 'file' || typeof data.sha !== 'string') return { branch, commit, missing: true };
  // The contents API leaves `content` empty for files over 1 MB.
  if (data.encoding !== 'base64' || typeof data.content !== 'string') return { branch, commit, tooLarge: true };
  const raw = Buffer.from(data.content, 'base64').toString('utf8');
  return { branch, commit, sha: data.sha, raw, text: toLf(raw), crlf: raw.includes('\r\n') };
}

/**
 * The new file, or a Conflict when the edit no longer applies where the reader
 * made it. Paragraph mode is exact on the reader's own snapshot (same blob sha:
 * the lines are where they saw them), and on a moved branch still applies when
 * the paragraph occurs exactly once.
 */
export function applyEdit(current, edit) {
  if (edit.mode === 'page') {
    if (current.sha !== edit.baseSha) throw new Conflict('the file changed since the editor opened');
    return toLf(edit.content);
  }
  const original = toLf(edit.original);
  const replacement = toLf(edit.replacement);
  if (current.sha === edit.baseSha) {
    const lines = current.text.split('\n');
    const n = original.split('\n').length;
    if (lines.slice(edit.startLine, edit.startLine + n).join('\n') === original) {
      lines.splice(edit.startLine, n, ...replacement.split('\n'));
      return lines.join('\n');
    }
  }
  const first = current.text.indexOf(original);
  if (first === -1 || current.text.indexOf(original, first + 1) !== -1) {
    throw new Conflict('the paragraph is no longer there exactly once');
  }
  return current.text.slice(0, first) + replacement + current.text.slice(first + original.length);
}

/** A readable line diff for an issue: the changed middle, after the common ends. */
export function lineDiff(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const out = [`@@ line ${start + 1} @@`];
  for (const l of a.slice(start, endA)) out.push(`-${l}`);
  for (const l of b.slice(start, endB)) out.push(`+${l}`);
  const text = out.join('\n');
  return text.length > MAX_ISSUE_DIFF ? `${text.slice(0, MAX_ISSUE_DIFF)}\n… (truncated)` : text;
}

function proposer(data) {
  return data.identity
    ? `@${data.identity.login} (signed in with GitHub)`
    : `${inlineCode(data.name)} (${inlineCode(maskEmail(data.email))})`;
}

function fenced(text, lang = 'text') {
  const f = fence(text);
  return [`${f}${lang}`, text, f];
}

function prBody(book, branch, data) {
  const parts = [`**File:** [\`${data.path}\`](${fileUrl(book, data.path, branch)})`];
  if (data.mode === 'paragraph' && data.paragraph) parts.push(`**Where:** ¶${data.paragraph}`);
  if (data.description) parts.push('', '### Description', '', ...fenced(data.description));
  parts.push(
    '',
    '---',
    '',
    `**Proposed by:** ${proposer(data)}`,
    '',
    `_proposed with the in-site editor. Review **Files changed**, then merge into \`${branch}\` or close._`,
  );
  return parts.join('\n');
}

function issueBody(book, branch, data, diff) {
  const parts = [
    `**File:** [\`${data.path}\`](${fileUrl(book, data.path, branch)})`,
    '',
    `The page changed on \`${branch}\` while the reader was editing, so their edit could not be applied automatically. Their change, against the version they edited:`,
    '',
    ...fenced(diff, 'diff'),
  ];
  if (data.description) parts.push('', '### Description', '', ...fenced(data.description));
  parts.push('', '---', '', `**Proposed by:** ${proposer(data)}`, '', '_proposed with the in-site editor_');
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validate(body, origin) {
  const reject = (error, userMessage) => ({ ok: false, status: 400, error, userMessage });
  const mode = body.mode;
  if (mode !== 'page' && mode !== 'paragraph') return reject('validation: mode', GENERIC);

  const path = asString(body.path);
  if (!path || !isSafePath(path)) return reject('validation: path rejected', 'We could not tell which page this is.');
  const baseSha = asString(body.baseSha);
  if (!SHA_RE.test(baseSha)) return reject('validation: baseSha', GENERIC);

  const data = { mode, path, baseSha };
  if (mode === 'page') {
    if (typeof body.content !== 'string') return reject('validation: content missing', GENERIC);
    if (body.content.length > MAX_CONTENT) return reject('validation: content too long', 'That page is too long to send from here.');
    data.content = body.content;
  } else {
    const { startLine, original, replacement, paragraph } = body;
    if (!Number.isSafeInteger(startLine) || startLine < 0) return reject('validation: startLine', GENERIC);
    if (typeof original !== 'string' || !original.trim() || original.length > MAX_BLOCK) {
      return reject('validation: original', GENERIC);
    }
    if (typeof replacement !== 'string' || replacement.length > MAX_BLOCK) {
      return reject('validation: replacement', 'That paragraph is too long to send from here.');
    }
    Object.assign(data, { startLine, original, replacement });
    if (Number.isSafeInteger(paragraph) && paragraph > 0) data.paragraph = paragraph;
  }

  const title = asString(body.title).replace(/\s+/g, ' ');
  if (title.length > MAX_TITLE) return reject('validation: title too long', `Please keep the title under ${MAX_TITLE} characters.`);
  data.title = title || `Update ${basename(path)}`;
  const description = asString(body.description);
  if (description.length > MAX_DESCRIPTION) {
    return reject('validation: description too long', `Please keep the description under ${MAX_DESCRIPTION} characters.`);
  }
  data.description = description;

  const identityToken = asString(body.identity);
  if (identityToken) {
    const identity = IDENTITY_SECRET ? readIdentity(IDENTITY_SECRET, identityToken, origin) : null;
    if (!identity) {
      return {
        ok: false,
        status: 401,
        error: 'identity invalid',
        userMessage: 'Your GitHub sign-in has expired. Sign in again, or send it without signing in.',
      };
    }
    data.identity = identity;
    return { ok: true, data };
  }

  const name = asString(body.name);
  const email = asString(body.email);
  if (!name) return reject('validation: name missing', 'Please include your name.');
  if (name.length > MAX_NAME) return reject('validation: name too long', 'That name is too long — please shorten it.');
  if (!email) return reject('validation: email missing', 'Please include your email address.');
  if (email.length > MAX_EMAIL || !EMAIL_RE.test(email)) {
    return reject('validation: email malformed', 'That email address does not look right.');
  }
  Object.assign(data, { name, email });
  return { ok: true, data };
}

// ---------------------------------------------------------------------------
// Writing to GitHub
// ---------------------------------------------------------------------------

async function openPullRequest(book, token, left, current, newText, data, tag) {
  const repo = book.content.repo;
  const slug = basename(data.path).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'page';
  const branch = `proposed-edits/${slug}-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`;

  const ref = await gh(`/repos/${repo}/git/refs`, token, left, {
    method: 'POST',
    body: { ref: `refs/heads/${branch}`, sha: current.commit },
  });
  if (!ref.ok) throw await fail('create branch', ref);

  try {
    const out = current.crlf ? newText.replace(/\n/g, '\r\n') : newText;
    const message = [
      data.title,
      data.description,
      data.identity ? '' : 'Proposed by a reader with the in-site editor.',
    ].filter(Boolean).join('\n\n');
    const put = await gh(`/repos/${repo}/contents/${encodePath(data.path)}`, token, left, {
      method: 'PUT',
      body: {
        message,
        content: Buffer.from(out, 'utf8').toString('base64'),
        sha: current.sha,
        branch,
        ...(data.identity
          ? { author: { name: data.identity.name || data.identity.login, email: noreplyEmail(data.identity) } }
          : {}),
      },
    });
    if (put.status === 409) throw new Conflict('the file moved during the commit');
    if (!put.ok) throw await fail('commit', put);

    const pr = await gh(`/repos/${repo}/pulls`, token, left, {
      method: 'POST',
      body: { title: data.title, head: branch, base: current.branch, body: prBody(book, current.branch, data) },
    });
    if (!pr.ok) throw await fail('open pull request', pr);
    const opened = await pr.json();
    if (!opened?.html_url) throw new Error('pull request returned no url');
    if (String(opened.base?.repo?.full_name).toLowerCase() !== repo.toLowerCase()) {
      console.error(`ROUTING: pull request ${opened.html_url} opened on ${opened.base?.repo?.full_name}, expected ${repo} ${tag}`);
    }

    // Labels are cosmetic: never let them fail a PR that exists.
    try {
      await ensureLabels(repo, token, LABEL_DEFAULTS, LABEL_BUDGET_MS);
      const labelled = await gh(`/repos/${repo}/issues/${opened.number}/labels`, token, left, {
        method: 'POST',
        body: { labels: Object.keys(LABEL_DEFAULTS) },
      });
      if (!labelled.ok) console.warn(`labels: GitHub returned ${labelled.status} ${tag}`);
    } catch (err) {
      console.warn(`labels: skipped — ${err.message} ${tag}`);
    }
    return opened.html_url;
  } catch (err) {
    // Don't leave an orphan branch behind a failed proposal.
    try {
      await githubFetch(`/repos/${repo}/git/refs/heads/${encodePath(branch)}`, { token, method: 'DELETE', timeoutMs: 3000 });
    } catch {
      console.warn(`cleanup: could not delete ${branch} ${tag}`);
    }
    throw err;
  }
}

async function fileFallbackIssue(book, token, left, current, data) {
  let before = null;
  const blob = await gh(`/repos/${book.content.repo}/git/blobs/${data.baseSha}`, token, left);
  if (blob.ok) {
    const b = await blob.json();
    if (b?.encoding === 'base64') before = toLf(Buffer.from(b.content, 'base64').toString('utf8'));
  }
  const diff =
    data.mode === 'paragraph'
      ? lineDiff(toLf(data.original), toLf(data.replacement))
      : lineDiff(before ?? current.text ?? '', toLf(data.content));

  await ensureLabels(book.content.repo, token, LABEL_DEFAULTS, LABEL_BUDGET_MS);
  const res = await gh(`/repos/${book.content.repo}/issues`, token, left, {
    method: 'POST',
    body: {
      title: `Proposed edit (needs a hand): ${data.path}`,
      body: issueBody(book, current.branch, data, diff),
      labels: Object.keys(LABEL_DEFAULTS),
    },
  });
  if (!res.ok) throw await fail('fallback issue', res);
  const issue = await res.json();
  if (!issue?.html_url) throw new Error('fallback issue returned no url');
  return issue.html_url;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handleGet(req, res, book, tag) {
  const ip = clientIp(req);
  if (readLimited(ip, Date.now())) {
    send(res, 429, { error: 'rate limit exceeded', userMessage: 'Too many requests — try again in a little while.' });
    return;
  }
  const params = new URL(req.url ?? '/', 'https://local.invalid').searchParams;
  const path = asString(params.get('path'));
  if (!path || !isSafePath(path)) {
    send(res, 400, { error: 'validation: path rejected', userMessage: 'We could not tell which page this is.' });
    return;
  }
  const credential = await CREDENTIALS.acquire(book, tag);
  if (!credential.ok) {
    send(res, credential.status, { error: credential.error, userMessage: NOT_SET_UP });
    return;
  }
  try {
    const src = await readSource(book, path, credential.token, budget(12_000));
    if (src.missing) {
      send(res, 404, { error: 'source not found', userMessage: "We couldn't find this page's source." });
      return;
    }
    if (src.tooLarge) {
      send(res, 413, { error: 'source too large', userMessage: 'This page is too large to edit here.' });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    send(res, 200, { path, branch: src.branch, sha: src.sha, content: src.text, signIn: SIGN_IN });
  } catch (err) {
    if (err.status === 401) CREDENTIALS.refused(book, credential);
    console.error(`read: ${err.message} ${tag}`);
    send(res, 502, { error: `github: ${err.message}`, ...(err.userMessage ? { userMessage: err.userMessage } : {}) });
  }
}

async function handlePost(req, res, book, origin, tag) {
  if (!isJsonContentType(req)) {
    send(res, 415, { error: 'unsupported content-type', userMessage: GENERIC });
    return;
  }
  let body;
  try {
    body = parseBody(req);
  } catch {
    send(res, 400, { error: 'body was not valid json', userMessage: GENERIC });
    return;
  }
  if (!body || typeof body !== 'object') {
    send(res, 400, { error: 'body was not a json object', userMessage: GENERIC });
    return;
  }

  const ip = clientIp(req);
  // Honeypot: only the anonymous form has the field. A bot gets a success shape.
  if (asString(body.website)) {
    console.warn(`honeypot: discarded proposal from ip=${ip} ${tag}`);
    send(res, 201, { prUrl: `https://github.com/${book.content.repo}/pulls` });
    return;
  }
  if (writeLimited(ip, Date.now())) {
    console.warn(`rate limit: ip=${ip} ${tag}`);
    send(res, 429, { error: 'rate limit exceeded', userMessage: "You're sending edits too quickly — try again in a little while." });
    return;
  }

  const result = validate(body, origin);
  if (!result.ok) {
    console.warn(`${result.error} (ip=${ip}) ${tag}`);
    send(res, result.status, { error: result.error, userMessage: result.userMessage });
    return;
  }
  const { data } = result;

  const credential = await CREDENTIALS.acquire(book, tag);
  if (!credential.ok) {
    send(res, credential.status, { error: credential.error, userMessage: NOT_SET_UP });
    return;
  }

  const left = budget();
  let current;
  try {
    current = await readSource(book, data.path, credential.token, left);
    if (current.missing || current.tooLarge) {
      send(res, 404, { error: 'source not found', userMessage: "We couldn't find this page's source any more." });
      return;
    }
    let newText;
    try {
      newText = applyEdit(current, data);
    } catch (err) {
      if (!(err instanceof Conflict)) throw err;
      console.warn(`conflict: ${err.message}; filing an issue ${tag}`);
      const issueUrl = await fileFallbackIssue(book, credential.token, left, current, data);
      console.log(`fallback issue for "${data.path}" — ${issueUrl} ${tag}`);
      send(res, 201, { issueUrl, fallback: true });
      return;
    }
    if (newText === current.text) {
      send(res, 400, { error: 'validation: no change', userMessage: "You haven't changed anything yet." });
      return;
    }
    try {
      const prUrl = await openPullRequest(book, credential.token, left, current, newText, data, tag);
      console.log(`opened ${prUrl} for "${data.path}" (${data.mode}, ${data.identity ? `@${data.identity.login}` : 'anonymous'}, credential=${credential.kind}) ${tag}`);
      send(res, 201, { prUrl });
    } catch (err) {
      if (!(err instanceof Conflict)) throw err;
      console.warn(`conflict: ${err.message}; filing an issue ${tag}`);
      const issueUrl = await fileFallbackIssue(book, credential.token, left, current, data);
      send(res, 201, { issueUrl, fallback: true });
    }
  } catch (err) {
    if (err.status === 401) CREDENTIALS.refused(book, credential);
    console.error(`github: ${err.message} ${tag}`);
    send(res, 502, { error: `github: ${err.message}`, ...(err.userMessage ? { userMessage: err.userMessage } : {}) });
  }
}

async function handle(req, res) {
  res.setHeader('X-Registry-Version', BUNDLE.sha);
  res.setHeader('X-Function-Version', BUNDLE.function_sha ?? 'local');
  const resolution = resolveBook(RESOLVER, req.headers.origin);
  if (!resolution.ok) {
    console.warn(resolution.log);
    send(res, 403, { error: resolution.error });
    return;
  }
  const { book, origin } = resolution;
  const tag = `book=${book.slug}`;
  corsHeaders(res, origin, 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method === 'GET') return handleGet(req, res, book, tag);
  if (req.method === 'POST') return handlePost(req, res, book, origin, tag);
  res.setHeader('Allow', 'GET, POST, OPTIONS');
  send(res, 405, { error: 'method not allowed' });
}

export default async function handler(req, res) {
  try {
    await handle(req, res);
  } catch (err) {
    console.error('unhandled:', err);
    if (!res.headersSent) send(res, 500, { error: 'unhandled server error' });
    else res.end();
  }
}
