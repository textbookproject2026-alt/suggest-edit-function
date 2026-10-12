/**
 * Bindings the host provides, set per request by worker/index.mjs on Cloudflare:
 * `kv` (KV namespace TOKENS: installation tokens), `cache` (KV namespace CACHE: a
 * book's history data, lib/kv-cache.mjs) and `db` (D1 database DB: rate limits). All
 * stay null under Node (the tests, and Vercel until it is retired), where every cache
 * and limiter is per instance, in memory.
 */
export const platform = { kv: null, cache: null, db: null };
