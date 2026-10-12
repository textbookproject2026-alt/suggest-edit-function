/**
 * A value worked out from GitHub, kept for `ttlMs` in this instance's memory and, on
 * Cloudflare, in KV (platform.cache), so every data centre and isolate shares it: one
 * request in `ttlMs` does the GitHub calls, the rest read it. Older than `ttlMs`, it is
 * worked out again.
 *
 * Free-plan KV allows 1,000 writes a day: one write per recompute, per key. Every KV
 * failure (that limit included) is logged and the value is worked out as if nothing
 * were kept.
 */
import { platform } from './platform.mjs';

const memory = new Map();

export async function kept(key, ttlMs, compute, now = () => Date.now()) {
  const mem = memory.get(key);
  if (mem && now() - mem.at < ttlMs) return mem.value;
  if (platform.cache) {
    try {
      const hit = await platform.cache.get(key, 'json');
      if (hit && now() - hit.at < ttlMs) {
        memory.set(key, hit);
        return hit.value;
      }
    } catch (err) {
      console.error(`kv cache: read of ${key} failed (${err?.message})`);
    }
  }
  const entry = { at: now(), value: await compute() };
  memory.set(key, entry);
  if (memory.size > 200) memory.delete(memory.keys().next().value);
  if (platform.cache) {
    try {
      await platform.cache.put(key, JSON.stringify(entry), { expirationTtl: Math.max(60, Math.ceil(ttlMs / 1000)) }); // KV's minimum is 60 s
    } catch (err) {
      console.error(`kv cache: write of ${key} failed (${err?.message})`);
    }
  }
  return entry.value;
}
