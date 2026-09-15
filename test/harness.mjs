/**
 * Test harness: drives the real exported handler with `fetch` stubbed out, so the
 * assertions exercise the shipped code path (content-type gate, honeypot, limiter,
 * validation, issue body) without ever touching GitHub.
 */
process.env.BOT_TOKEN ??= 'test-token';

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

globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  requests.push({ method: opts.method ?? 'GET', url, headers: opts.headers ?? {},
                  body: opts.body ? JSON.parse(opts.body) : undefined });

  if (opts.method === 'POST' && /\/app\/installations\/[^/]+\/access_tokens$/.test(url)) {
    if (!tokenExchange) throw new Error(`unexpected token exchange: ${url}`);
    return tokenExchange(url, opts);
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
 * @param {string} [o.ip]  reuse an IP to exercise the rate limiter deliberately
 * @param {Function} [o.using]  a handler from loadHandler(); defaults to the shared one
 */
export async function call({ method = 'POST', contentType = 'application/json',
                             body, origin, ip = freshIp(), raw, using = handler } = {}) {
  resetIssue();
  const headers = { 'x-forwarded-for': ip };
  if (contentType !== null) headers['content-type'] = contentType;
  if (origin) headers.origin = origin;

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
