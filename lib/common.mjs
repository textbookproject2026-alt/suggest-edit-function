/**
 * What the endpoints share: the GitHub fetch wrapper, the credential, the rate
 * limiter, request plumbing and the markdown-safety helpers. Moved here unchanged
 * from api/suggest-edit.js when api/propose-edit.js arrived.
 *
 * Everything with state is a factory, called at an endpoint module's load: each
 * endpoint (and each test's fresh copy of one) gets its own credential config,
 * token cache and limiter.
 */
import { readCredentialConfig, createInstallationTokenSource } from './github-app.mjs';

export const GITHUB_API = 'https://api.github.com';
export const GITHUB_HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'suggest-edit-function',
};
export const GITHUB_TIMEOUT_MS = 8000;
// Minting an installation token on a cold cache (installation lookup and exchange share
// this budget).
export const TOKEN_EXCHANGE_TIMEOUT_MS = 3000;

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/**
 * Read once per cold start and reported loudly. The GitHub App is the credential.
 * BOT_TOKEN is a TEMPORARY fallback so the form stays up while the App is rolled
 * out: it is used when the App variables are absent or malformed, or when minting
 * an App token fails. Every request logs which path it took.
 *
 * @param {object} env process.env
 * @param {Record<string, string>} [permissions] what an installation token is downscoped to
 */
export function createCredentials(env, permissions = { issues: 'write' }) {
  const config = readCredentialConfig(env);
  const source = config.app
    ? createInstallationTokenSource({
        app: config.app,
        api: GITHUB_API,
        headers: GITHUB_HEADERS,
        timeoutMs: TOKEN_EXCHANGE_TIMEOUT_MS,
        permissions,
      })
    : null;

  if (config.app) {
    console.log(
      `config: credential=app (app ${config.app.appId}, installation looked up per repository)` +
        (config.botToken ? '; BOT_TOKEN fallback is also set' : ''),
    );
  } else if (config.botToken) {
    console.error(`config: GitHub App NOT usable — ${config.appProblem}. Using the BOT_TOKEN fallback for every request.`);
  } else {
    console.error(`config: FATAL no GitHub credential — ${config.appProblem}, and BOT_TOKEN is not set. Every submission will fail.`);
  }
  for (const name of config.retired) {
    console.warn(`config: ${name} is set but no longer read (the installation is looked up per repository); delete it`);
  }

  /**
   * @returns {Promise<{ ok: true, kind: 'app' | 'bot_token', token: string }
   *                  | { ok: false, status: number, error: string }>}
   */
  async function acquire(book, tag) {
    const repo = book.content.repo;
    let fallbackReason = `app not configured: ${config.appProblem}`;

    if (source) {
      try {
        const { token, cached, installationId } = await source.get(repo);
        console.log(`credential=app (${cached ? 'cached' : 'minted'} installation token for ${repo}, installation ${installationId}) ${tag}`);
        return { ok: true, kind: 'app', token };
      } catch (err) {
        if (!config.botToken) {
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

    if (config.botToken) {
      console.warn(`credential=bot_token (fallback; ${fallbackReason}) ${tag}`);
      return { ok: true, kind: 'bot_token', token: config.botToken };
    }

    console.error(`config: no GitHub credential configured ${tag}`);
    return { ok: false, status: 500, error: 'bot credentials not configured' };
  }

  /** A revoked or expired App token must not stay cached for the rest of the instance. */
  function refused(book, credential) {
    if (credential.kind === 'app') source.invalidate(book.content.repo);
  }

  return { acquire, refused };
}

// ---------------------------------------------------------------------------
// Rate limiting (best-effort only)
// ---------------------------------------------------------------------------

/**
 * HONEST LIMITATION: the Map lives in the memory of a single serverless instance.
 * Vercel runs many instances concurrently and recycles them freely, so the counter
 * is per-instance and resets on every cold start. A speed bump against casual
 * form-mashing, not a security control.
 *
 * @returns {(ip: string, now: number) => boolean} true when the IP is over budget
 */
export function createRateLimiter(max, windowMs) {
  /** @type {Map<string, number[]>} ip -> ascending list of timestamps (ms) */
  const hits = new Map();
  let lastSweep = 0;

  /** Drop entries whose timestamps have all aged out, so the Map cannot grow forever. */
  function sweep(now) {
    if (now - lastSweep < windowMs) return;
    lastSweep = now;
    const cutoff = now - windowMs;
    for (const [ip, timestamps] of hits) {
      const fresh = timestamps.filter((t) => t > cutoff);
      if (fresh.length === 0) hits.delete(ip);
      else hits.set(ip, fresh);
    }
  }

  return function isRateLimited(ip, now) {
    sweep(now);
    const cutoff = now - windowMs;
    const fresh = (hits.get(ip) ?? []).filter((t) => t > cutoff);
    if (fresh.length >= max) {
      // Keep the pruned list so the window slides rather than resetting on rejection.
      hits.set(ip, fresh);
      return true;
    }
    fresh.push(now);
    hits.set(ip, fresh);
    return false;
  };
}

/** First hop of x-forwarded-for is the client as seen by the edge. */
export function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const first = typeof raw === 'string' ? raw.split(',')[0].trim() : '';
  return first || req.socket?.remoteAddress || 'unknown';
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

// Deliberately loose: shape check only.
export const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

// Word chars, spaces, and the punctuation that shows up in real chapter filenames
// (including the em dash the textbook uses in headings). Must end in .md.
const PATH_RE = /^[\w\-/().,'&%+ —]+\.md$/;
export const MAX_PATH = 300;

export function asString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** A repo-relative .md path with no traversal, URL or absolute form. */
export function isSafePath(path) {
  return (
    path.length <= MAX_PATH &&
    !path.includes('..') &&
    !path.includes('://') &&
    !path.includes('//') &&
    !path.startsWith('/') &&
    PATH_RE.test(path)
  );
}

// ---------------------------------------------------------------------------
// Markdown safety
// ---------------------------------------------------------------------------

/** first char + *** + @domain, e.g. "a***@example.com". Never store the full address. */
export function maskEmail(email) {
  const at = email.lastIndexOf('@');
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

/**
 * Render user text as a markdown code span, so it is displayed but can never be
 * markup. GitHub does not linkify @mentions, links or images inside a code span.
 */
export function inlineCode(text) {
  // A code span cannot cross a line break: fold every whitespace run to one space.
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
export function fence(text) {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return '`'.repeat(Math.max(3, longest + 1));
}

export function fileUrl(book, path, branch = book.content.live_branch) {
  // encodeURIComponent leaves ( and ) alone, and an unbalanced ')' would terminate
  // the markdown link destination early. isSafePath permits both, so encode them.
  const encoded = path
    .split('/')
    .map((seg) => encodeURIComponent(seg).replace(/\(/g, '%28').replace(/\)/g, '%29'))
    .join('/');
  return `https://github.com/${book.content.repo}/blob/${branch}/${encoded}`;
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

/**
 * fetch against the GitHub REST API with an abort. The token goes in the
 * Authorization header and is never logged or returned.
 */
export async function githubFetch(pathname, { token, method = 'GET', body, timeoutMs = GITHUB_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));

  try {
    return await fetch(`${GITHUB_API}${pathname}`, {
      method,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        ...GITHUB_HEADERS,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (err) {
    // AbortError included: normalise so callers never see transport internals.
    throw new Error(err?.name === 'AbortError' ? 'github request timed out' : 'github request failed');
  } finally {
    clearTimeout(timer);
  }
}

/** A GitHub response body for the server log only; it never reaches a response. */
export async function detailOf(res) {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '<unreadable>';
  }
}

/**
 * Make sure the labels exist before they're referenced. Non-fatal throughout: a
 * missing label is cosmetic next to a lost submission. The whole pass shares
 * `budgetMs` so it cannot eat the main call's time.
 */
export async function ensureLabels(repo, token, defaults, budgetMs) {
  const deadline = Date.now() + budgetMs;
  const remaining = () => deadline - Date.now();

  for (const [label, spec] of Object.entries(defaults)) {
    if (remaining() <= 0) {
      console.warn(`ensureLabels: out of budget, skipping "${label}"`);
      continue;
    }
    try {
      const existing = await githubFetch(`/repos/${repo}/labels/${encodeURIComponent(label)}`, { token, timeoutMs: remaining() });
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
        body: { name: label, ...spec },
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

// ---------------------------------------------------------------------------
// Request plumbing
// ---------------------------------------------------------------------------

/** `origin` is always the registry-derived origin of the resolved book, never the raw header. */
export function corsHeaders(res, origin, methods = 'POST, OPTIONS') {
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Vary', 'Origin');
}

export function send(res, status, payload) {
  res.status(status).json(payload);
}

/** Strictly application/json, with or without parameters ("; charset=utf-8"). */
export function isJsonContentType(req) {
  const raw = req.headers['content-type'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return false;
  return value.split(';')[0].trim().toLowerCase() === 'application/json';
}

export function parseBody(req) {
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
export function resolveBook(resolver, origin) {
  if (!origin) return { ok: false, error: 'origin required', log: 'origin missing' };
  const result = resolver.resolve(origin);
  if (result.ok) return result;
  // Logged, not echoed: `error` should never replay caller-controlled input.
  return { ok: false, error: 'origin not allowed', log: `origin rejected: ${origin} (${result.reason})` };
}
