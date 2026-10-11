/**
 * Bindings the host provides, set per request by worker/index.mjs on Cloudflare:
 * `kv` (KV namespace TOKENS: installation tokens) and `db` (D1 database DB: rate
 * limits). Both stay null under Node (the tests, and Vercel until it is retired),
 * where every cache and limiter is per instance, in memory.
 */
export const platform = { kv: null, db: null };
