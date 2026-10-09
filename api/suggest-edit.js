/**
 * POST /api/suggest-edit
 *
 * Receives a reader's suggested edit from a textbook's front-end and files it as a
 * GitHub issue on that book's content repo. The book is resolved from the request's
 * Origin against the textbook registry, which is baked in at build time
 * (registry/bundled.mjs); nothing about any book is hardcoded here.
 *
 * Contract (fixed by the live front-end — do not deviate):
 *   POST JSON { name, suggestion, reasoning, path, website }
 *
 *   A note on one paragraph (the ¶ margin's "Note to the authors about ¶n") adds
 *     paragraph   the paragraph's number (a positive integer)
 *     quote       the start of its text (<= 300 characters), as the reader saw it
 *     page        the page's path on the book's site ("/chapters/chapter-03"), for
 *                 the #p<n> permalink on the book's own domain
 *   and gets the label `section-note`. A body without them is a note on the page,
 *   as before. Any note may carry `identity` (the in-site editor's GitHub sign-in,
 *   /api/github-auth): if it is genuine and for this book, the issue names the
 *   reader as @login, so GitHub tells them when it is closed; otherwise it is
 *   ignored and the note is the name's alone.
 *
 *   No email: the issue shows the name, and nothing else used an address. A body
 *   that still carries `email` (a page built before 6 Oct 2026) is accepted, and
 *   the email is dropped unread.
 *     -> 201 { issueUrl }
 *     -> 4xx/5xx { error, userMessage? }
 *
 *   `error`       is log material. It never carries internals (no stacks, no token,
 *                 no upstream response bodies) because the reader can see it.
 *   `userMessage` is optional safe plain text (<= 200 chars) the client may show
 *                 verbatim. Omitted when the client already has fixed copy.
 *
 * Zero dependencies: Node 22 built-in fetch and node:crypto, plain ES modules.
 */

import BUNDLE from '../registry/bundled.mjs';
import { validateRegistry, createResolver } from '../lib/registry.mjs';
import {
  GITHUB_API, asString, clientIp, corsHeaders, createCredentials, createRateLimiter, ensureLabels,
  fence, fileUrl, githubFetch, inlineCode, isJsonContentType, isSafePath, parseBody,
  resolveBook as resolveBookWith, send,
  AUTHOR_SITE,
  mentionLines,
} from '../lib/common.mjs';
import { readIdentity, readIdentitySecret } from '../lib/identity.mjs';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Checked again at load even though the build validated it: a registry this function
// cannot route unambiguously must stop it starting, not be half-used.
const REGISTRY = validateRegistry(BUNDLE.registry);
const RESOLVER = createResolver(REGISTRY);
console.log(`registry: ${BUNDLE.sha} (${REGISTRY.books.length} book(s))`);

const LABELS = ['suggested-edit', 'needs-triage'];
const LABEL_DEFAULTS = {
  'suggested-edit': { color: '0e8a16', description: 'Reader-submitted edit from the suggest-an-edit form' },
  'needs-triage': { color: 'fbca04', description: 'Not yet reviewed by an editor' },
  'section-note': { color: 'c5def5', description: 'A reader\'s note on one paragraph' },
};

const MAX_SUGGESTION = 5000;
const MAX_REASONING = 5000;
const MAX_NAME = 200;
const MAX_QUOTE = 300;
// A page's path on the book's site: Quartz's slugs, so no spaces, quotes or "..".
const PAGE_RE = /^\/(?:[A-Za-z0-9._~%-]+\/)*[A-Za-z0-9._~%-]*$/;

// Rate limit: 5 submissions per hour per IP.
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Credentials (lib/common.mjs): the GitHub App, with the temporary BOT_TOKEN
// fallback. Tokens are downscoped to the book's repo and issues:write.
// ---------------------------------------------------------------------------

// Label checks are best-effort, so they share a smaller budget than the issue call's
// 8s: 3s token + 3s labels + 8s issue stays under maxDuration (15s).
const LABEL_BUDGET_MS = 3000;

const CREDENTIALS = createCredentials(process.env);

// ---------------------------------------------------------------------------
// Rate limiting (best-effort only; see lib/common.mjs for the honest limitation).
// Real hardening (shared store / KV or Redis, plus edge-level limits) is Day 28.
// ---------------------------------------------------------------------------

const isRateLimited = createRateLimiter(RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Re-validate everything server-side. Client-side validation is advisory: the live
 * front-end checks these fields too, but anyone can POST here directly.
 *
 * @returns {{ ok: true, data: object } | { ok: false, error: string, userMessage: string }}
 */
function validate(body) {
  const name = asString(body.name);
  const suggestion = asString(body.suggestion);
  const reasoning = asString(body.reasoning);
  const path = asString(body.path);

  const reject = (error, userMessage) => ({ ok: false, error, userMessage });

  if (!name) return reject('validation: name missing', 'Please include your name.');
  if (name.length > MAX_NAME) {
    return reject('validation: name too long', 'That name is too long — please shorten it.');
  }

  if (!suggestion) {
    return reject('validation: suggestion missing', 'Please describe the edit you are suggesting.');
  }
  if (suggestion.length > MAX_SUGGESTION) {
    return reject(
      'validation: suggestion too long',
      `Your suggestion is too long — please keep it under ${MAX_SUGGESTION} characters.`,
    );
  }

  if (reasoning.length > MAX_REASONING) {
    return reject(
      'validation: reasoning too long',
      `Your reasoning is too long — please keep it under ${MAX_REASONING} characters.`,
    );
  }

  if (!path) {
    return reject('validation: path missing', 'We could not tell which page this refers to.');
  }
  if (!isSafePath(path)) {
    return reject('validation: path rejected', 'We could not tell which page this refers to.');
  }

  const data = { name, suggestion, reasoning, path };
  // A note on one paragraph: all three or none. Anything else is a page note.
  const paragraph = body.paragraph;
  const page = asString(body.page);
  if (Number.isSafeInteger(paragraph) && paragraph > 0 && page && PAGE_RE.test(page) && !page.includes('..')) {
    data.paragraph = paragraph;
    data.page = page;
    data.quote = asString(body.quote).replace(/\s+/g, ' ').slice(0, MAX_QUOTE);
  }
  return { ok: true, data };
}

// ---------------------------------------------------------------------------
// Issue body
// ---------------------------------------------------------------------------

/** The paragraph's permalink on the book's own domain: the page's path, then #p<n>. */
export const paragraphUrl = (book, page, n) => `https://${book.site.domain}${page}#p${n}`;

function buildIssueBody(book, { name, suggestion, reasoning, path, paragraph, page, quote, identity }) {
  const f = fence(suggestion);
  const parts = [`**File:** [\`${path}\`](${fileUrl(book, path)})`];
  if (paragraph) {
    parts.push(`**Where:** [¶${paragraph}](${paragraphUrl(book, page, paragraph)})`);
    if (quote) {
      const qf = fence(quote);
      parts.push('', `${qf}text`, quote, qf);
    }
  }
  parts.push(
    '',
    '### Suggested edit',
    '',
    `${f}text`,
    suggestion,
    f,
  );

  if (reasoning) {
    const rf = fence(reasoning);
    parts.push('', '### Reasoning', '', `${rf}text`, reasoning, rf);
  }

  parts.push(...mentionLines(book, AUTHOR_SITE, identity?.login));
  parts.push(
    '',
    '---',
    '',
    // Signed in: the login, so GitHub tells them when the issue closes (and the
    // decision workflow can @mention them). Otherwise the name, in a code span.
    `**Submitted by:** ${identity ? `@${identity.login} (signed in with GitHub)` : inlineCode(name)}`,
    '',
    '_submitted via the suggest-an-edit form_',
  );

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

/** @returns {Promise<string>} the html_url of the new issue. */
async function createIssue(book, token, data) {
  const res = await githubFetch(`/repos/${book.content.repo}/issues`, {
    token,
    method: 'POST',
    body: {
      title: data.paragraph ? `Note on ¶${data.paragraph}: ${data.path}` : `Suggested edit: ${data.path}`,
      body: buildIssueBody(book, data),
      labels: data.paragraph ? [...LABELS, 'section-note'] : LABELS,
    },
  });

  if (!res.ok) {
    // Read the body for the server log only — it never reaches the response.
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 500);
    } catch {
      detail = '<unreadable>';
    }
    console.error(`createIssue: GitHub returned ${res.status} — ${detail}`);
    const err = new Error(`github issue creation failed (status ${res.status})`);
    err.status = res.status;
    throw err;
  }

  const issue = await res.json();
  if (!issue?.html_url) throw new Error('github issue creation returned no url');

  // Post-condition (DESIGN §3a.8): the issue must have landed on the resolved book's
  // repo. A mismatch is a routing bug. The issue exists and the reader did nothing
  // wrong, so they still get their 201; the log is how the bug gets caught.
  const expected = `${GITHUB_API}/repos/${book.content.repo}`.toLowerCase();
  if (String(issue.repository_url).toLowerCase() !== expected) {
    console.error(`ROUTING: issue ${issue.html_url} landed on ${issue.repository_url}, expected ${expected} (book=${book.slug})`);
  }
  return issue.html_url;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Which book is this request for? Exactly one, or a refusal (DESIGN §3a). There is
 * no default book: an Origin that is not a registered book's canonical origin is
 * refused, never mapped to some other book.
 *
 * @returns {{ ok: true, book: object } | { ok: false, error: string, log: string }}
 */
function resolveBook(origin) {
  return resolveBookWith(RESOLVER, origin);
}

async function handle(req, res) {
  res.setHeader('X-Registry-Version', BUNDLE.sha);
  res.setHeader('X-Function-Version', BUNDLE.function_sha ?? 'local');

  // --- Resolve the book ---------------------------------------------------
  // Before everything else, preflight included: an unknown origin gets a 403 with no
  // CORS headers, so a browser never sends the real request.
  const resolution = resolveBook(req.headers.origin);
  if (!resolution.ok) {
    console.warn(resolution.log);
    send(res, 403, { error: resolution.error });
    return;
  }
  const { book, origin } = resolution;
  const tag = `book=${book.slug}`;

  // --- CORS preflight -----------------------------------------------------
  if (req.method === 'OPTIONS') {
    corsHeaders(res, origin);
    res.status(204).end();
    return;
  }

  // Set before the method guard so even a rejected request is readable by the client.
  corsHeaders(res, origin);

  // --- Method guard -------------------------------------------------------
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    console.warn(`method rejected: ${req.method} ${tag}`);
    send(res, 405, { error: 'method not allowed' });
    return;
  }

  // --- Content-Type gate --------------------------------------------------
  // text/plain, multipart and form encodings are CORS "simple requests": a browser
  // will send them cross-origin with no preflight at all. Insisting on
  // application/json forces a preflight, so the origin allowlist is enforced by the
  // browser before the request is even sent, rather than resting solely on the
  // Origin check above (which a non-browser client simply omits).
  if (!isJsonContentType(req)) {
    console.warn(`unsupported content-type: ${req.headers['content-type'] ?? '<none>'} ${tag}`);
    send(res, 415, {
      error: 'unsupported content-type',
      userMessage: 'Something went wrong sending your suggestion. Please try again.',
    });
    return;
  }

  // --- Body ---------------------------------------------------------------
  let body;
  try {
    body = parseBody(req);
  } catch {
    send(res, 400, { error: 'body was not valid json', userMessage: 'Something went wrong sending your suggestion. Please try again.' });
    return;
  }
  if (!body || typeof body !== 'object') {
    send(res, 400, { error: 'body was not a json object', userMessage: 'Something went wrong sending your suggestion. Please try again.' });
    return;
  }

  const ip = clientIp(req);

  // --- Honeypot -----------------------------------------------------------
  // `website` is a hidden field no human ever fills in. If it has anything in it we
  // drop the submission on the floor and hand back a success shape anyway: a bot is
  // never told it was caught, or it learns to fix its input. issueUrl points at the
  // resolved book's issues index so the field is populated with something real and harmless.
  if (asString(body.website)) {
    console.warn(`honeypot: discarded submission from ip=${ip} ${tag}`);
    send(res, 201, { issueUrl: `https://github.com/${book.content.repo}/issues` });
    return;
  }

  // --- Rate limit ---------------------------------------------------------
  if (isRateLimited(ip, Date.now())) {
    console.warn(`rate limit: ip=${ip} exceeded ${RATE_LIMIT_MAX}/hour ${tag}`);
    send(res, 429, {
      error: 'rate limit exceeded',
      userMessage: "You're sending suggestions too quickly — try again in a little while.",
    });
    return;
  }

  // --- Validation ---------------------------------------------------------
  const result = validate(body);
  if (!result.ok) {
    console.warn(`${result.error} (ip=${ip}) ${tag}`);
    send(res, 400, { error: result.error, userMessage: result.userMessage });
    return;
  }

  // A sign-in from the in-site editor, if the page sent one and it holds for this
  // book. A bad or expired one never refuses a note: it is just the name's.
  const secret = readIdentitySecret(process.env);
  const token = asString(body.identity);
  if (secret && token) {
    const identity = readIdentity(secret, token, origin);
    if (identity) result.data.identity = identity;
  }

  // --- Credential ---------------------------------------------------------
  const credential = await CREDENTIALS.acquire(book, tag);
  if (!credential.ok) {
    // No userMessage: the client shows its own fixed copy for these failures.
    send(res, credential.status, { error: credential.error });
    return;
  }

  // --- File the issue -----------------------------------------------------
  try {
    await ensureLabels(book.content.repo, credential.token, LABEL_DEFAULTS, LABEL_BUDGET_MS);
    const issueUrl = await createIssue(book, credential.token, result.data);
    console.log(`created issue for "${result.data.path}" — ${issueUrl} (credential=${credential.kind}) ${tag}`);
    send(res, 201, { issueUrl });
  } catch (err) {
    // A revoked or expired App token must not stay cached for the rest of the instance.
    if (err.status === 401) CREDENTIALS.refused(book, credential);
    // Message is our own normalised text, never an upstream body or a stack.
    console.error(`github: ${err.message} ${tag}`);
    // No userMessage: the client shows its own fixed copy for upstream failures.
    send(res, 502, { error: `github: ${err.message}` });
  }
}

/**
 * Outermost wrapper. Nothing below can leak a stack trace or the token into a
 * response: any escaped throw becomes a flat 500 and the detail goes to the log.
 */
export default async function handler(req, res) {
  try {
    await handle(req, res);
  } catch (err) {
    console.error('unhandled:', err);
    if (!res.headersSent) {
      send(res, 500, { error: 'unhandled server error' });
    } else {
      res.end();
    }
  }
}
