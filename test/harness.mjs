/**
 * Test harness: drives the real exported handler with `fetch` stubbed out, so the
 * assertions exercise the shipped code path (content-type gate, honeypot, limiter,
 * validation, issue body) without ever touching GitHub.
 */
// The shared handler reads its credentials at import, so pin them: the Vercel build runs
// this suite with the project's real GITHUB_APP_* and BOT_TOKEN in the environment, and
// the shared handler must behave the same there as on a laptop (PAT only). Tests that
// want the App path load their own copy with loadHandler().
for (const name of ['GITHUB_APP_ID', 'GITHUB_APP_INSTALLATION_ID', 'GITHUB_APP_PRIVATE_KEY']) delete process.env[name];
process.env.BOT_TOKEN = 'test-token';

/** Captured body of the last POST /issues the handler attempted, or null. */
export let lastIssue = null;
export function resetIssue() { lastIssue = null; }

/** Every outbound request, in order: { method, url, headers, body }. */
export const requests = [];

/**
 * Optional override for POST /app/installations/:id/access_tokens.
 * @type {null | ((url: string, opts: object) => object)}
 */
let tokenExchange = null;
export function stubTokenExchange(fn) { tokenExchange = fn; }

/**
 * Optional override for GET /repos/:owner/:repo/installation. Receives "owner/repo".
 * @type {null | ((repo: string, url: string, opts: object) => object)}
 */
let installationLookup = null;
export function stubInstallationLookup(fn) { installationLookup = fn; }

/** An installation lookup answering `id` for every repository. */
export const installedAs = (id) => () => ({ ok: true, status: 200, json: async () => ({ id }) });
/** GitHub's answer for a repository the App is not installed on. */
export const notInstalled = () => ({ ok: false, status: 404, text: async () => '{"message":"Not Found"}' });

globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  requests.push({ method: opts.method ?? 'GET', url, headers: opts.headers ?? {},
                  body: opts.body ? JSON.parse(opts.body) : undefined });

  if (opts.method === 'POST' && /\/app\/installations\/[^/]+\/access_tokens$/.test(url)) {
    if (!tokenExchange) throw new Error(`unexpected token exchange: ${url}`);
    return tokenExchange(url, opts);
  }
  const lookup = (opts.method ?? 'GET') === 'GET' && url.match(/\/repos\/([^/]+\/[^/]+)\/installation$/);
  if (lookup) {
    if (!installationLookup) throw new Error(`unexpected installation lookup: ${url}`);
    return installationLookup(lookup[1], url, opts);
  }
  if (opts.method === 'POST' && url.endsWith('/issues')) {
    lastIssue = JSON.parse(opts.body);
    const repositoryUrl = url.slice(0, -'/issues'.length);
    return { ok: true, status: 201,
             json: async () => ({ html_url: 'https://example.invalid/issues/1', repository_url: repositoryUrl }) };
  }
  // Label lookups: pretend both labels already exist.
  return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
};

export const { default: handler } = await import('../api/suggest-edit.js');
const { default: BUNDLE } = await import('../registry/bundled.mjs');

/**
 * The Origin every call sends unless told otherwise: the first bundled book that takes
 * suggestions. A request without an Origin is refused, so tests about something else
 * (validation, the limiter, the honeypot) must carry one.
 */
export const DEFAULT_ORIGIN = `https://${BUNDLE.registry.books.find(
  (b) => b.status !== 'retired' && b.site.domain && b.suggest_edit.enabled).site.domain}`;

let instance = 0;
/**
 * A fresh copy of the handler module, loaded with `env` as its environment. Module
 * state (credential config, token cache, limiter) is per copy. Keys set to undefined
 * are removed for the load.
 */
export async function loadHandler(env) {
  const saved = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return (await import(`../api/suggest-edit.js?instance=${++instance}`)).default;
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

function mockRes() {
  return {
    headers: {}, statusCode: 0, payload: undefined, ended: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(p) { this.payload = p; this.ended = true; return this; },
    end() { this.ended = true; return this; },
    get headersSent() { return this.ended; },
  };
}

let ipCounter = 0;
/** Each call gets a unique IP so the module-global limiter cannot bleed between tests. */
export function freshIp() { return `10.0.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`; }

/**
 * @param {object} o
 * @param {string | null} [o.origin]  defaults to DEFAULT_ORIGIN; null sends no Origin header
 * @param {string} [o.ip]  reuse an IP to exercise the rate limiter deliberately
 * @param {Function} [o.using]  a handler from loadHandler(); defaults to the shared one
 */
export async function call({ method = 'POST', contentType = 'application/json',
                             body, origin = DEFAULT_ORIGIN, ip = freshIp(), raw, using = handler } = {}) {
  resetIssue();
  const headers = { 'x-forwarded-for': ip };
  if (contentType !== null) headers['content-type'] = contentType;
  if (origin !== null) headers.origin = origin;

  const req = { method, headers, socket: { remoteAddress: ip },
                body: raw !== undefined ? raw : body };
  const res = mockRes();
  await using(req, res);
  return { status: res.statusCode, payload: res.payload, headers: res.headers, issue: lastIssue };
}

export const VALID = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  suggestion: 'Chapter 3 says "recieve"; it should be "receive".',
  reasoning: 'Spelling.',
  path: 'chapters/chapter-03.md',
};
