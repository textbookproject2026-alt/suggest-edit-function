import test from 'node:test';
import assert from 'node:assert/strict';
import { platform } from '../lib/platform.mjs';
import { kept } from '../lib/kv-cache.mjs';

const fakeKv = (entries = {}) => {
  const store = new Map(Object.entries(entries).map(([k, v]) => [k, { value: JSON.stringify(v) }]));
  return { store, get: async (k) => (store.has(k) ? JSON.parse(store.get(k).value) : null), put: async (k, value, o) => store.set(k, { value, ...o }) };
};

test('kv cache: a fresh entry in KV (another isolate\'s) is used; an old one is worked out again and kept', async () => {
  const t = 1_000_000;
  platform.cache = fakeKv({ 'a': { at: t - 30_000, value: ['from kv'] }, 'b': { at: t - 95_000, value: ['stale'] } });
  try {
    let runs = 0;
    const compute = async () => { runs++; return ['fresh']; };
    assert.deepEqual(await kept('a', 90_000, compute, () => t), ['from kv']);
    assert.equal(runs, 0);
    assert.deepEqual(await kept('b', 90_000, compute, () => t), ['fresh']);
    assert.equal(runs, 1);
    assert.equal(platform.cache.store.get('b').expirationTtl, 90);
    assert.deepEqual(JSON.parse(platform.cache.store.get('b').value), { at: t, value: ['fresh'] });
    assert.deepEqual(await kept('b', 90_000, compute, () => t + 1000), ['fresh'], 'then from memory');
    assert.equal(runs, 1);
  } finally {
    platform.cache = null;
  }
});

test('kv cache: KV failing (the daily write limit included) is never fatal', async () => {
  platform.cache = { get: async () => { throw new Error('limit'); }, put: async () => { throw new Error('limit'); } };
  const logged = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(await kept('c', 90_000, async () => ['worked out']), ['worked out']);
  } finally {
    console.error = logged;
    platform.cache = null;
  }
  assert.deepEqual(await kept('d', 90_000, async () => ['no KV at all']), ['no KV at all']);
});
