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
import { platform } from './platform.mjs';

export const GITHUB_API = 'https://api.github.com';
/** The author site (registry platform.pages), where authors answer suggestions. */
export const AUTHOR_SITE = 'https://author.confused4now.org';
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
 * On Cloudflare (platform.db set) the count lives in D1, shared by every isolate: a
 * fixed window of `windowMs` per `name` and key. Without D1 (Node, the tests, Vercel)
 * it is the old per-instance sliding window in memory, a speed bump only. Either way
 * a failure to count lets the request through: a limiter is not a security control.
 *
 * ponytail: fixed window, so a burst across a window boundary can reach 2x max; a
 * sliding count (two windows, weighted) if that ever matters.
 *
 * @returns {(key: string, now: number) => Promise<number>} 0 when the hit counts; over
 *   budget, the time (ms) the window frees up (truthy), for sendLimited()
 */
export function createRateLimiter(max, windowMs, name = 'default') {
  /** @type {Map<string, number[]>} key -> ascending list of timestamps (ms) */
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

  function inMemory(ip, now) {
    sweep(now);
    const cutoff = now - windowMs;
    const fresh = (hits.get(ip) ?? []).filter((t) => t > cutoff);
    if (fresh.length >= max) {
      // Keep the pruned list so the window slides rather than resetting on rejection.
      hits.set(ip, fresh);
      return fresh[fresh.length - max] + windowMs;
    }
    fresh.push(now);
    hits.set(ip, fresh);
    return 0;
  }

  return async function isRateLimited(raw, now) {
    const ip = await hashKey(raw, now);
    if (!platform.db) return inMemory(ip, now);
    const w = Math.floor(now / windowMs);
    try {
      // One statement: count this hit unless the window is already full. No row back = full.
      const row = await platform.db
        .prepare('INSERT INTO hits (k, w, n, until) VALUES (?1, ?2, 1, ?3) ON CONFLICT (k, w) DO UPDATE SET n = n + 1 WHERE n < ?4 RETURNING n')
        .bind(`${name}:${ip}`, w, (w + 1) * windowMs, max)
        .first();
      return row === null ? (w + 1) * windowMs : 0;
    } catch (err) {
      console.error(`rate limit ${name}: D1 failed, letting the request through (${err?.message})`);
      return 0;
    }
  };
}

/** A limiter's 429: Retry-After, and a userMessage that says roughly when (the window's end). */
export function sendLimited(res, until, userMessage) {
  const seconds = Math.max(1, Math.ceil((until - Date.now()) / 1000));
  const minutes = Math.ceil(seconds / 60);
  res.setHeader('Retry-After', String(seconds));
  send(res, 429, {
    error: 'rate limit exceeded',
    userMessage: `${userMessage} Please try again in about ${minutes === 1 ? 'a minute' : `${minutes} minutes`}.`,
  });
}

// ---------------------------------------------------------------------------
// Rate-limit keys: never an IP address
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
let salted = { day: -1, key: null };

/**
 * Today's HMAC key (UTC day): a random salt, in D1 `salts` on Cloudflare so every isolate
 * and the write fallback agree, in memory under Node. One query per isolate per day; the
 * five-minute jobs delete the days before (worker/index.mjs), so a day's keys can't be
 * tied to an address once it is over.
 */
async function todaysKey(now) {
  const day = Math.floor(now / DAY_MS);
  if (salted.day === day) return salted.key;
  let salt = hex(crypto.getRandomValues(new Uint8Array(32)));
  if (platform.db) {
    const row = await platform.db
      .prepare('INSERT INTO salts (day, salt) VALUES (?1, ?2) ON CONFLICT (day) DO UPDATE SET day = day RETURNING salt')
      .bind(day, salt).first();
    salt = row.salt;
  }
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(salt), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  salted = { day, key };
  return key;
}

/**
 * A limiter key with no IP address (or login) in it: "h:" + HMAC-SHA256(key, today's
 * salt). One already hashed (a queued write's, worker/writes.mjs) is kept as it is.
 */
export async function hashKey(key, now = Date.now()) {
  if (key.startsWith('h:')) return key;
  return `h:${hex(await crypto.subtle.sign('HMAC', await todaysKey(now), new TextEncoder().encode(key)))}`;
}

/** The salt is per process: tests start each day fresh. */
export const testing = { resetSalt: () => { salted = { day: -1, key: null }; } };

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

/**
 * The lines that @mention a book's authors on a new reader suggestion, so GitHub
 * emails them: registry `authors`, less `mentions_off` (each author's own choice on
 * the author site's People screen) and less `except` (a signed-in reader who is an
 * author). [] when nobody is left. Goes at the end of the issue or pull request body.
 */
export function mentionLines(book, authorSite, except = '') {
  const skip = new Set([...(book.mentions_off ?? []), except].map((l) => String(l).toLowerCase()));
  const who = (book.authors ?? []).filter((a) => /^[A-Za-z0-9-]{1,39}$/.test(a) && !skip.has(a.toLowerCase()));
  if (!who.length) return [];
  return ['', `For this book's authors: ${who.map((a) => `@${a}`).join(' ')}. Answer it on the author site: ${authorSite}/#/${book.slug}/drafts`];
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
export async function githubFetch(pathname, { token, method = 'GET', body, accept, timeoutMs = GITHUB_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));

  try {
    return await fetch(`${GITHUB_API}${pathname}`, {
      method,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        ...GITHUB_HEADERS,
        ...(accept ? { Accept: accept } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      // A string is JSON already (blobJson): megabytes of base64 aren't serialised again.
      ...(body ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    });
  } catch (err) {
    // AbortError included: normalise so callers never see transport internals.
    throw new Error(err?.name === 'AbortError' ? 'github request timed out' : 'github request failed');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The body of POST /git/blobs for base64 content, built without JSON.stringify, which
 * scans every character (about 3 ms of CPU per MB). Base64 needs no escaping.
 */
export const blobJson = (base64) => `{"encoding":"base64","content":"${base64}"}`;

/**
 * Strict base64, checked natively (a regex over a 3 MB part takes 13 ms of CPU; this
 * about 2): decoding and encoding again gives back exactly the same text.
 */
export const isBase64 = (text) => typeof text === 'string' && text.length % 4 === 0 && Buffer.from(text, 'base64').toString('base64') === text;

/**
 * A JSON object whose last field is a long base64 string, written without
 * JSON.stringify over the base64 (see blobJson), for send().
 */
export const jsonWithBase64 = (fields, base64) =>
  new RawJson(`${JSON.stringify(fields).slice(0, -1)}${Object.keys(fields).length ? ',' : ''}"base64":"${base64}"}`);

/**
 * The size of each blob (by sha) in `repo`, in one GraphQL query instead of reading
 * them: Map sha -> bytes, or a thrown error if any isn't a blob there.
 */
export async function blobSizes(repo, shas, { token, timeoutMs = GITHUB_TIMEOUT_MS }) {
  if (!shas.every((sha) => /^[0-9a-f]{40}$/.test(sha))) throw new Error('blob sizes: not a sha');
  const [owner, name] = repo.split('/');
  const fields = shas.map((sha, i) => `p${i}: object(oid: "${sha}") { ... on Blob { byteSize } }`).join(' ');
  const query = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`;
  const res = await githubFetch('/graphql', { token, method: 'POST', body: { query, variables: { owner, name } }, timeoutMs });
  const found = res.ok ? (await res.json())?.data?.repository : null;
  if (!found) throw Object.assign(new Error(`github graphql blob sizes failed (status ${res.status})`), { status: res.status });
  const sizes = new Map(shas.map((sha, i) => [sha, found[`p${i}`]?.byteSize]));
  if ([...sizes.values()].some((n) => !Number.isInteger(n))) throw new Error('blob sizes: a part is not in the repository');
  return sizes;
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
 * A write that sets labels (a new issue, or labels added to one), with no check first:
 * on the Worker every GitHub call costs CPU. If GitHub refuses it for a missing label
 * (404 or 422), the labels are made once, with their colours, and the write is tried
 * again. (Where GitHub makes a missing label itself, it comes without the colour.)
 *
 * @param {() => Promise<Response>} write  called once, or twice after a 404/422
 */
export async function withLabels(repo, token, defaults, write, budgetMs = 3000) {
  const res = await write();
  if (res.status !== 404 && res.status !== 422) return res;
  console.warn(`labels: GitHub returned ${res.status}; making ${Object.keys(defaults).join(', ')} and trying again`);
  const deadline = Date.now() + budgetMs;
  for (const [label, spec] of Object.entries(defaults)) {
    if (Date.now() >= deadline) break;
    try {
      const made = await githubFetch(`/repos/${repo}/labels`, { token, method: 'POST', body: { name: label, ...spec }, timeoutMs: deadline - Date.now() });
      // 422: it exists already.
      if (!made.ok && made.status !== 422) console.warn(`labels: could not make "${label}" (status ${made.status})`);
    } catch (err) {
      console.warn(`labels: "${label}" skipped — ${err.message}`);
    }
  }
  return write();
}

/**
 * Top-level fields of a GitHub answer without parsing all of it: each key's first
 * occurrence, for answers where GitHub puts them before any nested object (a pull
 * request's or issue's html_url and number, a git object's sha). Anything not found
 * that way falls back to a full parse.
 */
export async function fieldsOf(res, keys) {
  const text = await res.text();
  const out = {};
  for (const k of keys) {
    const m = new RegExp(`"${k}":\\s*("(?:[^"\\\\]|\\\\.)*"|-?\\d+)`).exec(text);
    if (!m) return pick(JSON.parse(text), keys);
    out[k] = JSON.parse(m[1]);
  }
  return out;
}
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o?.[k]]));

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

/** A JSON body already written (jsonWithBase64): send() passes it through as it is. */
export class RawJson {
  constructor(text) {
    this.text = text;
  }
}

export function send(res, status, payload) {
  if (payload instanceof RawJson) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(status).end(payload.text);
    return;
  }
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
 * @returns {{ ok: true, book: object, origin: string } | { ok: false, error: string, log: string }}
 *   `origin` is the request's own origin once it has matched the book (its domain or
 *   one of its Pages addresses): the one to echo in CORS and bind identities to.
 */
export function resolveBook(resolver, origin) {
  if (!origin) return { ok: false, error: 'origin required', log: 'origin missing' };
  const result = resolver.resolve(origin);
  if (result.ok) return result;
  // Logged, not echoed: `error` should never replay caller-controlled input.
  return { ok: false, error: 'origin not allowed', log: `origin rejected: ${origin} (${result.reason})` };
}
