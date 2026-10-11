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
import { platform } from '../lib/platform.mjs';
import { serve } from './adapter.mjs';
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
  async fetch(request, env) {
    platform.kv = env.TOKENS ?? null;
    platform.db = env.DB ?? null;

    const url = new URL(request.url);
    const handler = route(url);
    if (!handler) {
      return Response.json({ error: 'not found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
    }
    return serve(handler, request, url);
  },

  /** Daily: drop rate-limit windows that have closed. */
  async scheduled(_event, env) {
    await env.DB.prepare('DELETE FROM hits WHERE until < ?1').bind(Date.now()).run();
  },
};
