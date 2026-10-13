/**
 * The write fallback (worker/writes.mjs), run by .github/workflows/write-fallback.yml:
 * each write a page queued after it failed on the Worker, through the same handler
 * the Worker runs, in Node, with no CPU limit. D1 (keys, limits, events) and the CACHE
 * KV namespace (a book's history, dropped after a write) are reached over Cloudflare's
 * API with CLOUDFLARE_API_TOKEN; the Worker's own secrets and vars come as env.
 *
 *   node scripts/fallback.mjs [key]   that write, then anything else waiting
 *
 * Exits 1 if a write still failed (a red run), after recording its answer for the page.
 */
const CF = 'https://api.cloudflare.com/client/v4';
const KEY_RE = /^[A-Za-z0-9_-]{16,64}$/;
// A run that died mid-write leaves its rows in 'fallback': taken again after this long.
const STALE_MS = 10 * 60_000;

const auth = { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` };

async function cf(path, init = {}) {
  const res = await fetch(`${CF}${path}`, { ...init, headers: { ...auth, ...init.headers } });
  const out = await res.json().catch(() => null);
  if (!res.ok || !out?.success) throw new Error(`cloudflare ${path.split('?')[0]}: ${res.status} ${JSON.stringify(out?.errors ?? '')}`);
  return out.result;
}

/** D1 over the API, shaped like the binding: prepare(sql).bind(...).first()/run()/all(). */
export function d1(account, id) {
  const query = async (sql, params) => (await cf(`/accounts/${account}/d1/database/${id}/query`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sql, params }),
  }))[0]?.results ?? [];
  const statement = (sql, params = []) => ({
    bind: (...p) => statement(sql, p),
    first: async () => (await query(sql, params))[0] ?? null,
    run: async () => ({ success: true, results: await query(sql, params) }),
    all: async () => ({ results: await query(sql, params) }),
  });
  return { prepare: (sql) => statement(sql) };
}

/** A KV namespace over the API, shaped like the binding (get, put, delete). */
export function kv(account, id) {
  const at = (key) => `${CF}/accounts/${account}/storage/kv/namespaces/${id}/values/${encodeURIComponent(key)}`;
  return {
    async get(key, type) {
      const res = await fetch(at(key), { headers: auth });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`kv get: ${res.status}`);
      return type === 'json' ? res.json() : res.text();
    },
    async put(key, value, { expirationTtl } = {}) {
      const res = await fetch(at(key) + (expirationTtl ? `?expiration_ttl=${expirationTtl}` : ''), { method: 'PUT', headers: auth, body: value });
      if (!res.ok) throw new Error(`kv put: ${res.status}`);
    },
    async delete(key) {
      const res = await fetch(at(key), { method: 'DELETE', headers: auth });
      if (!res.ok && res.status !== 404) throw new Error(`kv delete: ${res.status}`);
    },
  };
}

/** Run one claimed write; returns its status. */
export async function runOne(db, claimed, { route, serve, platform, event }) {
  const r = JSON.parse(claimed.request);
  platform.asserted = r.auth ?? null;
  const url = new URL(`https://api.confused4now.org${r.path}${r.search ? `?${r.search}` : ''}`);
  const handler = route(url);
  const res = handler
    ? await serve(handler, new Request(url, { method: 'POST', headers: r.headers, body: r.body }), url)
    : Response.json({ error: 'no such route' }, { status: 404 });
  platform.asserted = null;
  const text = await res.text();
  const ok = res.status < 500;
  await db.prepare(`UPDATE writes SET state = ?2, at = ?3, status = ?4, type = ?5, result = ?6, request = NULL WHERE key = ?1`)
    .bind(claimed.key, ok ? 'done' : 'failed', Date.now(), res.status, res.headers.get('content-type'), text).run();
  await event(db, ok ? 'fallback-done' : 'fallback-failed', r.path, `answered ${res.status}`);
  return res.status;
}

async function main() {
  if (!process.env.CLOUDFLARE_API_TOKEN) throw new Error('CLOUDFLARE_API_TOKEN is not set');
  const first = process.argv[2] ?? '';
  if (first && !KEY_RE.test(first)) throw new Error('not a write key');
  const account = (await cf('/zones?name=confused4now.org'))[0].account.id;
  const dbId = (await cf(`/accounts/${account}/d1/database?name=c4n-api`)).find((d) => d.name === 'c4n-api')?.uuid;
  const cacheId = (await cf(`/accounts/${account}/storage/kv/namespaces?per_page=100`)).find((n) => n.title === 'c4n-api-cache')?.id;
  if (!dbId || !cacheId) throw new Error('D1 c4n-api or KV c4n-api-cache not found');
  const db = d1(account, dbId);

  const { platform } = await import('../lib/platform.mjs');
  platform.db = db;
  platform.cache = kv(account, cacheId);
  const { route } = await import('../worker/index.mjs');
  const { serve } = await import('../worker/adapter.mjs');
  const { event } = await import('../worker/writes.mjs');

  const waiting = await db.prepare(`SELECT key FROM writes WHERE state = 'queued' OR (state = 'fallback' AND at < ?1) ORDER BY at`)
    .bind(Date.now() - STALE_MS).all();
  const keys = [...new Set([first, ...waiting.results.map((r) => r.key)].filter(Boolean))];
  let failed = 0;
  for (const key of keys) {
    // Claimed, so two runs never do the same write.
    const claimed = await db.prepare(
      `UPDATE writes SET state = 'fallback', at = ?2 WHERE key = ?1 AND (state = 'queued' OR (state = 'fallback' AND at < ?3)) RETURNING key, request`,
    ).bind(key, Date.now(), Date.now() - STALE_MS).first();
    if (!claimed?.request) continue;
    const status = await runOne(db, claimed, { route, serve, platform, event });
    console.log(`write ${key.slice(0, 6)}…: ${status}`);
    if (status >= 500) failed += 1;
  }
  console.log(`${keys.length ? `${keys.length} write(s) looked at` : 'Nothing waiting'}; ${failed} failed.`);
  if (failed) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
