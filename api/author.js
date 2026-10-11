/**
 * Every /api/author-* URL, in one function (Vercel's per-deployment function cap).
 * vercel.json rewrites /api/author-<name> here with ?route=<name>; the handlers live
 * in author/ and see the request unchanged.
 */
import act from '../author/author-act.js';
import history from '../author/author-history.js';
import imp from '../author/author-import.js';
import peopleChange from '../author/author-people-change.js';
import people from '../author/author-people.js';
import read from '../author/author-read.js';
import send from '../author/author-send.js';
import sync from '../author/author-sync.js';
import { send as reply } from '../lib/common.mjs';

const ROUTES = { act, history, import: imp, 'people-change': peopleChange, people, read, send, sync };

export default async function handler(req, res) {
  const url = new URL(req.url ?? '/', 'https://local.invalid');
  const name = url.pathname.match(/\/api\/author-([a-z-]+)$/)?.[1] ?? url.searchParams.get('route');
  const route = Object.hasOwn(ROUTES, name ?? '') ? ROUTES[name] : null;
  return route ? route(req, res) : reply(res, 404, { error: 'not found' });
}
