/**
 * POST /api/suggest-edit
 *
 * Receives a reader's suggested edit from the textbook front-end and files it as a
 * GitHub issue on textbookproject2026-alt/textbook as the bot account.
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
 * Zero dependencies: Node 22 built-in fetch, plain ES modules.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Exactly one browser origin may call this endpoint.
// TODO: add the production domain here at cutover (keep the staging one until the
// front-end has fully moved, then drop it).
const ALLOWED_ORIGIN = 'https://bptext2026.xyz';

const REPO_OWNER = 'textbookproject2026-alt';
const REPO_NAME = 'textbook';
const REPO_BRANCH = 'main';

const GITHUB_API = 'https://api.github.com';
const REPO_ISSUES_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}/issues`;

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

// Rate limit: 5 submissions per hour per IP.
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

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

/** Fence long enough that user content cannot break out of the code block. */
function fence(text) {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return '`'.repeat(Math.max(3, longest + 1));
}

function fileUrl(path) {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return `https://github.com/${REPO_OWNER}/${REPO_NAME}/blob/${REPO_BRANCH}/${encoded}`;
}

function buildIssueBody({ name, email, suggestion, reasoning, path }) {
  const f = fence(suggestion);
  const parts = [
    `**File:** [\`${path}\`](${fileUrl(path)})`,
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
    `**Submitted by:** ${name} (${maskEmail(email)})`,
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
async function githubFetch(pathname, { method = 'GET', body, timeoutMs = GITHUB_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${GITHUB_API}${pathname}`, {
      method,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${process.env.BOT_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'suggest-edit-function',
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
 * The bot has Write, so it may create them. Non-fatal: if this fails we still try
 * the issue — a missing label is cosmetic next to a lost suggestion. The whole pass
 * shares LABEL_BUDGET_MS so it cannot eat the issue call's time.
 */
async function ensureLabels() {
  const deadline = Date.now() + LABEL_BUDGET_MS;
  const remaining = () => deadline - Date.now();

  for (const label of LABELS) {
    if (remaining() <= 0) {
      console.warn(`ensureLabels: out of budget, skipping "${label}"`);
      continue;
    }
    try {
      const existing = await githubFetch(
        `/repos/${REPO_OWNER}/${REPO_NAME}/labels/${encodeURIComponent(label)}`,
        { timeoutMs: remaining() },
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
      const created = await githubFetch(`/repos/${REPO_OWNER}/${REPO_NAME}/labels`, {
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
async function createIssue(data) {
  const res = await githubFetch(`/repos/${REPO_OWNER}/${REPO_NAME}/issues`, {
    method: 'POST',
    body: {
      title: `Suggested edit: ${data.path}`,
      body: buildIssueBody(data),
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
    throw new Error(`github issue creation failed (status ${res.status})`);
  }

  const issue = await res.json();
  if (!issue?.html_url) throw new Error('github issue creation returned no url');
  return issue.html_url;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

function corsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Vary', 'Origin');
}

function send(res, status, payload) {
  res.status(status).json(payload);
}

function parseBody(req) {
  // Vercel parses application/json for us; tolerate a raw string either way.
  const raw = req.body;
  if (raw && typeof raw === 'object' && !Buffer.isBuffer(raw)) return raw;

  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : typeof raw === 'string' ? raw : '';
  if (!text.trim()) return {};
  return JSON.parse(text); // caller turns a throw into a 400
}

async function handle(req, res) {
  const origin = req.headers.origin;

  // --- CORS preflight -----------------------------------------------------
  if (req.method === 'OPTIONS') {
    corsHeaders(res);
    res.status(204).end();
    return;
  }

  // --- Origin check -------------------------------------------------------
  // A missing Origin is not a cross-origin browser request (curl, server-to-server),
  // so we let it through; CORS is not a security boundary and the rate limit and
  // honeypot below do the actual work. A *mismatched* Origin is refused outright.
  if (origin && origin !== ALLOWED_ORIGIN) {
    send(res, 403, { error: `origin not allowed: ${origin}` });
    return;
  }
  // Set before the method guard so even a rejected request is readable by the client.
  corsHeaders(res);

  // --- Method guard -------------------------------------------------------
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    send(res, 405, { error: `method not allowed: ${req.method}` });
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
  // repo's issues index so the field is populated with something real and harmless.
  if (asString(body.website)) {
    console.warn(`honeypot: discarded submission from ip=${ip}`);
    send(res, 201, { issueUrl: REPO_ISSUES_URL });
    return;
  }

  // --- Rate limit ---------------------------------------------------------
  if (isRateLimited(ip, Date.now())) {
    console.warn(`rate limit: ip=${ip} exceeded ${RATE_LIMIT_MAX}/hour`);
    send(res, 429, {
      error: `rate limit exceeded for ip ${ip}`,
      userMessage: "You're sending suggestions too quickly — try again in a little while.",
    });
    return;
  }

  // --- Validation ---------------------------------------------------------
  const result = validate(body);
  if (!result.ok) {
    console.warn(`${result.error} (ip=${ip})`);
    send(res, 400, { error: result.error, userMessage: result.userMessage });
    return;
  }

  // --- Config check -------------------------------------------------------
  if (!process.env.BOT_TOKEN) {
    console.error('config: BOT_TOKEN is not set');
    send(res, 500, { error: 'bot credentials not configured' });
    return;
  }

  // --- File the issue -----------------------------------------------------
  try {
    await ensureLabels();
    const issueUrl = await createIssue(result.data);
    console.log(`created issue for "${result.data.path}" — ${issueUrl}`);
    send(res, 201, { issueUrl });
  } catch (err) {
    // Message is our own normalised text, never an upstream body or a stack.
    console.error(`github: ${err.message}`);
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
