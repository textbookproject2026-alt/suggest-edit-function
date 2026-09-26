/**
 * POST /api/request-book
 *
 * The portal's "Publish your textbook here" form. Files the request as an issue in
 * the platform's PRIVATE requests repo (REQUESTS_REPO, default
 * textbookproject2026-alt/book-requests), with any manuscript files committed
 * beside it under requests/<reference>/. Nothing is published and nothing about
 * the platform changes: a request becomes a book only when the platform owner
 * labels the issue `approved`, which runs book-requests' provision workflow.
 *
 * Private, because a request carries the requester's email address and an
 * unpublished manuscript, and the registry and book repos are public.
 *
 * Contract:
 *   POST JSON { part }                      one piece of a manuscript file
 *     part is base64, at most 2.5 MB decoded. It becomes an unreferenced blob in the
 *     requests repo.
 *     -> 201 { sha }
 *
 *   POST JSON { title, authors, email, summary, topic?, github?, manuscriptLink?,
 *               notes?, agreeLicence, website, files?: [{ name, parts } | { name, data }] }
 *     files[].parts lists the part SHAs in order; files[].data (base64, the whole
 *     file) is still accepted from pages built before parts existed. At most 5
 *     files, .docx or .md, 20 MB decoded in total.
 *     -> 201 { reference }
 *     -> 4xx/5xx { error, userMessage? }
 *
 * Why parts: Vercel refuses request bodies over 4.5 MB, and base64 in JSON adds a
 * third, so a single body can never carry more than ~3 MB of files. Each part is
 * its own request; the final request joins them into one blob per file.
 *
 * Accepted only from the portal: https://<platform.portal.domain> and the portal's
 * own Pages project (lib/registry.mjs createPortalResolver).
 *
 * Credential: the GitHub App, installed on the requests repo, downscoped to issues
 * and contents on that one repo. Zero dependencies.
 */

import BUNDLE from '../registry/bundled.mjs';
import { validateRegistry, createPortalResolver } from '../lib/registry.mjs';
import {
  EMAIL_RE, asString, clientIp, corsHeaders, createCredentials, createRateLimiter, detailOf, ensureLabels,
  fence, githubFetch, inlineCode, isJsonContentType, parseBody, send,
} from '../lib/common.mjs';

const REGISTRY = validateRegistry(BUNDLE.registry);
const PORTAL = createPortalResolver(REGISTRY);

const REPO_RE = /^[A-Za-z0-9](-?[A-Za-z0-9]){0,38}\/[A-Za-z0-9._-]{1,100}$/;
const REQUESTS_REPO = REPO_RE.test(process.env.REQUESTS_REPO ?? '')
  ? process.env.REQUESTS_REPO
  : 'textbookproject2026-alt/book-requests';
const REQUESTS_BRANCH = 'main';

const LABELS = ['book-request', 'needs-review'];
const LABEL_DEFAULTS = {
  'book-request': { color: '6a57e0', description: 'A request to host a textbook, from the portal form' },
  'needs-review': { color: 'fbca04', description: 'Not yet approved or declined' },
};

const LIMITS = { title: 200, authors: 300, email: 254, summary: 300, topic: 60, link: 500, notes: 3000 };
const MIN_SUMMARY = 20;
const MAX_FILES = 5;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const TOTAL_TEXT = '20 MB';
const PART_BYTES = 2.5 * 1024 * 1024; // base64 3.4 MB: under Vercel's 4.5 MB body limit
const MAX_PARTS = Math.ceil(MAX_TOTAL_BYTES / PART_BYTES);
const SHA_RE = /^[0-9a-f]{40}$/;
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const LOGIN_RE = /^[A-Za-z0-9](-?[A-Za-z0-9]){0,38}$/;
// Hostname labels the platform uses or may want; a book never gets one.
const RESERVED_SLUGS = new Set(['www', 'api', 'admin', 'portal', 'mail', 'cms', 'status', 'docs', 'help', 'static']);

const CREDENTIALS = createCredentials(process.env, { issues: 'write', contents: 'write' });
const REQUESTS_BOOK = { slug: 'book-requests', content: { repo: REQUESTS_REPO } };
const isRateLimited = createRateLimiter(3, 60 * 60 * 1000);
// Three requests' worth of parts at the full 20 MB, plus retries.
const isPartRateLimited = createRateLimiter(3 * MAX_PARTS + 6, 60 * 60 * 1000);

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const slugify = (s) =>
  s.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36).replace(/-+$/, '');

/** A free slug to propose. The platform owner can change it before approving. */
export function proposeSlug(title, registry = REGISTRY) {
  const taken = new Set(registry.books.map((b) => b.slug));
  let base = slugify(title);
  if (base.length < 3 || RESERVED_SLUGS.has(base)) base = `book-${base}`.replace(/-+$/, '');
  let slug = base;
  for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
  return slug;
}

/** Accepts only a file name we can safely commit: letters, digits, space, . _ - */
function safeName(name) {
  const cleaned = name.normalize('NFKD').replace(/[^\w .-]+/g, '-').replace(/\s+/g, ' ').replace(/^[.\s-]+/, '').trim();
  return cleaned.slice(-100);
}

/**
 * Names, types and shape. A file arrives either whole (data) or as part SHAs whose
 * bytes are fetched later (loadParts); either way checkBytes runs on the bytes.
 */
function checkFiles(raw) {
  if (raw === undefined || raw === null) return { ok: true, files: [] };
  if (!Array.isArray(raw)) return { ok: false, why: 'files not an array' };
  if (raw.length > MAX_FILES) return { ok: false, why: 'too many files', user: `Please send at most ${MAX_FILES} files.` };

  const files = [];
  for (const f of raw) {
    const name = safeName(asString(f?.name));
    const ext = (name.match(/\.([a-z]+)$/i)?.[1] ?? '').toLowerCase();
    if (!name || !['docx', 'md', 'markdown'].includes(ext)) {
      return { ok: false, why: 'file type', user: 'Only Word (.docx) and Markdown (.md) files can be attached.' };
    }
    if (Array.isArray(f?.parts)) {
      // A SHA can only name a blob already in the private requests repo, and the
      // result is committed back into that same repo, so a forged SHA exposes nothing.
      if (!f.parts.length || f.parts.length > MAX_PARTS || !f.parts.every((p) => typeof p === 'string' && SHA_RE.test(p))) {
        return { ok: false, why: 'file parts' };
      }
      files.push({ name, ext, parts: f.parts });
      continue;
    }
    const data = typeof f?.data === 'string' ? f.data : '';
    if (!B64_RE.test(data) || data.length % 4 !== 0) return { ok: false, why: 'file not base64' };
    files.push({ name, ext, bytes: Buffer.from(data, 'base64') });
  }
  const whole = files.filter((f) => f.bytes);
  if (whole.length === files.length) return checkBytes(files);
  const early = checkBytes(whole); // reject a bad whole file before any fetching
  return early.ok ? { ok: true, files } : early;
}

/** Content checks, total size and unique names, once every file has its bytes. */
function checkBytes(loaded) {
  const files = [];
  let total = 0;
  const seen = new Set();
  for (const { name, ext, bytes } of loaded) {
    if (bytes.length === 0) return { ok: false, why: 'empty file', user: `${name} is empty.` };
    if (ext === 'docx' && bytes.subarray(0, 4).toString('binary') !== 'PK\x03\x04') {
      return { ok: false, why: 'docx not a zip', user: `${name} does not look like a Word document.` };
    }
    if (ext !== 'docx' && !isUtf8(bytes)) return { ok: false, why: 'md not utf-8', user: `${name} is not a text file.` };
    total += bytes.length;
    if (total > MAX_TOTAL_BYTES) {
      return { ok: false, why: 'files too large', user: `The files come to more than ${TOTAL_TEXT}. Attach fewer, or share a link to them instead.` };
    }
    let unique = name;
    for (let n = 2; seen.has(unique.toLowerCase()); n++) unique = name.replace(/(\.[a-z]+)$/i, `-${n}$1`);
    seen.add(unique.toLowerCase());
    files.push({ name: unique, data: bytes.toString('base64'), size: bytes.length });
  }
  return { ok: true, files };
}

function isUtf8(bytes) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export function validate(body) {
  const reject = (error, userMessage) => ({ ok: false, error: `validation: ${error}`, userMessage });
  const title = asString(body.title);
  const authorsText = asString(body.authors);
  const email = asString(body.email);
  const summary = asString(body.summary).replace(/\s+/g, ' ');
  const topic = asString(body.topic);
  const github = asString(body.github).replace(/^@/, '');
  const link = asString(body.manuscriptLink);
  const notes = asString(body.notes);

  if (title.length < 3) return reject('title', 'Please give the book a title.');
  if (title.length > LIMITS.title) return reject('title too long', 'That title is too long.');
  if (!authorsText) return reject('authors', 'Please name the author or authors.');
  if (authorsText.length > LIMITS.authors) return reject('authors too long', 'The author list is too long.');
  const authors = authorsText.split(/\s*(?:,|;|\n|\band\b|&)\s*/).map((a) => a.trim()).filter(Boolean).slice(0, 10);
  if (!email || email.length > LIMITS.email || !EMAIL_RE.test(email)) return reject('email', 'Please give an email address we can reach you on.');
  if (summary.length < MIN_SUMMARY) return reject('summary', 'Please describe the book in a sentence or two.');
  if (summary.length > LIMITS.summary) return reject('summary too long', `Please keep the description under ${LIMITS.summary} characters.`);
  if (topic.length > LIMITS.topic) return reject('topic too long', 'The subject area is too long.');
  if (github && !LOGIN_RE.test(github)) return reject('github', "That doesn't look like a GitHub username. Leave it blank if you don't have one.");
  if (link) {
    let u;
    try { u = new URL(link); } catch { u = null; }
    if (!u || u.protocol !== 'https:' || link.length > LIMITS.link) return reject('link', 'The manuscript link must be a full https:// address.');
  }
  if (notes.length > LIMITS.notes) return reject('notes too long', `Please keep the notes under ${LIMITS.notes} characters.`);
  if (body.agreeLicence !== true) {
    return reject('licence', 'Books here are published under CC BY-SA 4.0. Please tick the box to agree.');
  }
  const files = checkFiles(body.files);
  if (!files.ok) return reject(files.why, files.user ?? 'One of the files could not be read.');

  return { ok: true, data: { title, authors, email, summary, topic, github, link, notes, files: files.files } };
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

async function gh(path, token, init = {}) {
  const res = await githubFetch(`/repos/${REQUESTS_REPO}${path}`, { token, ...init });
  if (!res.ok) {
    console.error(`request-book: ${init.method ?? 'GET'} ${path} returned ${res.status} — ${await detailOf(res)}`);
    const err = new Error(`github ${init.method ?? 'GET'} ${path.split('?')[0]} failed (status ${res.status})`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// About 12 s for a small file, growing with size: a 20 MB blob is ~27 MB of JSON.
const blobTimeout = (base64Length) => 12000 + Math.ceil(base64Length / (1024 * 1024)) * 1500;

/**
 * Joins each file's parts into its bytes. Parts never committed stay unreachable
 * blobs, which GitHub garbage-collects; an abandoned upload leaves nothing behind.
 */
async function loadParts(token, files) {
  return Promise.all(files.map(async (f) => {
    if (f.bytes) return f;
    const chunks = [];
    for (const sha of f.parts) {
      const blob = await gh(`/git/blobs/${sha}`, token, { timeoutMs: 15000 });
      if (blob.encoding !== 'base64') throw new Error(`github blob ${sha} has encoding ${blob.encoding}`);
      chunks.push(Buffer.from(String(blob.content).replace(/\s+/g, ''), 'base64'));
    }
    return { name: f.name, ext: f.ext, bytes: Buffer.concat(chunks) };
  }));
}

/** Every file in one commit on the requests repo's main. Returns the commit SHA. */
async function commitFiles(token, reference, files) {
  const blobs = await Promise.all(
    files.map((f) => gh('/git/blobs', token, { method: 'POST', body: { content: f.data, encoding: 'base64' }, timeoutMs: blobTimeout(f.data.length) })),
  );
  const ref = await gh(`/git/ref/heads/${REQUESTS_BRANCH}`, token);
  const parent = await gh(`/git/commits/${ref.object.sha}`, token);
  const tree = await gh('/git/trees', token, {
    method: 'POST',
    body: {
      base_tree: parent.tree.sha,
      tree: files.map((f, i) => ({ path: `requests/${reference}/${f.name}`, mode: '100644', type: 'blob', sha: blobs[i].sha })),
    },
  });
  const commit = await gh('/git/commits', token, {
    method: 'POST',
    body: { message: `Request ${reference}: manuscript files`, tree: tree.sha, parents: [ref.object.sha] },
  });
  await gh(`/git/refs/heads/${REQUESTS_BRANCH}`, token, { method: 'PATCH', body: { sha: commit.sha } });
  return commit.sha;
}

export function buildIssueBody(reference, d, { slug, committed, fileError }) {
  const request = {
    reference,
    slug,
    title: d.title,
    summary: d.summary,
    authors: d.authors,
    topic: d.topic || null,
    email: d.email,
    maintainer_github: d.github || null,
    licence: 'CC-BY-SA-4.0',
    manuscript: committed ? d.files.map((f) => `requests/${reference}/${f.name}`) : [],
    manuscript_link: d.link || null,
    status: 'live',
    sandbox: false,
  };
  const json = JSON.stringify(request, null, 2);
  const jf = fence(json);

  const lines = [
    `**${inlineCode(d.title)}**, by ${d.authors.map(inlineCode).join(', ')}`,
    '',
    `> ${inlineCode(d.summary)}`,
    '',
    `- **Email:** ${inlineCode(d.email)}`,
    `- **GitHub:** ${d.github ? inlineCode(d.github) : 'none given'}`,
    `- **Subject:** ${d.topic ? inlineCode(d.topic) : 'not given'}`,
    `- **Proposed address:** \`${slug}.${REGISTRY.platform?.portal?.book_parent ?? 'confused4now.org'}\``,
    '',
    '### Manuscript',
    '',
  ];
  if (committed && d.files.length) {
    for (const f of d.files) {
      lines.push(`- [${inlineCode(f.name)}](https://github.com/${REQUESTS_REPO}/blob/${REQUESTS_BRANCH}/requests/${reference}/${encodeURIComponent(f.name)}) (${Math.ceil(f.size / 1024)} KB)`);
    }
  } else if (fileError) {
    lines.push(`- **The files did not arrive** (${fileError}). Ask the requester to send them.`);
  } else {
    lines.push('- No files. The book starts from the template front page and one blank chapter.');
  }
  if (d.link) lines.push(`- Link: ${inlineCode(d.link)} (not fetched: download it and commit it to \`requests/${reference}/\` before approving, if it should seed the book)`);
  if (d.notes) {
    const nf = fence(d.notes);
    lines.push('', '### Notes from the requester', '', `${nf}text`, d.notes, nf);
  }
  lines.push(
    '',
    '---',
    '',
    '### Request data',
    '',
    'Provisioning reads this block. Edit it before approving if you need to: `slug` (permanent, and the address),',
    '`status` (`live` feeds the portal graph; `preview` does not), `sandbox` (`true` for a test book that the',
    '`remove` label can delete outright). **Approve by adding the `approved` label.**',
    '',
    `${jf}json`,
    json,
    jf,
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handlePart(part, ip, res) {
  if (isPartRateLimited(ip, Date.now())) {
    send(res, 429, { error: 'rate limit exceeded', userMessage: "You've sent a lot of files already. Please try again in an hour." });
    return;
  }
  if (!part || part.length % 4 !== 0 || !B64_RE.test(part) || Buffer.byteLength(part) > Math.ceil(PART_BYTES / 3) * 4) {
    send(res, 400, { error: 'validation: part', userMessage: 'One of the files could not be read.' });
    return;
  }
  const credential = await CREDENTIALS.acquire(REQUESTS_BOOK, 'request-book');
  if (!credential.ok) {
    send(res, credential.status, { error: credential.error, userMessage: TRY_AGAIN });
    return;
  }
  try {
    const blob = await gh('/git/blobs', credential.token, { method: 'POST', body: { content: part, encoding: 'base64' }, timeoutMs: blobTimeout(part.length) });
    send(res, 201, { sha: blob.sha });
  } catch (err) {
    if (err.status === 401) CREDENTIALS.refused(REQUESTS_BOOK, credential);
    console.error(`request-book part: ${err.message}`);
    send(res, 502, { error: `github: ${err.message}`, userMessage: 'A file could not be uploaded. Please try again.' });
  }
}

const TRY_AGAIN = 'Something went wrong sending your request. Please try again.';

async function handle(req, res) {
  res.setHeader('X-Registry-Version', BUNDLE.sha);

  const r = PORTAL.resolve(req.headers.origin);
  if (!r.ok) {
    console.warn(`origin rejected: ${req.headers.origin ?? '<none>'} (${r.reason})`);
    send(res, 403, { error: req.headers.origin ? 'origin not allowed' : 'origin required' });
    return;
  }
  corsHeaders(res, r.origin);
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    send(res, 405, { error: 'method not allowed' });
    return;
  }
  // application/json forces a CORS preflight (see api/suggest-edit.js).
  if (!isJsonContentType(req)) {
    send(res, 415, { error: 'unsupported content-type', userMessage: TRY_AGAIN });
    return;
  }

  let body;
  try {
    body = parseBody(req);
  } catch {
    send(res, 400, { error: 'body was not valid json', userMessage: TRY_AGAIN });
    return;
  }
  if (!body || typeof body !== 'object') {
    send(res, 400, { error: 'body was not a json object', userMessage: TRY_AGAIN });
    return;
  }

  const ip = clientIp(req);
  if (typeof body.part === 'string') {
    await handlePart(body.part, ip, res);
    return;
  }
  // A bot is never told it was caught.
  if (asString(body.website)) {
    console.warn(`honeypot: discarded book request from ip=${ip}`);
    send(res, 201, { reference: 'received' });
    return;
  }
  if (isRateLimited(ip, Date.now())) {
    send(res, 429, { error: 'rate limit exceeded', userMessage: "You've sent several requests already. Please try again in an hour." });
    return;
  }

  const v = validate(body);
  if (!v.ok) {
    console.warn(`${v.error} (ip=${ip})`);
    send(res, 400, { error: v.error, userMessage: v.userMessage });
    return;
  }
  const d = v.data;

  const credential = await CREDENTIALS.acquire(REQUESTS_BOOK, 'request-book');
  if (!credential.ok) {
    send(res, credential.status, { error: credential.error, userMessage: TRY_AGAIN });
    return;
  }

  let partsError = null;
  if (d.files.some((f) => f.parts)) {
    try {
      const checked = checkBytes(await loadParts(credential.token, d.files));
      if (!checked.ok) {
        console.warn(`validation: ${checked.why} (ip=${ip})`);
        send(res, 400, { error: `validation: ${checked.why}`, userMessage: checked.user ?? 'One of the files could not be read.' });
        return;
      }
      d.files = checked.files;
    } catch (err) {
      if (err.status === 401) CREDENTIALS.refused(REQUESTS_BOOK, credential);
      partsError = err.message;
      d.files = [];
    }
  }

  const reference = `${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 8)}`;
  const slug = proposeSlug(d.title);

  // Files first, so the issue can link them. A failed upload still files the
  // request: losing the request is worse than asking for the files again.
  let committed = false;
  let fileError = partsError;
  if (d.files.length) {
    try {
      await commitFiles(credential.token, reference, d.files);
      committed = true;
    } catch (err) {
      if (err.status === 401) CREDENTIALS.refused(REQUESTS_BOOK, credential);
      fileError = err.message;
    }
  }

  try {
    await ensureLabels(REQUESTS_REPO, credential.token, LABEL_DEFAULTS, 3000);
    const issue = await gh('/issues', credential.token, {
      method: 'POST',
      body: { title: `Book request: ${d.title.slice(0, 180)}`, body: buildIssueBody(reference, d, { slug, committed, fileError }), labels: LABELS },
    });
    console.log(`book request ${reference} filed as ${issue.html_url} (files: ${committed ? d.files.length : fileError ? 'FAILED' : 0}, credential=${credential.kind})`);
    send(res, 201, {
      reference,
      ...(fileError ? { userMessage: "Your request arrived, but the files didn't. We'll email you to ask for them." } : {}),
    });
  } catch (err) {
    if (err.status === 401) CREDENTIALS.refused(REQUESTS_BOOK, credential);
    console.error(`request-book: ${err.message}`);
    send(res, 502, { error: `github: ${err.message}`, userMessage: TRY_AGAIN });
  }
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
