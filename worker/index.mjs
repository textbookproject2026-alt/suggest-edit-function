/**
 * c4n-api: the same handlers as the Vercel function (api/, author/), served by one
 * Cloudflare Worker at api.confused4now.org. This file only adapts a Fetch Request to
 * the Node-style req/res the handlers were written for (Vercel's helpers: res.status,
 * res.json, a parsed JSON body) and does vercel.json's two rewrites. Everything else,
 * paths, shapes, headers, CORS, limits, errors, is the handlers' own.
 *
 * Bindings: TOKENS (KV, installation tokens) and DB (D1, rate limits), handed to the
 * handlers through lib/platform.mjs. Secrets and vars arrive as process.env
 * (nodejs_compat), which the handlers read at import, as on Vercel.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { platform } from '../lib/platform.mjs';
import { serve } from './adapter.mjs';
import { fromKv, historyKey, toKv } from './history-cache.mjs';

// Every route is imported here, up front. Cloudflare evaluates this before the first
// request and doesn't count it in any request's CPU time (measured 11 Oct: a fresh
// isolate's first request costs 1 ms either way); loading a route on its first
// request instead put 2-8 ms of evaluation into that request.
import author from '../api/author.js';
import githubAuth from '../api/github-auth.js';
import pageRevision from '../api/page-revision.js';
import proposeEdit from '../api/propose-edit.js';
import requestBook from '../api/request-book.js';
import suggestEdit from '../api/suggest-edit.js';

const ROUTES = {
  '/api/suggest-edit': suggestEdit,
  '/api/propose-edit': proposeEdit,
  '/api/page-revision': pageRevision,
  '/api/github-auth': githubAuth,
  '/api/request-book': requestBook,
  '/api/author': author,
};

// Subrequests per request (the free plan allows 50), logged with each request so
// worker.yml's measurement and Workers Logs can see them beside CPU time.
const counter = new AsyncLocalStorage();
// The first request an isolate serves pays for any lazy start-up work: logged as cold=1
// so CPU can be measured cold and warm separately (scripts/cpu-summary.mjs).
let cold = true;
// Routes this isolate has served: the first request of each logs load=1 (its code runs
// for the first time, unoptimised), the rest load=0.
const loaded = new Set();
const realFetch = globalThis.fetch;
globalThis.fetch = (...args) => {
  const store = counter.getStore();
  if (store) store.n += 1;
  return realFetch(...args);
};

// Vercel's CDN: a GET answered 200 with `s-maxage=N` is served from the edge for N
// seconds without running the function (history 90 s, revisions up to a year), and
// the browser never sees s-maxage. The same here with the Cache API, per data centre.
// The key carries the Origin, since CORS headers depend on it.
function cacheKey(request) {
  if (request.method !== 'GET') return null;
  const url = new URL(request.url);
  url.searchParams.set('__origin', request.headers.get('origin') ?? '');
  return new Request(url.toString());
}

async function keep(key, response, seconds) {
  const sMaxAge = seconds ?? /(?:^|,)\s*s-maxage=(\d+)/.exec(response.headers.get('cache-control') ?? '')?.[1];
  if (response.status !== 200 || !sMaxAge || response.headers.has('set-cookie')) return;
  const copy = new Response(response.body, response);
  copy.headers.set('Cache-Control', `public, max-age=${sMaxAge}`);
  copy.headers.set('X-Edge-Cache-Control', response.headers.get('cache-control'));
  await caches.default.put(key, copy);
}

/** What the browser sees, as on Vercel: no s-maxage, and Vercel's default when unset. */
function forClient(response, version) {
  const out = new Response(response.body, response);
  // Which deployed version answered (scripts/measure-load.mjs waits for a new one).
  if (version) out.headers.set('X-Worker-Version', version);
  const cc = out.headers.get('x-edge-cache-control') ?? out.headers.get('cache-control');
  out.headers.delete('x-edge-cache-control');
  if (!cc) out.headers.set('Cache-Control', 'public, max-age=0, must-revalidate');
  else out.headers.set('Cache-Control', cc.split(',').map((d) => d.trim()).filter((d) => !/^s-maxage=/i.test(d)).join(', '));
  return out;
}

/** vercel.json's rewrites: the handler sees the rewritten URL, as on Vercel. */
function route(url) {
  if (url.pathname === '/api/history') {
    url.pathname = '/api/page-revision';
    url.searchParams.set('mode', 'open');
  }
  const name = url.pathname.match(/^\/api\/author-([a-z-]+)$/)?.[1];
  if (name) {
    url.pathname = '/api/author';
    url.searchParams.set('route', name);
  }
  return ROUTES[url.pathname] ?? null;
}

export default {
  async fetch(request, env, ctx) {
    const wasCold = cold;
    cold = false;
    platform.kv = env.TOKENS ?? null;
    platform.db = env.DB ?? null;

    const url = new URL(request.url);
    const handler = route(url);
    if (!handler) {
      // As Vercel's own 404 for a path with no function. Logged too: as an isolate's
      // first request it is the cost of starting the isolate alone (measure-load.mjs).
      console.log(`c4n-api ${request.method} ${url.pathname} 404 subrequests=0 cold=${wasCold ? 1 : 0} load=0`);
      return forClient(new Response('The page could not be found\n\nNOT_FOUND\n', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }), env.VERSION?.id);
    }
    const path = new URL(request.url).pathname; // before the rewrites
    // Which kind of request, for the CPU summary: page-revision[shas], author-read[publish]…
    const sp = new URL(request.url).searchParams;
    const kind = ['what', 'mode', 'action', 'shas', 'base', 'sha', 'declined', 'path', 'id'].find((k) => sp.has(k));
    const value = ['what', 'mode', 'action'].includes(kind) ? sp.get(kind) : kind;
    const label = kind ? `${path}[${/^[a-z-]{1,24}$/.test(value) ? value : 'other'}]` : path;
    const key = cacheKey(request);
    const hit = key && (await caches.default.match(key));
    if (hit) {
      console.log(`c4n-api ${request.method} ${label} ${hit.status} subrequests=0 cold=${wasCold ? 1 : 0} cache=hit`);
      return forClient(hit, env.VERSION?.id);
    }
    const kvKey = key && path === '/api/history' ? await historyKey(key.url) : null;
    const kept = kvKey && (await fromKv(env.CACHE, kvKey));
    if (kept) {
      console.log(`c4n-api ${request.method} ${label} ${kept.response.status} subrequests=0 cold=${wasCold ? 1 : 0} cache=kv`);
      ctx.waitUntil(keep(key, kept.response.clone(), kept.left));
      return forClient(kept.response, env.VERSION?.id);
    }

    const store = { n: 0 };
    const load = !loaded.has(path);
    loaded.add(path);
    const response = await counter.run(store, () => serve(handler, request, url));
    console.log(`c4n-api ${request.method} ${label} ${response.status} subrequests=${store.n} cold=${wasCold ? 1 : 0} load=${load ? 1 : 0}`);
    if (kvKey) ctx.waitUntil(toKv(env.CACHE, kvKey, response.clone()));
    if (key) ctx.waitUntil(keep(key, response.clone()));
    return forClient(response, env.VERSION?.id);
  },

  /** Daily: drop rate-limit windows that have closed. */
  async scheduled(_event, env) {
    await env.DB.prepare('DELETE FROM hits WHERE until < ?1').bind(Date.now()).run();
  },
};
