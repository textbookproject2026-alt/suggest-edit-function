import test from 'node:test';
import assert from 'node:assert/strict';
import { fromKv, historyKey, toKv } from '../worker/history-cache.mjs';

const fakeKv = () => {
  const store = new Map();
  return { store, get: async (k) => (store.has(k) ? JSON.parse(store.get(k).value) : null), put: async (k, value, o) => store.set(k, { value, ...o }) };
};
const answer = (cc = 'public, max-age=60, s-maxage=90') =>
  new Response('{"items":[]}', { status: 200, headers: { 'content-type': 'application/json', 'cache-control': cc, 'access-control-allow-origin': '*' } });

test('history cache: kept for its s-maxage, then recomputed', async () => {
  const kv = fakeKv();
  const key = await historyKey('https://api.test/api/history?book=b&__origin=https%3A%2F%2Fb.test');
  assert.match(key, /^history:[0-9a-f]{64}$/);
  await toKv(kv, key, answer(), 1_000_000);
  assert.equal(kv.store.get(key).expirationTtl, 90);

  const hit = await fromKv(kv, key, 1_000_000 + 30_000);
  assert.equal(hit.left, 60);
  assert.equal(hit.response.status, 200);
  assert.equal(await hit.response.text(), '{"items":[]}');
  assert.equal(hit.response.headers.get('access-control-allow-origin'), '*');
  assert.equal(await fromKv(kv, key, 1_000_000 + 90_000), null, 'expired: recompute');
});

test('history cache: refusals, uncacheable answers and KV failures are never fatal', async () => {
  const kv = fakeKv();
  await toKv(kv, 'k', new Response('no', { status: 404, headers: { 'cache-control': 's-maxage=90' } }));
  await toKv(kv, 'k', answer('no-store'));
  assert.equal(kv.store.size, 0);
  const broken = { get: async () => { throw new Error('limit'); }, put: async () => { throw new Error('limit'); } };
  const logged = console.error;
  console.error = () => {};
  try {
    assert.equal(await fromKv(broken, 'k'), null);
    await toKv(broken, 'k', answer());
  } finally {
    console.error = logged;
  }
  assert.equal(await fromKv(null, 'k'), null);
});
