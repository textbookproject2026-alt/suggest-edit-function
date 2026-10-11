/**
 * Every /api/author-* URL, in one function (Vercel's per-deployment function cap).
 * vercel.json rewrites /api/author-<name> here with ?route=<name>; the handlers live
 * in author/ and see the request unchanged. Each is loaded on its first request, so a
 * request loads only its own handler's code (on the Worker, part of its CPU time).
 */
import { send as reply } from '../lib/common.mjs';

const ROUTES = {
  act: () => import('../author/author-act.js'),
  history: () => import('../author/author-history.js'),
  import: () => import('../author/author-import.js'),
  'people-change': () => import('../author/author-people-change.js'),
  people: () => import('../author/author-people.js'),
  read: () => import('../author/author-read.js'),
  send: () => import('../author/author-send.js'),
  sync: () => import('../author/author-sync.js'),
};

export default async function handler(req, res) {
  const url = new URL(req.url ?? '/', 'https://local.invalid');
  const name = url.pathname.match(/\/api\/author-([a-z-]+)$/)?.[1] ?? url.searchParams.get('route');
  const load = Object.hasOwn(ROUTES, name ?? '') ? ROUTES[name] : null;
  if (!load) return reply(res, 404, { error: 'not found' });
  return (await load()).default(req, res);
}
