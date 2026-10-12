/**
 * The split (batch 2d): the Worker forwards the routes that commit to Vercel, with the
 * reader's address signed, and serves the rest itself.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.FORWARD_SECRET = 's'.repeat(40);
const { forwardedIp } = await import('../lib/common.mjs');
const { default: worker, isForwarded, WRITE_BACKEND } = await import('../worker/index.mjs');

test('which routes go to Vercel: POSTs that commit, nothing else', () => {
  for (const p of ['/api/propose-edit', '/api/author-send', '/api/author-import', '/api/author-act', '/api/author-people-change']) {
    assert.equal(isForwarded('POST', p), true, p);
    assert.equal(isForwarded('OPTIONS', p), false, p);
  }
  assert.equal(isForwarded('GET', '/api/propose-edit'), false);
  assert.equal(isForwarded('GET', '/api/author-import'), false);
  for (const p of ['/api/suggest-edit', '/api/request-book', '/api/author-sync', '/api/github-auth', '/api/page-revision', '/api/history', '/api/author-read']) {
    assert.equal(isForwarded('POST', p), false, p);
  }
});

test('a forwarded write: same path, body, identity and origin; the reader\'s address signed; a client\'s own forwarding headers dropped', async () => {
  const saved = globalThis.fetch;
  let seen;
  globalThis.fetch = async (url, init) => {
    seen = { url: String(url), init };
    return new Response('{"prUrl":"x"}', { status: 201, headers: { 'content-type': 'application/json', 'access-control-allow-origin': 'https://b.example' } });
  };
  try {
    const body = '{"path":"a.md","edit":"x"}';
    const res = await worker.fetch(new Request('https://api.confused4now.org/api/propose-edit?x=1', {
      method: 'POST', body,
      headers: { 'content-type': 'application/json', origin: 'https://b.example', authorization: 'Bearer abc', 'cf-connecting-ip': '203.0.113.7', 'x-c4n-client-ip': '6.6.6.6', 'x-forwarded-for': '6.6.6.6' },
    }), { VERSION: { id: 'v1' } }, { waitUntil() {} });
    assert.equal(res.status, 201);
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://b.example');
    assert.equal(res.headers.get('x-served-by'), 'vercel');
    assert.equal(seen.url, `${WRITE_BACKEND}/api/propose-edit?x=1`);
    const h = seen.init.headers;
    assert.equal(h.get('authorization'), 'Bearer abc');
    assert.equal(h.get('origin'), 'https://b.example');
    assert.equal(h.get('x-forwarded-for'), null);
    assert.equal(h.get('cf-connecting-ip'), null);
    assert.equal(forwardedIp(Object.fromEntries(h)), '203.0.113.7');
    assert.equal(new TextDecoder().decode(seen.init.body), body);
  } finally {
    globalThis.fetch = saved;
  }
});

test('a read or a preflight is served here, not forwarded', async () => {
  const saved = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('{}'); };
  try {
    const res = await worker.fetch(new Request('https://api.confused4now.org/api/propose-edit', { method: 'OPTIONS', headers: { origin: 'https://nowhere.example', 'access-control-request-method': 'POST' } }), {}, { waitUntil() {} });
    assert.notEqual(res.headers.get('x-served-by'), 'vercel');
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = saved;
  }
});
