/** api/author.js sends each /api/author-<name> URL to its handler, and nothing else. */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { default: router } = await import('../api/author.js');

const call = async (url) => {
  const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, getHeader(k) { return this.headers[k.toLowerCase()]; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; }, end(b) { this.body = b; } };
  await router({ method: 'OPTIONS', headers: { origin: 'https://evil.example' }, url, socket: {} }, res);
  return res.statusCode;
};

test('every author URL reaches a handler, by path or by the rewrite parameter', async () => {
  for (const name of ['act', 'history', 'import', 'people-change', 'people', 'read', 'send']) {
    assert.notEqual(await call(`/api/author-${name}`), 404, name);
    assert.notEqual(await call(`/api/author?route=${name}`), 404, name);
  }
});

test('unknown routes are 404', async () => {
  assert.equal(await call('/api/author-nope'), 404);
  assert.equal(await call('/api/author?route=constructor'), 404);
  assert.equal(await call('/api/author'), 404);
});
