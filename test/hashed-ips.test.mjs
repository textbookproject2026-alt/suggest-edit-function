// Rate limits key on HMAC-SHA256(IP, a random salt per UTC day): no IP is stored, the
// hourly limit still holds, and the same visitor starts afresh the next day.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeD1 } from './fake-d1.mjs';
import { platform } from '../lib/platform.mjs';
import { createRateLimiter, hashKey, testing } from '../lib/common.mjs';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const noon = Date.UTC(2026, 9, 14, 12);

test('D1: the hourly limit triggers, nothing stored names the IP, and the next day the visitor starts again', async () => {
  const db = fakeD1();
  platform.db = db;
  testing.resetSalt();
  try {
    const limited = createRateLimiter(3, HOUR, 'suggest');
    for (let i = 0; i < 3; i++) assert.equal(await limited('203.0.113.7', noon + i), 0);
    assert.ok(await limited('203.0.113.7', noon + 10), 'the fourth in the hour is refused');
    assert.equal(await limited('198.51.100.1', noon + 11), 0, 'another visitor is not');

    const rows = db.raw.prepare('SELECT k FROM hits').all();
    assert.equal(rows.length, 2);
    for (const { k } of rows) {
      assert.match(k, /^suggest:h:[0-9a-f]{64}$/);
      assert.ok(!k.includes('203.0.113'));
    }
    const today = await hashKey('203.0.113.7', noon);
    assert.equal(today, await hashKey(today, noon), 'a hashed key is kept as it is (the write queue)');

    // Next day, 00:00:01 UTC: a new salt, so a new key; the visitor isn't held back.
    const tomorrow = Date.UTC(2026, 9, 15, 0, 0, 1);
    assert.notEqual(await hashKey('203.0.113.7', tomorrow), today);
    assert.equal(await limited('203.0.113.7', tomorrow), 0);
    // The salt is shared through D1: another isolate (a fresh process here) gets the same key.
    testing.resetSalt();
    assert.equal(await hashKey('203.0.113.7', noon + DAY + 5), await hashKey('203.0.113.7', tomorrow));
    assert.equal(db.raw.prepare('SELECT count(*) AS n FROM salts').get().n, 2);
  } finally {
    platform.db = null;
    testing.resetSalt();
  }
});

test('in memory (Node): the same limit and the same daily reset', async () => {
  testing.resetSalt();
  const limited = createRateLimiter(2, HOUR, 'x');
  assert.equal(await limited('10.0.0.1', noon), 0);
  assert.equal(await limited('10.0.0.1', noon + 1), 0);
  assert.ok(await limited('10.0.0.1', noon + 2));
  // The in-memory window slides, so an hour later it frees anyway; the next day the key itself differs.
  assert.notEqual(await hashKey('10.0.0.1', noon + DAY), await hashKey('10.0.0.1', noon));
});
