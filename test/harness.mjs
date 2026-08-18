/**
 * Test harness: drives the real exported handler with `fetch` stubbed out, so the
 * assertions exercise the shipped code path (content-type gate, honeypot, limiter,
 * validation, issue body) without ever touching GitHub.
 */
process.env.BOT_TOKEN ??= 'test-token';

/** Captured body of the last POST /issues the handler attempted, or null. */
export let lastIssue = null;
export function resetIssue() { lastIssue = null; }

globalThis.fetch = async (url, opts = {}) => {
  if (opts.method === 'POST' && String(url).endsWith('/issues')) {
    lastIssue = JSON.parse(opts.body);
    return { ok: true, status: 201, json: async () => ({ html_url: 'https://example.invalid/issues/1' }) };
  }
  // Label lookups: pretend both labels already exist.
  return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
};

export const { default: handler } = await import('../api/suggest-edit.js');

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
 */
export async function call({ method = 'POST', contentType = 'application/json',
                             body, origin, ip = freshIp(), raw } = {}) {
  resetIssue();
  const headers = { 'x-forwarded-for': ip };
  if (contentType !== null) headers['content-type'] = contentType;
  if (origin) headers.origin = origin;

  const req = { method, headers, socket: { remoteAddress: ip },
                body: raw !== undefined ? raw : body };
  const res = mockRes();
  await handler(req, res);
  return { status: res.statusCode, payload: res.payload, headers: res.headers, issue: lastIssue };
}

export const VALID = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  suggestion: 'Chapter 3 says "recieve"; it should be "receive".',
  reasoning: 'Spelling.',
  path: 'chapters/chapter-03.md',
};
