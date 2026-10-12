/**
 * CPU time and subrequests per route, cold and warm, from a `wrangler tail --format json`
 * capture (a stream of pretty-printed JSON objects). Each request's own log line
 * (worker/index.mjs) gives the route, cold=0|1 (the isolate's first request), load=0|1
 * (the route's first in the isolate, which loads its code), cache=hit and the
 * subrequest count.
 *
 *   node scripts/cpu-summary.mjs tail.jsonl [limitMs] [sent]
 *
 * Exits 1 when any route's p95 is at or over limitMs (default 8), and 2 when the tail
 * kept under 95% of `sent` (it samples when requests come too fast).
 */
import { readFileSync } from 'node:fs';

const [file, limitArg, sentArg] = process.argv.slice(2);
const sent = Number(sentArg ?? 0); // requests the load sent (measure-load's SENT_FILE), 0: unknown
const LIMIT = Number(limitArg ?? 8);

// Split the stream into top-level objects (tail pretty-prints each event).
function* objects(text) {
  let depth = 0, start = -1, inString = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') { if (depth++ === 0) start = i; }
    else if (c === '}' && --depth === 0) yield JSON.parse(text.slice(start, i + 1));
  }
}

const LINE = /^c4n-api (\S+) (\S+) (\d+) subrequests=(\d+) cold=([01])(?: cache=(\w+))?(?: load=([01]))?/;
const rows = [];
for (const e of objects(readFileSync(file, 'utf8'))) {
  const line = (e.logs ?? []).flatMap((l) => l.message ?? []).map(String).map((m) => LINE.exec(m)).find(Boolean);
  if (!line || typeof e.cpuTime !== 'number') continue;
  const [, method, path, status, sub, cold, hit, load] = line;
  // cold: the isolate's first request; load: the first of this route in the isolate.
  const temp = cold === '1' ? 'cold' : load === '1' ? 'load' : 'warm';
  rows.push({ key: `${method} ${path}${hit ? ` (${hit})` : ''}`, temp, cpu: e.cpuTime, sub: Number(sub), status, outcome: e.outcome });
}

const pct = (xs, p) => xs[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)];
let over = 0;
const out = [['route', 'temp', 'n', 'p50', 'p95', 'max', 'subreq max', 'outcomes']];
for (const key of [...new Set(rows.map((r) => r.key))].sort()) {
  for (const temp of ['cold', 'load', 'warm']) {
    const set = rows.filter((r) => r.key === key && r.temp === temp);
    if (!set.length) continue;
    const cpu = set.map((r) => r.cpu).sort((a, b) => a - b);
    const p95 = pct(cpu, 95);
    if (p95 >= LIMIT) over++;
    out.push([key, temp, set.length, pct(cpu, 50), p95 >= LIMIT ? `${p95} !` : p95, cpu.at(-1),
      Math.max(...set.map((r) => r.sub)), [...new Set(set.map((r) => r.outcome))].join(',')]);
  }
}
const widths = out[0].map((_, i) => Math.max(...out.map((r) => String(r[i]).length)));
for (const r of out) console.log(r.map((v, i) => String(v).padEnd(widths[i])).join('  '));
console.log(`${rows.length} requests; p95 limit ${LIMIT} ms: ${over ? `${over} route(s) at or over` : 'all under'}.`);
// A tail that sampled: the numbers describe whatever it kept, so the run is not usable.
if (sent && rows.length < sent * 0.95) {
  console.log(`::error::The tail captured ${rows.length} of the ${sent} requests sent (sampling): these numbers are not reliable.`);
  process.exit(2);
}
process.exit(over ? 1 : 0);
