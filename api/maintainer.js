/**
 * The platform maintainer's endpoints: test books, made and removed from the author site.
 *
 *   GET  /api/maintainer/test-books                         -> 200 { is_maintainer: true }
 *   POST /api/maintainer/test-books { part }                -> 201 { sha }  (one file part, as request-book's)
 *   POST /api/maintainer/test-books { title, slug?, content_type?, files? }
 *                                                           -> 201 { slug, issue: { number, html_url } }
 *   POST /api/maintainer/test-books/<slug>/remove           -> 202 { slug, issue }
 *
 * Who: only through the author site's proxy, as a member it asserts (lib/author.mjs
 * authorise: the origin, then the single-use assertion read back from the author site),
 * and only a member whose id is in MAINTAINER_MEMBER_IDS (wrangler.toml [vars],
 * comma-separated ids without "m-"). Anyone else, signed in or not, gets 403
 * { error: "forbidden" } and nothing more. The author site hides the buttons too, but
 * that is only cosmetic: this is the check.
 *
 * Making one: the request is filed exactly as the portal's form files one
 * (request-book's fileRequest), with `sandbox: true` and the labels `maintainer` and
 * `approved` in the same call, so book-requests' provision runs at once, as for an
 * approved public request. The issue is opened by this function's App, which is what
 * provision checks before it accepts `sandbox: true`.
 *
 * Removing one: refused unless the registry has the slug with `sandbox: true`; then the
 * `remove` label goes on its request issue, which runs book-requests' remove.
 */
import BUNDLE from '../registry/bundled.mjs';
import { REGISTRY, appCredentials, authorise, fail } from '../lib/author.mjs';
import { githubFetch, parseBody, send, withLabels } from '../lib/common.mjs';
import { TYPES, checkFiles, fileRequest, slugify, storePart } from './request-book.js';

const REQUESTS_REPO = 'textbookproject2026-alt/book-requests';
const REQUESTS_BOOK = { slug: 'book-requests', content: { repo: REQUESTS_REPO } };
const appToken = appCredentials({ issues: 'write' });
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PREFIX = 'test-';
const MAX_SLUG = 40; // book-requests' parseRequest
const REMOVE_RE = /^\/api\/maintainer\/test-books\/([a-z0-9-]{1,80})\/remove$/;

const forbidden = (res) => send(res, 403, { error: 'forbidden' });

/** The maintainers' member ids (10 hex digits each), from MAINTAINER_MEMBER_IDS. */
export const maintainerIds = (env = process.env) =>
  new Set(String(env.MAINTAINER_MEMBER_IDS ?? '').split(',').map((s) => s.trim().replace(/^m-/, '')).filter((s) => /^[0-9a-f]{10}$/.test(s)));

/** The slug a test book gets: test- + the title's (or the one asked for), at most 40 characters. */
export function testSlug(title, asked) {
  let base = typeof asked === 'string' && asked.trim() ? asked.trim().toLowerCase() : slugify(String(title ?? ''));
  if (!base.startsWith(PREFIX)) base = PREFIX + base;
  base = base.slice(0, MAX_SLUG).replace(/-+$/, '');
  return SLUG_RE.test(base) && base.length > PREFIX.length ? base : null;
}

/** The request block's slug in an issue body (the last ```json block), or null. */
function slugOfIssue(body) {
  const blocks = [...String(body ?? '').matchAll(/(`{3,})json\n([\s\S]*?)\n\1/g)];
  try {
    return JSON.parse(blocks.at(-1)?.[2] ?? 'null')?.slug ?? null;
  } catch {
    return null;
  }
}

/** The requests repo's issues labelled `maintainer` (test books), newest first. */
async function testBookIssues(token, state) {
  const res = await githubFetch(`/repos/${REQUESTS_REPO}/issues?labels=maintainer&state=${state}&per_page=100`, { token });
  if (!res.ok) throw Object.assign(new Error(`github issues list: ${res.status}`), { status: res.status });
  return (await res.json()).filter((i) => !i.pull_request).map((i) => ({ number: i.number, html_url: i.html_url, slug: slugOfIssue(i.body) }));
}

/** The registry's entry for a slug: the bundled one, else the live one (a book made minutes ago). */
async function registryEntry(slug) {
  const bundled = REGISTRY.books.find((b) => b.slug === slug);
  if (bundled) return bundled;
  try {
    const res = await fetch('https://raw.githubusercontent.com/textbookproject2026-alt/textbook-registry/main/registry.json', { signal: AbortSignal.timeout(5000) });
    return res.ok ? ((await res.json()).books ?? []).find((b) => b.slug === slug) ?? null : null;
  } catch {
    return null;
  }
}

async function create(body, auth, res) {
  if (typeof body.part === 'string') {
    const [status, payload] = await storePart(body.part);
    send(res, status, payload);
    return;
  }
  const title = typeof body.title === 'string' ? body.title.replace(/\s+/g, ' ').trim() : '';
  if (title.length < 3 || title.length > 200) {
    send(res, 400, { error: 'validation: title', userMessage: 'Give the test book a title (3 to 200 characters).' });
    return;
  }
  const type = typeof body.content_type === 'string' && body.content_type ? body.content_type : 'book';
  if (!TYPES.includes(type)) {
    send(res, 400, { error: 'validation: content_type', userMessage: 'Choose a book, paper, report or article.' });
    return;
  }
  const slug = testSlug(title, body.slug);
  if (!slug) {
    send(res, 400, { error: 'validation: slug', userMessage: 'That address can only use lower-case letters, digits and single hyphens.' });
    return;
  }
  const files = checkFiles(body.files);
  if (!files.ok) {
    send(res, 400, { error: `validation: ${files.why}`, userMessage: files.user ?? 'One of the files could not be read.' });
    return;
  }
  // Any registry entry, live, preview, retired or sandbox, keeps its slug; so does a test
  // book still being set up (its issue is open, its entry not merged yet).
  const credential = await appToken(REQUESTS_BOOK, 'maintainer');
  const taken = REGISTRY.books.some((b) => b.slug === slug) || (await registryEntry(slug)) || (await testBookIssues(credential.token, 'open')).some((i) => i.slug === slug);
  if (taken) {
    send(res, 409, { error: 'slug taken', userMessage: `The address ${slug} is already taken. Choose another title.` });
    return;
  }
  const d = {
    title, type, authors: [auth.identity.name], email: null, github: '', topic: '', link: '', notes: '',
    summary: `A test book made by ${auth.identity.name} on the author site. Not published; it will be removed.`,
    files: files.files,
  };
  const [status, payload] = await fileRequest(d, { slug, labels: ['maintainer', 'approved'], maintainer: { id: auth.identity.memberId, name: auth.identity.name } });
  send(res, status, status === 201 ? { slug, issue: payload.issue, ...(payload.userMessage ? { userMessage: payload.userMessage } : {}) } : payload);
}

async function remove(slug, res) {
  const entry = await registryEntry(slug);
  if (!entry) {
    send(res, 404, { error: 'no such book', userMessage: 'No book has that address yet. If it was made a moment ago, try again in a few minutes.' });
    return;
  }
  if (entry.sandbox !== true) {
    send(res, 403, { error: 'not a test book', userMessage: 'Only a test book can be removed here.' });
    return;
  }
  const credential = await appToken(REQUESTS_BOOK, 'maintainer');
  const issue = (await testBookIssues(credential.token, 'all')).find((i) => i.slug === slug);
  if (!issue) {
    send(res, 409, { error: 'no request issue', userMessage: "This test book wasn't made here: remove it with book-requests' remove workflow (Actions)." });
    return;
  }
  const labelled = await withLabels(REQUESTS_REPO, credential.token, { remove: { color: 'b60205', description: 'Take a sandbox book down completely' } }, () =>
    githubFetch(`/repos/${REQUESTS_REPO}/issues/${issue.number}/labels`, { token: credential.token, method: 'POST', body: { labels: ['remove'] } }));
  if (!labelled.ok) {
    console.error(`maintainer: remove label on #${issue.number}: ${labelled.status}`);
    send(res, 502, { error: `github: ${labelled.status}`, userMessage: "GitHub couldn't be reached just now. Nothing was changed. Try again." });
    return;
  }
  console.log(`maintainer: remove ${slug} (book-requests #${issue.number})`);
  send(res, 202, { slug, issue: { number: issue.number, html_url: issue.html_url } });
}

export default async function handler(req, res) {
  try {
    res.setHeader('X-Function-Version', BUNDLE.function_sha ?? 'local');
    const raw = req.headers.authorization;
    const header = Array.isArray(raw) ? raw[0] : raw;
    // Not through the author site as a member: no detail.
    if (typeof header !== 'string' || !header.startsWith('Member ')) return forbidden(res);
    const auth = await authorise(req, res, 'GET, POST');
    if (!auth) return; // answered (origin, or an assertion that didn't check out)
    if (!auth.identity.member || !maintainerIds().has(auth.identity.memberId)) {
      console.warn(`maintainer: refused ${auth.tag}`);
      return forbidden(res);
    }
    const path = new URL(req.url ?? '/', 'https://local.invalid').pathname;
    if (path === '/api/maintainer/test-books') {
      if (req.method === 'GET') return send(res, 200, { is_maintainer: true });
      let body = null;
      try {
        body = parseBody(req);
      } catch {
        /* checked below */
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, { error: 'body was not a json object' });
      return await create(body, auth, res);
    }
    const slug = REMOVE_RE.exec(path)?.[1];
    if (slug && req.method === 'POST') return await remove(slug, res);
    send(res, 404, { error: 'not found' });
  } catch (err) {
    if (!res.headersSent) fail(res, err, 'maintainer');
    else res.end();
  }
}
