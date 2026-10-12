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

test('labels: no check first; a 404/422 makes them once and the write is tried again', async () => {
  const { withLabels } = await import('../lib/common.mjs');
  const saved = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => { calls.push(String(url)); return new Response('{}', { status: 422 }); };
  const warn = console.warn;
  console.warn = () => {};
  try {
    const defaults = { 'suggested-edit': {}, 'needs-triage': {} };
    let writes = 0;
    const ok = await withLabels('o/labels-test', 't', defaults, async () => new Response('{}', { status: ++writes === 1 ? 201 : 500 }));
    assert.equal(ok.status, 201);
    assert.equal(calls.length, 0, 'a write that worked costs nothing more');
    writes = 0;
    const again = await withLabels('o/labels-test', 't', defaults, async () => new Response('{}', { status: ++writes === 1 ? 422 : 201 }));
    assert.equal(again.status, 201);
    assert.equal(writes, 2);
    assert.equal(calls.length, 2, 'each label made once (422 = it was there already)');
  } finally {
    globalThis.fetch = saved;
    console.warn = warn;
  }
});

test('fieldsOf: top-level fields from GitHub-shaped answers, without a full parse', async () => {
  const { fieldsOf } = await import('../lib/common.mjs');
  const pr = '{"url":"https://api.github.com/repos/o/r/pulls/7","id":1,"node_id":"x","html_url":"https://github.com/o/r/pull/7","number":7,"title":"say \\"hi\\"","user":{"login":"a","html_url":"https://github.com/a"}}';
  assert.deepEqual(await fieldsOf(new Response(pr), ['html_url', 'number']), { html_url: 'https://github.com/o/r/pull/7', number: 7 });
  const tree = '{"sha":"aaa","url":"u","tree":[{"path":"p","sha":"bbb"}]}';
  assert.deepEqual(await fieldsOf(new Response(tree), ['sha']), { sha: 'aaa' });
  assert.deepEqual(await fieldsOf(new Response('{"other":1}'), ['sha']), { sha: undefined }, 'missing: the full parse says so');
});
