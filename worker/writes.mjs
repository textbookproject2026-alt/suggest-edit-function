/**
 * Writes on the Worker (batch 2d, 13 Oct). A page sends each write with a key
 * (?write_key=, made from the page load and the body), which is claimed in D1 before
 * anything is written: a write sent twice runs once, and the repeat gets the first
 * one's answer (or 202 while it is still running).
 *
 * A write can still fail here: the free plan stops a request that uses too much CPU
 * (Cloudflare's error 1102, a 503 the page can't even read), or a handler answers 5xx.
 * The page then sends the same request again with &fallback=<what it saw>. That
 * queues it in D1 (writes.request) and asks the write-fallback workflow (GitHub
 * Actions, scripts/fallback.mjs) to run the same handler there, with no CPU limit. The
 * page shows "Saving… this can take up to a minute" and asks /api/write-status until
 * the answer is in. Every failure and fallback is a row in write_events: /api/health.
 *
 * ponytail: a write the CPU limit stopped after one of its GitHub calls had gone
 * through is run again from the start by the fallback, so that one step can happen
 * twice (an extra branch, say). Record each step's result per key if that shows up.
 */
import BUNDLE from '../registry/bundled.mjs';
import { createResolver, validateRegistry } from '../lib/registry.mjs';
import { appCredentials, authorise, budget, ghJson } from '../lib/author.mjs';
import { createRateLimiter } from '../lib/common.mjs';
import { serve } from './adapter.mjs';

/** Routes that write (POST only); everything else is served as before. */
export const WRITES = new Set([
  '/api/suggest-edit', '/api/propose-edit', '/api/request-book',
  '/api/author-send', '/api/author-import', '/api/author-act', '/api/author-people-change',
]);
export const isWrite = (method, path) => method === 'POST' && WRITES.has(path);
export const KEY_RE = /^[A-Za-z0-9_-]{16,64}$/;
/** Where the write-fallback workflow lives; the App starts it with a repository_dispatch. */
export const FALLBACK_REPO = process.env.FALLBACK_REPO || 'textbookproject2026-alt/suggest-edit-function';
const WAIT_MESSAGE = 'Saving… this can take up to a minute.';
// A page that gave up waiting (its own timeout) may be wrong that the first try died.
const RUNNING_MS = 30_000;

const RESOLVER = createResolver(validateRegistry(BUNDLE.registry));
const queueLimit = createRateLimiter(30, 60 * 60 * 1000, 'fallback');
const fallbackToken = appCredentials({ contents: 'write' });

/** Test books only: `&fail=cpu` spends CPU until Cloudflare stops the request (1102). */
export const testing = {
  burn() {
    let x = 0;
    for (let i = 0; i < 4e9; i++) x = (x * 31 + i) % 1000003;
    return x;
  },
};
const isTestBook = (origin) => {
  const r = RESOLVER.resolve(origin);
  return r.ok && r.book.slug.startsWith('platform-test');
};

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
});
/** A book page reads these answers itself; the author site's server doesn't need CORS. */
function corsFor(request) {
  const origin = request.headers.get('origin');
  return origin && RESOLVER.resolve(origin).ok ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
}
const pending = (key, cors, state) => json(202, { pending: true, state, writeKey: key, userMessage: WAIT_MESSAGE }, cors);
const replay = (row, cors) => new Response(row.result, {
  status: row.status, headers: { 'Content-Type': row.type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Write': 'replayed', ...cors },
});
const rowOf = (db, key) => db.prepare('SELECT state, at, status, type, result FROM writes WHERE key = ?1').bind(key).first();

/** One line in the health check. Never fails the write it is about. */
export async function event(db, kind, route, detail = '') {
  try {
    await db.prepare('INSERT INTO write_events (at, kind, route, detail) VALUES (?1, ?2, ?3, ?4)').bind(Date.now(), kind, route, String(detail).slice(0, 300)).run();
  } catch (err) {
    console.error(`write event ${kind} not logged: ${err?.message}`);
  }
  console.log(`c4n-api write ${kind} ${route} ${detail}`);
}

/**
 * A POST to a write route. `url` is the URL as it came (before the router's rewrites),
 * `run()` serves it with its handler.
 */
export async function write(request, path, url, db, run) {
  const key = url.searchParams.get('write_key');
  if (!db || !KEY_RE.test(key ?? '')) return run(); // a page from before keys: as before
  const cors = corsFor(request);
  const seen = url.searchParams.get('fallback');
  if (seen !== null) return queue(request, path, url, db, key, seen, cors);

  // Claim the key: a new one, or one whose last try failed.
  const now = Date.now();
  const claimed = await db.prepare(
    `INSERT INTO writes (key, route, state, at) VALUES (?1, ?2, 'running', ?3)
     ON CONFLICT (key) DO UPDATE SET state = 'running', at = ?3, status = NULL, type = NULL, result = NULL, request = NULL
     WHERE writes.state = 'failed' RETURNING key`,
  ).bind(key, path, now).first();
  if (!claimed) {
    const row = await rowOf(db, key);
    return row?.state === 'done' ? replay(row, cors) : pending(key, cors, row?.state ?? 'running');
  }
  if (url.searchParams.get('fail') === 'cpu' && isTestBook(request.headers.get('origin'))) testing.burn();

  const res = await run();
  if (res.status >= 500) {
    await db.prepare(`UPDATE writes SET state = 'failed', at = ?2 WHERE key = ?1`).bind(key, Date.now()).run();
    await event(db, 'inline-failed', path, `answered ${res.status}`);
    return res;
  }
  if (res.status >= 300) {
    // A refusal isn't kept: the reader can put it right and send the same again.
    await db.prepare('DELETE FROM writes WHERE key = ?1').bind(key).run();
    return res;
  }
  const text = await res.text();
  await db.prepare(`UPDATE writes SET state = 'done', at = ?2, status = ?3, type = ?4, result = ?5 WHERE key = ?1`)
    .bind(key, Date.now(), res.status, res.headers.get('content-type'), text).run();
  return new Response(text, res);
}

/** The page's second try after a failure: queue the same request for the fallback. */
async function queue(request, path, url, db, key, seen, cors) {
  const now = Date.now();
  const row = await rowOf(db, key);
  if (row?.state === 'done') return replay(row, cors);
  if (row?.state === 'queued' || row?.state === 'fallback') return pending(key, cors, row.state);
  // Timed out on the page, not refused by Cloudflare: the first try may still be going.
  if (row?.state === 'running' && !/^(?:5\d\d|network)$/.test(seen) && now - row.at < RUNNING_MS) return pending(key, cors, 'running');

  const ip = request.headers.get('cf-connecting-ip') ?? '';
  const until = await queueLimit(ip, now);
  if (until) return json(429, { error: 'rate limit exceeded', userMessage: 'Too many tries just now. Please wait a few minutes.' }, cors);

  const body = await request.text();
  // An author's request is checked now: the author site's assertion can be read once.
  let auth = null;
  if (path.startsWith('/api/author-')) {
    const refusal = await serve(async (req, r) => {
      auth = await authorise(req, r, 'POST');
    }, new Request(url, { method: 'POST', headers: request.headers, body }), url);
    if (!auth) return refusal;
  }
  const search = new URLSearchParams(url.search);
  search.delete('fallback');
  search.delete('fail');
  const headers = {};
  for (const h of ['origin', 'content-type', 'user-agent', 'accept']) {
    const v = request.headers.get(h);
    if (v) headers[h] = v;
  }
  if (ip) headers['cf-connecting-ip'] = ip;
  const stored = JSON.stringify({ path, search: search.toString(), headers, body, auth: auth && { identity: auth.identity, tag: auth.tag } });
  const queued = await db.prepare(
    `INSERT INTO writes (key, route, state, at, request) VALUES (?1, ?2, 'queued', ?3, ?4)
     ON CONFLICT (key) DO UPDATE SET state = 'queued', at = ?3, request = ?4 WHERE writes.state IN ('running', 'failed')
     RETURNING key`,
  ).bind(key, path, now, stored).first();
  if (!queued) return pending(key, cors, 'queued'); // another try got there first
  await event(db, 'inline-failed', path, `the page saw ${seen}`);
  await event(db, 'queued', path);
  await dispatch(key).catch((err) => event(db, 'dispatch-failed', path, err.message));
  return pending(key, cors, 'queued');
}

/** Start write-fallback now (its five-minute schedule picks up anything this misses). */
async function dispatch(key) {
  const { token } = await fallbackToken({ slug: 'c4n-api', content: { repo: FALLBACK_REPO } }, 'fallback');
  await ghJson(`/repos/${FALLBACK_REPO}/dispatches`, token, budget(8000), {
    method: 'POST', body: { event_type: 'c4n-write', client_payload: { key } },
  });
}

/** GET /api/write-status?write_key=: the answer once there is one, else 202. */
export async function writeStatus(url, db) {
  const cors = { 'Access-Control-Allow-Origin': '*' };
  const key = url.searchParams.get('write_key');
  if (!KEY_RE.test(key ?? '')) return json(400, { error: 'write_key required' }, cors);
  const row = await rowOf(db, key);
  if (!row) return json(404, { error: 'no such write' }, cors);
  if (row.result !== null && row.status !== null) return replay(row, cors);
  return pending(key, cors, row.state);
}

/**
 * GET /api/health: every write that failed on the Worker and every fallback, the last
 * day's counts, and anything still waiting. 503 when a fallback failed or couldn't be
 * started in the last day, or a queued write has waited over ten minutes.
 */
export async function health(db) {
  const now = Date.now();
  const [counts, waiting, recent] = await Promise.all([
    db.prepare('SELECT kind, COUNT(*) AS n FROM write_events WHERE at > ?1 GROUP BY kind').bind(now - 86_400_000).all(),
    db.prepare(`SELECT COUNT(*) AS n, MIN(at) AS oldest FROM writes WHERE state IN ('queued', 'fallback')`).first(),
    db.prepare('SELECT at, kind, route, detail FROM write_events ORDER BY at DESC LIMIT 50').all(),
  ]);
  const day = Object.fromEntries((counts.results ?? []).map((r) => [r.kind, r.n]));
  const stuck = waiting?.n > 0 && now - waiting.oldest > 10 * 60_000;
  const ok = !day['fallback-failed'] && !day['dispatch-failed'] && !stuck;
  return json(ok ? 200 : 503, {
    ok,
    lastDay: day,
    waiting: { writes: waiting?.n ?? 0, oldest: waiting?.oldest ? new Date(waiting.oldest).toISOString() : null },
    events: (recent.results ?? []).map((e) => ({ at: new Date(e.at).toISOString(), kind: e.kind, route: e.route, detail: e.detail })),
  }, { 'Access-Control-Allow-Origin': '*' });
}

/** Daily: answers are kept a week, events three months. */
export async function sweep(db) {
  const now = Date.now();
  await db.prepare(`DELETE FROM writes WHERE at < ?1 AND state IN ('done', 'failed')`).bind(now - 7 * 86_400_000).run();
  await db.prepare('DELETE FROM write_events WHERE at < ?1').bind(now - 90 * 86_400_000).run();
}
