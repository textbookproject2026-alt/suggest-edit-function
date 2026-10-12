/**
 * A value worked out from GitHub, kept for `ttlMs` in this instance's memory and, on
 * Cloudflare, in KV (platform.cache), so every data centre and isolate shares it: one
 * request in `ttlMs` does the GitHub calls, the rest read it. Older than `ttlMs`, it is
 * worked out again.
 *
 * Free-plan KV allows 1,000 writes a day: one write per recompute, per key. Every KV
 * failure (that limit included) is logged and the value is worked out as if nothing
 * were kept.
 *
 * Kept ahead (batch 2d, `ahead`): scripts/refresh.mjs (refresh.yml, every 15 minutes
 * and after a book's build) writes a book's lists, reader names and editor pages here
 * before anyone asks, each only when it changed, and stamps HEARTBEAT on every run.
 * While that stamp is under FRESH_MS old, what it wrote is current, however old; a
 * write through this function forgets what it changed (`forget`). Without a recent
 * stamp, an entry counts only for the route's own short time, as before.
 */
import { platform } from './platform.mjs';

const memory = new Map();

/** The keys kept ahead, shared by the routes, scripts/refresh.mjs and the writes that forget them. */
export const cacheKeys = {
  open: (slug) => `history:${slug}:open`,
  declined: (slug) => `history:${slug}:declined`,
  /** The "a reader" names of the commits in the book's history.json: { <sha>: name | null }. */
  names: (slug) => `names:${slug}`,
  /** The editor's page, as propose-edit's GET reads it: { branch, sha, text }. */
  source: (repo, branch, path) => `src:${repo}:${branch}:${path}`,
  /** What a reader's or an author's write to the book's issues or pull requests changes. */
  lists: (slug) => [`history:${slug}:open`, `history:${slug}:declined`],
};
export const HEARTBEAT = 'refreshed';
/** Three missed 15-minute refreshes, and what they wrote stops counting. */
export const FRESH_MS = 45 * 60_000;
/** With KV, how long an isolate's memory keeps a value kept ahead before asking KV again. */
const MEMORY_MS = 60_000;
let beat = { at: 0, read: -Infinity };

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

async function heartbeat(now) {
  if (now() - beat.read < MEMORY_MS) return beat.at;
  const v = await platform.cache.get(HEARTBEAT, 'json');
  beat = { at: Number(v?.at) || 0, read: now() };
  return beat.at;
}

/**
 * A value kept ahead: current while the refresh's stamp is recent, or for `shortMs`
 * otherwise. Missing (or without KV), worked out by `compute` and kept; with no
 * `compute`, undefined.
 */
export async function ahead(key, shortMs, compute, now = () => Date.now()) {
  if (!platform.cache) return compute ? kept(key, shortMs, compute, now) : undefined;
  const mem = memory.get(key);
  if (mem?.read !== undefined && now() - mem.read < MEMORY_MS) return mem.value;
  try {
    const [hit, at] = await Promise.all([platform.cache.get(key, 'json'), heartbeat(now)]);
    if (hit && (now() - hit.at < shortMs || now() - at < FRESH_MS)) {
      memory.set(key, { ...hit, read: now() });
      return hit.value;
    }
  } catch (err) {
    console.error(`kv cache: read of ${key} failed (${err?.message})`);
  }
  if (!compute) return undefined;
  const entry = { at: now(), value: await compute() };
  memory.set(key, { ...entry, read: entry.at });
  try {
    await platform.cache.put(key, JSON.stringify(entry));
  } catch (err) {
    console.error(`kv cache: write of ${key} failed (${err?.message})`);
  }
  return entry.value;
}

/** A write changed what these keys hold: dropped here and in KV; other isolates within MEMORY_MS. */
export async function forget(...keys) {
  for (const key of keys) memory.delete(key);
  if (!platform.cache) return;
  await Promise.all(keys.map((key) => platform.cache.delete(key).catch((err) => console.error(`kv cache: delete of ${key} failed (${err?.message})`))));
}
