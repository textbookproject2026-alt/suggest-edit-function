import test from 'node:test';
import assert from 'node:assert/strict';
import { compare } from '../scripts/cpu-compare.mjs';

const run = (o) => Object.entries(o).map(([key, first]) => ({ key, first, warm: 1 }));

test('cpu-compare: median of the runs per endpoint, more than 15% slower is flagged', () => {
  const base = [run({ a: 4, b: 5 }), run({ a: 9, b: 5 }), run({ a: 4.2, b: 5 })];
  const head = [run({ a: 4.8, b: 5.7 }), run({ a: 4.5, b: 6 }), run({ a: 1, b: 5.8, c: 3 })];
  const rows = Object.fromEntries(compare(base, head).map((r) => [r.key, r]));
  assert.equal(rows.a.base, 4.2); // one noisy run (9) doesn't move the median
  assert.equal(rows.a.head, 4.5);
  assert.equal(rows.a.slower, false); // +7%
  assert.equal(rows.b.slower, true); // 5 -> 5.8, +16%
  assert.equal(rows.c.base, null); // new endpoint: listed, not compared
  assert.equal(rows.c.slower, false);
});

test('cpu-compare: an endpoint main answers with another status is listed, not compared', () => {
  const base = [[{ key: 'accept', status: 503, first: 1, warm: 1 }, { key: 'read', status: 200, first: 5, warm: 1 }]];
  const head = [[{ key: 'accept', status: 200, first: 12, warm: 2 }, { key: 'read', status: 200, first: 6, warm: 1 }]];
  const rows = Object.fromEntries(compare(base, head).map((r) => [r.key, r]));
  assert.equal(rows.accept.base, null);
  assert.equal(rows.accept.slower, false);
  assert.equal(rows.read.slower, true); // 5 -> 6, +20%, same answer: compared
});

test('cpu-compare: skipped endpoints are named in the job summary, with why', async () => {
  const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(`${tmpdir()}/cpu-compare-`);
  const file = (name, rows) => { writeFileSync(`${dir}/${name}`, JSON.stringify(rows)); return `${dir}/${name}`; };
  const base = file('base.json', [{ key: 'accept', status: 503, first: 1 }, { key: 'read', status: 200, first: 5 }]);
  const head = file('head.json', [{ key: 'accept', status: 200, first: 12 }, { key: 'read', status: 200, first: 5 }, { key: 'new', status: 200, first: 2 }]);
  const summary = `${dir}/summary.md`;
  execFileSync(process.execPath, ['scripts/cpu-compare.mjs', base, head], { env: { ...process.env, GITHUB_STEP_SUMMARY: summary } });
  const md = readFileSync(summary, 'utf8');
  assert.match(md, /Skipped, not compared \(2\)/);
  assert.match(md, /\| `accept` \| answer differs: main 503, PR 200 \| 12\.00 \|/);
  assert.match(md, /\| `new` \| not on main \|/);
  assert.match(md, /None more than 15% slower than main \(1 compared\)/);
});
