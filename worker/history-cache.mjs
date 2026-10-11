/**
 * /api/history in KV (binding CACHE, namespace c4n-api-cache): one copy for every data
 * centre, so most reads do no GitHub calls and no recomputation. An entry is served
 * while it is younger than the s-maxage the handler gave it (90 s for history), then
 * recomputed. The per-data-centre Cache API (worker/index.mjs) stays in front.
 *
 * Free-plan KV allows 1,000 writes a day: one write per recompute, so a page read
 * at least once every 90 s all day would use about 960. Every KV failure (the daily
 * limit included) is logged and the request is served as if nothing were cached.
 */
const sMaxAgeOf = (response) => Number(/(?:^|,)\s*s-maxage=(\d+)/.exec(response.headers.get('cache-control') ?? '')?.[1]) || 0;

/** The KV key for a Cache API key URL (which already carries the Origin). */
export async function historyKey(url) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url));
  return `history:${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** -> { response, left } (seconds of freshness left), or null. */
export async function fromKv(kv, key, now = Date.now()) {
  if (!kv) return null;
  try {
    const kept = await kv.get(key, 'json');
    const left = kept ? Math.floor(kept.ttl - (now - kept.at) / 1000) : 0;
    if (left <= 0) return null;
    return { response: new Response(kept.body, { status: kept.status, headers: kept.headers }), left };
  } catch (err) {
    console.error(`history cache: KV read failed (${err?.message})`);
    return null;
  }
}

export async function toKv(kv, key, response, now = Date.now()) {
  const ttl = sMaxAgeOf(response);
  if (!kv || response.status !== 200 || !ttl || response.headers.has('set-cookie')) return;
  try {
    const value = { at: now, ttl, status: response.status, headers: [...response.headers], body: await response.text() };
    await kv.put(key, JSON.stringify(value), { expirationTtl: Math.max(60, ttl) }); // KV's minimum TTL is 60 s
  } catch (err) {
    console.error(`history cache: KV write failed (${err?.message})`);
  }
}
