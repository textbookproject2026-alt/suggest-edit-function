/**
 * A pull request's CPU against main's, measured in the same job on the same runner
 * (worker.yml): cpu-bench.mjs run in turn on each (BENCH_OUT), several times, and per
 * endpoint the median of the runs' first-request figures (est. Cloudflare ms, each run
 * scaled by its own reference workload, so a runner that drifts moves both alike).
 * Exits 1 if any endpoint is more than LIMIT (default 15%) slower than on main.
 * Endpoints main doesn't have, or answers with another status (another code path:
 * main's 503 hand-off against this branch's work, say), are listed, not compared.
 *
 *   node scripts/cpu-compare.mjs base1.json,base2.json,… head1.json,head2.json,…
 */
import { appendFileSync, readFileSync } from 'node:fs';

const LIMIT = Number(process.env.CPU_COMPARE_LIMIT ?? 0.15);

export function compare(baseRuns, headRuns, limit = LIMIT) {
  const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const per = (runs) => {
    const m = new Map();
    for (const run of runs) for (const r of run) m.set(r.key, [...(m.get(r.key) ?? []), r.first]);
    return new Map([...m].map(([k, xs]) => [k, median(xs)]));
  };
  const status = (runs) => new Map(runs.flat().map((r) => [r.key, r.status]));
  const base = per(baseRuns);
  const [baseStatus, headStatus] = [status(baseRuns), status(headRuns)];
  return [...per(headRuns)].map(([key, head]) => {
    const was = baseStatus.get(key) === headStatus.get(key) ? base.get(key) : undefined;
    const change = was ? head / was - 1 : null;
    const skipped = !base.has(key) ? 'not on main'
      : was === undefined ? `answer differs: main ${baseStatus.get(key)}, PR ${headStatus.get(key)}` : null;
    return { key, base: was ?? null, head, change, slower: change !== null && change > limit, skipped };
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
  // The job summary, so a skipped endpoint (not compared at all) is seen without opening the log.
  const skipped = rows.filter((r) => r.skipped);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
      '### CPU against main',
      slower.length ? `**${slower.length} more than ${LIMIT * 100}% slower:** ${list}` : `None more than ${LIMIT * 100}% slower than main (${rows.length - skipped.length} compared).`,
      '',
      skipped.length ? `**Skipped, not compared (${skipped.length}):**\n\n| endpoint | why | PR ms |\n|---|---|---|\n${skipped.map((r) => `| \`${r.key}\` | ${r.skipped} | ${f(r.head)} |`).join('\n')}` : 'Skipped: none.',
      '',
    ].join('\n'));
  }
  if (skipped.length && process.env.GITHUB_ACTIONS) console.log(`::warning title=${skipped.length} endpoint(s) not compared with main::${skipped.map((r) => `${r.key} (${r.skipped})`).join('; ')}`);
  process.exitCode = slower.length ? 1 : 0;
}
