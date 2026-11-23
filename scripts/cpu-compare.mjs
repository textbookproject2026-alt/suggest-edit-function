/**
 * A pull request's CPU against main's, measured in the same job on the same runner
 * (worker.yml): cpu-bench.mjs run in turn on each (BENCH_OUT), several times, and per
 * endpoint the median of the runs' first-request figures (est. Cloudflare ms, each run
 * scaled by its own reference workload, so a runner that drifts moves both alike).
 * Exits 1 if any endpoint is more than LIMIT (default 15%) slower than on main.
 * Endpoints main doesn't have are listed, not compared.
 *
 *   node scripts/cpu-compare.mjs base1.json,base2.json,… head1.json,head2.json,…
 */
import { readFileSync } from 'node:fs';

const LIMIT = Number(process.env.CPU_COMPARE_LIMIT ?? 0.15);

export function compare(baseRuns, headRuns, limit = LIMIT) {
  const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const per = (runs) => {
    const m = new Map();
    for (const run of runs) for (const r of run) m.set(r.key, [...(m.get(r.key) ?? []), r.first]);
    return new Map([...m].map(([k, xs]) => [k, median(xs)]));
  };
  const base = per(baseRuns);
  return [...per(headRuns)].map(([key, head]) => {
    const was = base.get(key);
    const change = was ? head / was - 1 : null;
    return { key, base: was ?? null, head, change, slower: change !== null && change > limit };
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const load = (list) => list.split(',').map((f) => JSON.parse(readFileSync(f, 'utf8')));
  const rows = compare(load(process.argv[2]), load(process.argv[3]));
  const f = (x) => (x === null ? '-' : x.toFixed(2));
  console.log(`${'endpoint'.padEnd(72)}${'main'.padStart(8)}${'PR'.padStart(8)}  change (first request, est. Cloudflare ms, median of runs)`);
  for (const r of rows) {
    console.log(`${r.key.padEnd(72)}${f(r.base).padStart(8)}${f(r.head).padStart(8)}  ${r.change === null ? 'new' : `${r.change >= 0 ? '+' : ''}${(r.change * 100).toFixed(0)}%`}${r.slower ? '  SLOWER' : ''}`);
  }
  const slower = rows.filter((r) => r.slower);
  const list = slower.map((r) => `${r.key} ${f(r.base)} -> ${f(r.head)} (+${(r.change * 100).toFixed(0)}%)`).join('; ');
  console.log(slower.length ? `${slower.length} more than ${LIMIT * 100}% slower than main: ${list}` : `None more than ${LIMIT * 100}% slower than main.`);
  if (slower.length && process.env.GITHUB_ACTIONS) console.log(`::error title=CPU more than ${LIMIT * 100}% slower than main::${list}`);
  process.exitCode = slower.length ? 1 : 0;
}
