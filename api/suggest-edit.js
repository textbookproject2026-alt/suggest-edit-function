/**
 * POST /api/suggest-edit
 *
 * Receives a reader's suggested edit from a textbook's front-end and files it as a
 * GitHub issue on that book's content repo. The book is resolved from the request's
 * Origin against the textbook registry, which is baked in at build time
 * (registry/bundled.mjs); nothing about any book is hardcoded here.
 *
 * Contract (fixed by the live front-end — do not deviate):
 *   POST JSON { name, email, suggestion, reasoning, path, website }
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
import { validateRegistry, createResolver, canonicalOrigin } from '../lib/registry.mjs';
import { readCredentialConfig, createInstallationTokenSource } from '../lib/github-app.mjs';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Checked again at load even though the build validated it: a registry this function
// cannot route unambiguously must stop it starting, not be half-used.
const REGISTRY = validateRegistry(BUNDLE.registry);
const RESOLVER = createResolver(REGISTRY);
console.log(`registry: ${BUNDLE.sha} (${REGISTRY.books.length} book(s))`);

const GITHUB_API = 'https://api.github.com';
const GITHUB_HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'suggest-edit-function',
};

const LABELS = ['suggested-edit', 'needs-triage'];
const LABEL_DEFAULTS = {
  'suggested-edit': { color: '0e8a16', description: 'Reader-submitted edit from the suggest-an-edit form' },
  'needs-triage': { color: 'fbca04', description: 'Not yet reviewed by an editor' },
};

const MAX_SUGGESTION = 5000;
const MAX_REASONING = 5000;
const MAX_NAME = 200;
const MAX_EMAIL = 254;
const MAX_PATH = 300;

// The issue call gets the full 8s. Label checks are best-effort, so they share a
// smaller budget — otherwise three sequential 8s aborts could run the whole handler
// past its maxDuration and the reader would see a platform timeout, not our 502.
const GITHUB_TIMEOUT_MS = 8000;
const LABEL_BUDGET_MS = 3000;
// Minting an installation token on a cold cache (installation lookup and exchange share
// this budget): 3s + 3s + 8s stays under maxDuration (15s).
const TOKEN_EXCHANGE_TIMEOUT_MS = 3000;

// Rate limit: 5 submissions per hour per IP.
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/**
 * Read once per cold start and reported loudly. The GitHub App is the credential.
 * BOT_TOKEN is a TEMPORARY fallback so the form stays up while the App is rolled
 * out: it is used when the App variables are absent or malformed, or when minting
 * an App token fails. Every request logs which path it took. Remove BOT_TOKEN (the
 * variable and this fallback) once `credential=app` is proven in production.
 */
const CREDENTIALS = readCredentialConfig(process.env);
const TOKEN_SOURCE = CREDENTIALS.app
  ? createInstallationTokenSource({
      app: CREDENTIALS.app,
      api: GITHUB_API,
      headers: GITHUB_HEADERS,
      timeoutMs: TOKEN_EXCHANGE_TIMEOUT_MS,
    })
  : null;

if (CREDENTIALS.app) {
  console.log(
    `config: credential=app (app ${CREDENTIALS.app.appId}, installation looked up per repository)` +
      (CREDENTIALS.botToken ? '; BOT_TOKEN fallback is also set' : ''),
  );
} else if (CREDENTIALS.botToken) {
  console.error(`config: GitHub App NOT usable — ${CREDENTIALS.appProblem}. Using the BOT_TOKEN fallback for every request.`);
} else {
  console.error(`config: FATAL no GitHub credential — ${CREDENTIALS.appProblem}, and BOT_TOKEN is not set. Every submission will fail.`);
}
for (const name of CREDENTIALS.retired) {
  console.warn(`config: ${name} is set but no longer read (the installation is looked up per repository); delete it`);
}

/**
 * @returns {Promise<{ ok: true, kind: 'app' | 'bot_token', token: string }
 *                  | { ok: false, status: number, error: string }>}
 */
async function acquireCredential(book, tag) {
  const repo = book.content.repo;
  let fallbackReason = `app not configured: ${CREDENTIALS.appProblem}`;

  if (TOKEN_SOURCE) {
    try {
      const { token, cached, installationId } = await TOKEN_SOURCE.get(repo);
      console.log(`credential=app (${cached ? 'cached' : 'minted'} installation token for ${repo}, installation ${installationId}) ${tag}`);
      return { ok: true, kind: 'app', token };
    } catch (err) {
      if (!CREDENTIALS.botToken) {
        console.error(`credential: app token unavailable for ${repo} — ${err.message}; no fallback ${tag}`);
        // The reader sees `error`, so the repository is named only in the log line above.
        return {
          ok: false,
          status: 502,
          error: err.code === 'not_installed' ? "github: the app isn't installed on that repository" : 'github: credential unavailable',
        };
      }
      console.error(`credential: app token unavailable for ${repo} — ${err.message} ${tag}`);
      fallbackReason = `app token unavailable: ${err.message}`;
    }
  }

  if (CREDENTIALS.botToken) {
    console.warn(`credential=bot_token (fallback; ${fallbackReason}) ${tag}`);
    return { ok: true, kind: 'bot_token', token: CREDENTIALS.botToken };
  }

  console.error(`config: no GitHub credential configured ${tag}`);
  return { ok: false, status: 500, error: 'bot credentials not configured' };
}

// ---------------------------------------------------------------------------
// Rate limiting (best-effort only)
// ---------------------------------------------------------------------------

/**
 * HONEST LIMITATION: this Map lives in the memory of a single serverless instance.
 * Vercel runs many instances concurrently and recycles them freely, so the counter
 * is per-instance and resets on every cold start. A determined submitter who hits
 * different instances gets more than RATE_LIMIT_MAX per hour, and everyone's count
 * silently resets when the instance is reaped. This is a speed bump against casual
 * form-mashing, not a security control. Real hardening (shared store / KV or Redis,
 * plus edge-level limits) is Day 28.
 *
 * @type {Map<string, number[]>} ip -> ascending list of submission timestamps (ms)
 */
const hits = new Map();
let lastSweep = 0;

/** Drop entries whose timestamps have all aged out, so the Map cannot grow forever. */
function sweep(now) {
  // Sweeping on every request would be wasted work; once per window is plenty.
  if (now - lastSweep < RATE_LIMIT_WINDOW_MS) return;
  lastSweep = now;

  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  for (const [ip, timestamps] of hits) {
    const fresh = timestamps.filter((t) => t > cutoff);
    if (fresh.length === 0) hits.delete(ip);
    else hits.set(ip, fresh);
  }
}

/** @returns {boolean} true when this IP is over budget (request should be rejected). */
function isRateLimited(ip, now) {
  sweep(now);

  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const fresh = (hits.get(ip) ?? []).filter((t) => t > cutoff);

  if (fresh.length >= RATE_LIMIT_MAX) {
    // Keep the pruned list so the window slides rather than resetting on rejection.
    hits.set(ip, fresh);
    return true;
  }

  fresh.push(now);
  hits.set(ip, fresh);
  return false;
}

/** First hop of x-forwarded-for is the client as seen by the edge. */
function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const first = typeof raw === 'string' ? raw.split(',')[0].trim() : '';
  return first || req.socket?.remoteAddress || 'unknown';
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

// Deliberately loose: shape check only. Real deliverability is not our problem, and
// over-strict regexes reject valid addresses.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

// Word chars, spaces, and the punctuation that shows up in real chapter filenames
// (including the em dash the textbook uses in headings). Must end in .md.
const PATH_RE = /^[\w\-/().,'&%+ —]+\.md$/;

function asString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Re-validate everything server-side. Client-side validation is advisory: the live
 * front-end checks these fields too, but anyone can POST here directly.
 *
 * @returns {{ ok: true, data: object } | { ok: false, error: string, userMessage: string }}
 */
function validate(body) {
  const name = asString(body.name);
  const email = asString(body.email);
  const suggestion = asString(body.suggestion);
  const reasoning = asString(body.reasoning);
  const path = asString(body.path);

  const reject = (error, userMessage) => ({ ok: false, error, userMessage });

  if (!name) return reject('validation: name missing', 'Please include your name.');
  if (name.length > MAX_NAME) {
    return reject('validation: name too long', 'That name is too long — please shorten it.');
  }

  if (!email) return reject('validation: email missing', 'Please include your email address.');
  if (email.length > MAX_EMAIL || !EMAIL_RE.test(email)) {
    return reject('validation: email malformed', 'That email address does not look right.');
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
  if (
    path.length > MAX_PATH ||
    path.includes('..') || // no directory traversal
    path.includes('://') || // no URLs
    path.includes('//') ||
    path.startsWith('/') ||
    !PATH_RE.test(path)
  ) {
    return reject('validation: path rejected', 'We could not tell which page this refers to.');
  }

  return { ok: true, data: { name, email, suggestion, reasoning, path } };
}

// ---------------------------------------------------------------------------
// Issue body
// ---------------------------------------------------------------------------

/** first char + *** + @domain, e.g. "a***@example.com". Never store the full address. */
function maskEmail(email) {
  const at = email.lastIndexOf('@');
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

/**
 * Render user text as a markdown code span, so it is displayed but can never be
 * markup. GitHub does not linkify @mentions, links or images inside a code span, so
 * a reader who calls themselves "@octocat" is shown verbatim and notifies nobody.
 */
function inlineCode(text) {
  // A code span cannot cross a line break: fold every whitespace run to one space,
  // or a newline in `name` would close the span and drop the rest into live markdown.
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return '';

  let longest = 0;
  for (const run of flat.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const ticks = '`'.repeat(longest + 1);

  // CommonMark strips one leading and one trailing space from a code span, so pad
  // when the content would otherwise sit flush against a backtick delimiter.
  const pad = flat.startsWith('`') || flat.endsWith('`') ? ' ' : '';
  return `${ticks}${pad}${flat}${pad}${ticks}`;
}

/** Fence long enough that user content cannot break out of the code block. */
function fence(text) {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return '`'.repeat(Math.max(3, longest + 1));
}

function fileUrl(book, path) {
  // encodeURIComponent leaves ( and ) alone, and an unbalanced ')' would terminate
  // the markdown link destination early. PATH_RE permits both, so encode them.
  const encoded = path
    .split('/')
    .map((seg) => encodeURIComponent(seg).replace(/\(/g, '%28').replace(/\)/g, '%29'))
    .join('/');
  return `https://github.com/${book.content.repo}/blob/${book.content.live_branch}/${encoded}`;
}

function buildIssueBody(book, { name, email, suggestion, reasoning, path }) {
  const f = fence(suggestion);
  const parts = [
    `**File:** [\`${path}\`](${fileUrl(book, path)})`,
    '',
    '### Suggested edit',
    '',
    `${f}text`,
    suggestion,
    f,
  ];

  if (reasoning) {
    const rf = fence(reasoning);
    parts.push('', '### Reasoning', '', `${rf}text`, reasoning, rf);
  }

  parts.push(
    '',
    '---',
    '',
    `**Submitted by:** ${inlineCode(name)} (${inlineCode(maskEmail(email))})`,
    '',
    '_submitted via the suggest-an-edit form_',
  );

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

/**
 * fetch against the GitHub REST API with an 8s abort.
 * The token goes in the Authorization header and is never logged or returned.
 */
async function githubFetch(pathname, { token, method = 'GET', body, timeoutMs = GITHUB_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${GITHUB_API}${pathname}`, {
      method,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        ...GITHUB_HEADERS,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return res;
  } catch (err) {
    // AbortError included: normalise so callers never see transport internals.
    throw new Error(err?.name === 'AbortError' ? 'github request timed out' : 'github request failed');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Make sure both labels exist before we reference them on a new issue.
 * Creating a label needs only Issues: write, which both credentials have. Non-fatal: if this fails we still try
 * the issue — a missing label is cosmetic next to a lost suggestion. The whole pass
 * shares LABEL_BUDGET_MS so it cannot eat the issue call's time.
 */
async function ensureLabels(book, token) {
  const repo = book.content.repo;
  const deadline = Date.now() + LABEL_BUDGET_MS;
  const remaining = () => deadline - Date.now();

  for (const label of LABELS) {
    if (remaining() <= 0) {
      console.warn(`ensureLabels: out of budget, skipping "${label}"`);
      continue;
    }
    try {
      const existing = await githubFetch(
        `/repos/${repo}/labels/${encodeURIComponent(label)}`,
        { token, timeoutMs: remaining() },
      );
      if (existing.ok) continue;
      if (existing.status !== 404) {
        console.warn(`ensureLabels: unexpected status ${existing.status} for "${label}"`);
        continue;
      }

      if (remaining() <= 0) {
        console.warn(`ensureLabels: out of budget, not creating "${label}"`);
        continue;
      }
      const created = await githubFetch(`/repos/${repo}/labels`, {
        token,
        method: 'POST',
        body: { name: label, ...LABEL_DEFAULTS[label] },
        timeoutMs: remaining(),
      });
      // 422 = created by a concurrent request between our GET and POST. Fine.
      if (!created.ok && created.status !== 422) {
        console.warn(`ensureLabels: could not create "${label}" (status ${created.status})`);
      }
    } catch (err) {
      console.warn(`ensureLabels: "${label}" skipped — ${err.message}`);
    }
  }
}

/** @returns {Promise<string>} the html_url of the new issue. */
async function createIssue(book, token, data) {
  const res = await githubFetch(`/repos/${book.content.repo}/issues`, {
    token,
    method: 'POST',
    body: {
      title: `Suggested edit: ${data.path}`,
      body: buildIssueBody(book, data),
      labels: LABELS,
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

/** `origin` is always the registry-derived origin of the resolved book, never the raw header. */
function corsHeaders(res, origin) {
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Vary', 'Origin');
}

function send(res, status, payload) {
  res.status(status).json(payload);
}

/** Strictly application/json, with or without parameters ("; charset=utf-8"). */
function isJsonContentType(req) {
  const raw = req.headers['content-type'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return false;
  return value.split(';')[0].trim().toLowerCase() === 'application/json';
}

function parseBody(req) {
  // Vercel parses application/json for us; tolerate a raw string either way.
  const raw = req.body;
  if (raw && typeof raw === 'object' && !Buffer.isBuffer(raw)) return raw;

  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : typeof raw === 'string' ? raw : '';
  if (!text.trim()) return {};
  return JSON.parse(text); // caller turns a throw into a 400
}

/**
 * Which book is this request for? Exactly one, or a refusal (DESIGN §3a). There is
 * no default book: an Origin that is not a registered book's canonical origin is
 * refused, never mapped to some other book.
 *
 * @returns {{ ok: true, book: object } | { ok: false, error: string, log: string }}
 */
function resolveBook(origin) {
  if (!origin) {
    // No Origin means no book to file against (curl, server-to-server): with more than
    // one book there is nothing to default to, so it is refused (DESIGN step 2b).
    return { ok: false, error: 'origin required', log: 'origin missing' };
  }

  const result = RESOLVER.resolve(origin);
  if (result.ok) return result;
  // Logged, not echoed: `error` should never replay caller-controlled input.
  return { ok: false, error: 'origin not allowed', log: `origin rejected: ${origin} (${result.reason})` };
}

async function handle(req, res) {
  res.setHeader('X-Registry-Version', BUNDLE.sha);

  // --- Resolve the book ---------------------------------------------------
  // Before everything else, preflight included: an unknown origin gets a 403 with no
  // CORS headers, so a browser never sends the real request.
  const resolution = resolveBook(req.headers.origin);
  if (!resolution.ok) {
    console.warn(resolution.log);
    send(res, 403, { error: resolution.error });
    return;
  }
  const { book } = resolution;
  const tag = `book=${book.slug}`;

  // --- CORS preflight -----------------------------------------------------
  if (req.method === 'OPTIONS') {
    corsHeaders(res, canonicalOrigin(book));
    res.status(204).end();
    return;
  }

  // Set before the method guard so even a rejected request is readable by the client.
  corsHeaders(res, canonicalOrigin(book));

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

  // --- Credential ---------------------------------------------------------
  const credential = await acquireCredential(book, tag);
  if (!credential.ok) {
    // No userMessage: the client shows its own fixed copy for these failures.
    send(res, credential.status, { error: credential.error });
    return;
  }

  // --- File the issue -----------------------------------------------------
  try {
    await ensureLabels(book, credential.token);
    const issueUrl = await createIssue(book, credential.token, result.data);
    console.log(`created issue for "${result.data.path}" — ${issueUrl} (credential=${credential.kind}) ${tag}`);
    send(res, 201, { issueUrl });
  } catch (err) {
    // A revoked or expired App token must not stay cached for the rest of the instance.
    if (err.status === 401 && credential.kind === 'app') TOKEN_SOURCE.invalidate(book.content.repo);
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
