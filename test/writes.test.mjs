/**
 * Writes on the Worker (worker/writes.mjs): a key per write in D1, so a write sent
 * twice runs once; a write that failed inline is queued by the page, run by the
 * fallback (scripts/fallback.mjs) with the same handler, and its answer read from
 * /api/write-status; /api/health lists every failure and fallback.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeD1 } from './fake-d1.mjs';

const { write, writeStatus, health, isWrite, testing } = await import('../worker/writes.mjs');
const { runOne } = await import('../scripts/fallback.mjs');
const { serve } = await import('../worker/adapter.mjs');
const { platform } = await import('../lib/platform.mjs');
const { default: worker } = await import('../worker/index.mjs');

const ORIGIN = 'https://platform-test-book-2.pages.dev';
const KEY = 'k'.repeat(20);
const post = (query, body = '{"suggestion":"x"}') => {
  const url = new URL(`https://api.confused4now.org/api/suggest-edit?${query}`);
  return [new Request(url, { method: 'POST', body, headers: { origin: ORIGIN, 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' } }), url];
};
const events = async (db) => (await db.prepare('SELECT kind FROM write_events ORDER BY rowid').all()).results.map((r) => r.kind);

test('which routes take a key: the POSTs that write', () => {
  for (const p of ['/api/suggest-edit', '/api/propose-edit', '/api/request-book', '/api/author-send', '/api/author-import', '/api/author-act', '/api/author-people-change']) {
    assert.equal(isWrite('POST', p), true, p);
    assert.equal(isWrite('GET', p), false, p);
  }
  for (const p of ['/api/author-sync', '/api/github-auth', '/api/page-revision', '/api/history', '/api/author-read']) assert.equal(isWrite('POST', p), false, p);
});

test('a write sent twice at once runs once; both get the one answer', async () => {
  const db = fakeD1();
  let runs = 0;
  let release;
  const run = async () => {
    runs += 1;
    await new Promise((r) => (release = r));
    return new Response('{"issueUrl":"https://github.com/o/r/issues/7"}', { status: 201, headers: { 'content-type': 'application/json' } });
  };
  const [req1, url1] = post(`write_key=${KEY}`);
  const first = write(req1, '/api/suggest-edit', url1, db, run);
  await new Promise((r) => setImmediate(r));
  const [req2, url2] = post(`write_key=${KEY}`);
  const second = await write(req2, '/api/suggest-edit', url2, db, run);
  assert.equal(second.status, 202);
  assert.equal((await second.json()).userMessage, 'Saving… this can take up to a minute.');
  release();
  assert.equal((await first).status, 201);
  assert.equal(runs, 1);

  const [req3, url3] = post(`write_key=${KEY}`);
  const third = await write(req3, '/api/suggest-edit', url3, db, run);
  assert.equal(third.status, 201);
  assert.equal(third.headers.get('x-write'), 'replayed');
  assert.equal((await third.json()).issueUrl, 'https://github.com/o/r/issues/7');
  assert.equal(third.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(runs, 1);
  const status = await writeStatus(new URL(`https://x/api/write-status?write_key=${KEY}`), db);
  assert.equal(status.status, 201);
});

test('a refusal is not kept: the same write can be sent again', async () => {
  const db = fakeD1();
  let runs = 0;
  const run = async () => new Response('{"error":"bad"}', { status: ++runs === 1 ? 400 : 201 });
  const [a, ua] = post(`write_key=${KEY}`);
  assert.equal((await write(a, '/api/suggest-edit', ua, db, run)).status, 400);
  const [b, ub] = post(`write_key=${KEY}`);
  assert.equal((await write(b, '/api/suggest-edit', ub, db, run)).status, 201);
  assert.equal(runs, 2);
});

test('no key (a page from before keys): served as before, nothing kept', async () => {
  const db = fakeD1();
  const [r, u] = post('');
  assert.equal((await write(r, '/api/suggest-edit', u, db, async () => new Response('{}', { status: 201 }))).status, 201);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM writes').first()).n, 0);
});

test('a forced inline failure (CPU limit) completes through the fallback, once', async () => {
  const db = fakeD1();
  // The test book's &fail=cpu: Cloudflare stops the request mid-way; nothing after runs.
  const burn = testing.burn;
  testing.burn = () => {
    throw new Error('1102: Worker exceeded resource limits');
  };
  let inline = 0;
  try {
    const [r, u] = post(`write_key=${KEY}&fail=cpu`);
    await assert.rejects(write(r, '/api/suggest-edit', u, db, async () => (inline += 1, new Response('{}', { status: 201 }))));
  } finally {
    testing.burn = burn;
  }
  assert.equal(inline, 0);

  // The page couldn't read the 1102 (no CORS): it queues the same request and key.
  const [q, uq] = post(`write_key=${KEY}&fail=cpu&fallback=network`);
  const queued = await write(q, '/api/suggest-edit', uq, db, async () => assert.fail('not run inline'));
  assert.equal(queued.status, 202);
  assert.equal((await queued.json()).state, 'queued');
  // Sent twice: still one queued write.
  const [q2, uq2] = post(`write_key=${KEY}&fallback=network`);
  assert.equal((await write(q2, '/api/suggest-edit', uq2, db, async () => assert.fail('not run'))).status, 202);
  assert.equal((await writeStatus(new URL(`https://x/?write_key=${KEY}`), db)).status, 202);

  // The fallback: the same request, through the same route, without &fail.
  const claimed = await db.prepare(`UPDATE writes SET state = 'fallback', at = ?2 WHERE key = ?1 AND state = 'queued' RETURNING key, request`).bind(KEY, Date.now()).first();
  let seen;
  const route = (url) => (url.pathname === '/api/suggest-edit' ? async (req, res) => {
    seen = { url: req.url, ip: req.headers['x-forwarded-for'], origin: req.headers.origin, body: req.body };
    res.status(201).json({ issueUrl: 'https://github.com/o/r/issues/8' });
  } : null);
  const { event } = await import('../worker/writes.mjs');
  assert.equal(await runOne(db, claimed, { route, serve, platform, event }), 201);
  assert.equal(seen.url, `/api/suggest-edit?write_key=${KEY}`);
  assert.equal(seen.ip, '203.0.113.9');
  assert.equal(seen.origin, ORIGIN);
  assert.deepEqual(seen.body, { suggestion: 'x' });

  const done = await writeStatus(new URL(`https://x/?write_key=${KEY}`), db);
  assert.equal(done.status, 201);
  assert.equal((await done.json()).issueUrl, 'https://github.com/o/r/issues/8');
  // Sent again: the fallback's answer, nothing run.
  const [again, ua] = post(`write_key=${KEY}`);
  assert.equal((await write(again, '/api/suggest-edit', ua, db, async () => assert.fail('not run'))).status, 201);

  // The health check lists it. The dispatch fails here (no App in the tests): logged too.
  const kinds = await events(db);
  assert.deepEqual(kinds.filter((k) => k !== 'dispatch-failed'), ['inline-failed', 'queued', 'fallback-done']);
  const h = await (await health(db)).json();
  assert.equal(h.lastDay['fallback-done'], 1);
  assert.equal(h.lastDay['inline-failed'], 1);
  assert.equal(h.events.length, kinds.length);
  assert.equal(JSON.stringify(h).includes(KEY), false, 'no key in the public health check');
});

test('a 5xx inline is logged and can be queued; a fallback that fails too is recorded for the page', async () => {
  const db = fakeD1();
  const [r, u] = post(`write_key=${KEY}`);
  assert.equal((await write(r, '/api/suggest-edit', u, db, async () => new Response('{}', { status: 502 }))).status, 502);
  const [q, uq] = post(`write_key=${KEY}&fallback=502`);
  assert.equal((await write(q, '/api/suggest-edit', uq, db, async () => assert.fail())).status, 202);
  const claimed = await db.prepare(`UPDATE writes SET state = 'fallback' WHERE key = ?1 RETURNING key, request`).bind(KEY).first();
  const { event } = await import('../worker/writes.mjs');
  const route = () => async (_req, res) => res.status(502).json({ error: 'github', userMessage: 'GitHub could not be reached.' });
  assert.equal(await runOne(db, claimed, { route, serve, platform, event }), 502);
  const s = await writeStatus(new URL(`https://x/?write_key=${KEY}`), db);
  assert.equal(s.status, 502);
  const h = await health(db);
  assert.equal(h.status, 503);
  assert.equal((await h.json()).lastDay['fallback-failed'], 1);
});

test('a page that only timed out waits for a first try still running', async () => {
  const db = fakeD1();
  await db.prepare(`INSERT INTO writes (key, route, state, at) VALUES (?1, '/api/suggest-edit', 'running', ?2)`).bind(KEY, Date.now()).run();
  const [q, uq] = post(`write_key=${KEY}&fallback=timeout`);
  const res = await write(q, '/api/suggest-edit', uq, db, async () => assert.fail());
  assert.equal((await res.json()).state, 'running');
  assert.equal((await db.prepare('SELECT state FROM writes WHERE key = ?1').bind(KEY).first()).state, 'running');
});

test('an author write is queued only with the author site\'s assertion; refused without one', async () => {
  const db = fakeD1();
  const url = new URL(`https://api.confused4now.org/api/author-send?write_key=${KEY}&fallback=503`);
  const req = new Request(url, { method: 'POST', body: '{"book":"platform-test-book"}', headers: { origin: 'https://author.confused4now.org', 'content-type': 'application/json' } });
  const res = await write(req, '/api/author-send', url, db, async () => assert.fail());
  assert.equal(res.status, 401);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM writes').first()).n, 0);
});

test('the Worker: /api/health and /api/write-status; nothing is forwarded to Vercel any more', async () => {
  const db = fakeD1();
  const env = { DB: db, VERSION: { id: 'v1' } };
  const h = await worker.fetch(new Request('https://api.confused4now.org/api/health'), env, { waitUntil() {} });
  assert.equal(h.status, 200);
  assert.equal((await h.json()).ok, true);
  const s = await worker.fetch(new Request(`https://api.confused4now.org/api/write-status?write_key=${KEY}`), env, { waitUntil() {} });
  assert.equal(s.status, 404);
  const saved = globalThis.fetch;
  const hosts = [];
  globalThis.fetch = async (u, init) => {
    hosts.push(new URL(String(u)).host);
    return saved(u, init);
  };
  try {
    const res = await worker.fetch(new Request('https://api.confused4now.org/api/propose-edit', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }), env, { waitUntil() {} });
    assert.equal(res.status, 403); // no Origin: refused by the handler itself, here
    assert.equal(res.headers.get('x-served-by'), null);
    assert.equal(hosts.includes('suggest-edit-function.vercel.app'), false);
  } finally {
    globalThis.fetch = saved;
  }
});

test('the five-minute backstop starts the fallback only for writes left waiting', async () => {
  const { backstop } = await import('../worker/writes.mjs');
  const db = fakeD1();
  const starts = [];
  const start = async (key) => { starts.push(key); };
  const at = (ago) => Date.now() - ago;
  await db.prepare(`INSERT INTO writes (key, route, state, at) VALUES ('fresh-queued-000001', '/api/suggest-edit', 'queued', ?1)`).bind(at(5_000)).run();
  await db.prepare(`INSERT INTO writes (key, route, state, at) VALUES ('running-fallback-01', '/api/suggest-edit', 'fallback', ?1)`).bind(at(60_000)).run();
  assert.equal(await backstop(db, start), 0, 'just queued (its own dispatch is on the way) or a fallback still running');
  assert.deepEqual(starts, []);
  await db.prepare(`INSERT INTO writes (key, route, state, at) VALUES ('left-queued-0000001', '/api/suggest-edit', 'queued', ?1)`).bind(at(120_000)).run();
  await db.prepare(`INSERT INTO writes (key, route, state, at) VALUES ('dead-fallback-00001', '/api/suggest-edit', 'fallback', ?1)`).bind(at(11 * 60_000)).run();
  assert.equal(await backstop(db, start), 2);
  assert.deepEqual(starts, [''], 'one run, no key: it takes every waiting write');
  // A start that fails is logged, and health turns 503 while it is recent.
  await backstop(db, async () => { throw new Error('the app isn\'t installed'); });
  assert.equal((await health(db)).status, 503);
});

test('health: a failed start whose write has since drained is history after 15 minutes', async () => {
  const db = fakeD1();
  const old = Date.now() - 20 * 60_000;
  for (const kind of ['inline-failed', 'queued', 'dispatch-failed', 'fallback-done']) {
    await db.prepare('INSERT INTO write_events (at, kind, route, detail) VALUES (?1, ?2, ?3, ?4)').bind(old, kind, '/api/suggest-edit', '').run();
  }
  const h = await health(db);
  assert.equal(h.status, 200);
  assert.equal((await h.json()).lastDay['dispatch-failed'], 1, 'still listed');
  await db.prepare('INSERT INTO write_events (at, kind, route, detail) VALUES (?1, ?2, ?3, ?4)').bind(Date.now(), 'dispatch-failed', 'backstop', 'x').run();
  assert.equal((await health(db)).status, 503);
});
