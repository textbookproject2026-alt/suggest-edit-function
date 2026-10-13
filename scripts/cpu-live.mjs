/**
 * c4n-api's live CPU time per endpoint, from Cloudflare (for cpu-live.yml): every fetch
 * invocation's cpuTimeMs and URL from Workers Observability, an hour at a time, labelled
 * as worker/index.mjs labels its log line (`/api/history[declined]`…), then P50/P95/P99/max
 * per label. Also the whole Worker's daily quantiles from the analytics API.
 * Needs CLOUDFLARE_API_TOKEN. DAYS (default 7) is how far back; Observability keeps what
 * the plan keeps, and the first event found is printed. SPLIT (an ISO time, e.g. a
 * deploy's) prints the table again for what came after it.
 *   node scripts/cpu-live.mjs [flagMs]
 */
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const DAYS = Number(process.env.DAYS ?? 7);
const FLAG = Number(process.argv[2] ?? 7);
const CF = 'https://api.cloudflare.com/client/v4';
const api = async (path, body) => {
  for (let i = 0; ; i++) {
    const res = await fetch(`${CF}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: body && JSON.stringify(body),
    });
    if (res.status === 429 && i < 5) { await new Promise((r) => setTimeout(r, 2000 * (i + 1))); continue; }
    return res.json();
  }
};

/** As worker/index.mjs's fetch(): which kind of request. */
export function label(url) {
  const u = new URL(url);
  const sp = u.searchParams;
  const kind = ['what', 'mode', 'action', 'shas', 'base', 'sha', 'declined', 'path', 'id'].find((k) => sp.has(k));
  const value = ['what', 'mode', 'action'].includes(kind) ? sp.get(kind) : kind;
  return kind ? `${u.pathname}[${/^[a-z-]{1,24}$/.test(value) ? value : 'other'}]` : u.pathname;
}

// The Worker's routes (worker/index.mjs); anything else is a scanner or a measurement.
const ROUTE = /^\/api\/(author-[a-z-]+|history|page-revision|propose-edit|suggest-edit|request-book|github-auth|health|write-status)(\[|$)/;
const pct = (xs, p) => xs[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)];

async function main() {
  const zone = await api('/zones?name=confused4now.org');
  const account = zone.result[0].account.id;
  const to = Date.now();
  const from = to - DAYS * 86_400_000;

  console.log(`== the whole Worker, per day (analytics: workersInvocationsAdaptive), cpu ms`);
  const gq = await api('/graphql', {
    query: `query($a: String!, $from: Time!, $to: Time!) { viewer { accounts(filter: {accountTag: $a}) {
      workersInvocationsAdaptive(limit: 100, filter: {scriptName: "c4n-api", datetime_geq: $from, datetime_leq: $to}, orderBy: [date_ASC]) {
        dimensions { date } sum { requests errors } quantiles { cpuTimeP50 cpuTimeP90 cpuTimeP99 cpuTimeP999 } } } } }`,
    variables: { a: account, from: new Date(from).toISOString(), to: new Date(to).toISOString() },
  });
  if (gq.errors) console.log(`analytics: ${JSON.stringify(gq.errors)}`);
  for (const r of gq.data?.viewer.accounts[0].workersInvocationsAdaptive ?? []) {
    const q = r.quantiles;
    console.log(`${r.dimensions.date}  requests=${r.sum.requests} errors=${r.sum.errors}  p50=${(q.cpuTimeP50 / 1000).toFixed(1)} p90=${(q.cpuTimeP90 / 1000).toFixed(1)} p99=${(q.cpuTimeP99 / 1000).toFixed(1)} p99.9=${(q.cpuTimeP999 / 1000).toFixed(1)}`);
  }

  const byLabel = new Map();
  let first = Infinity;
  let n = 0;
  async function window(a, b) {
    const r = await api(`/accounts/${account}/workers/observability/telemetry/query`, {
      queryId: 'cpu-live', view: 'events', limit: 2000, timeframe: { from: a, to: b },
      parameters: { datasets: ['cloudflare-workers'], filterCombination: 'and', filters: [
        { key: '$metadata.service', type: 'string', operation: 'eq', value: 'c4n-api' },
        { key: '$workers.eventType', type: 'string', operation: 'eq', value: 'fetch' },
      ] },
    });
    if (r.errors?.length) throw new Error(JSON.stringify(r.errors));
    const events = r.result?.events?.events ?? [];
    if (events.length >= 2000 && b - a > 60_000) {
      const mid = Math.floor((a + b) / 2);
      await window(a, mid);
      await window(mid, b);
      return;
    }
    for (const e of events) {
      const w = e.$workers ?? {};
      const url = w.event?.request?.url;
      if (typeof w.cpuTimeMs !== 'number' || !url) continue; // a log line, not the invocation
      const l = label(url);
      if (!byLabel.has(l)) byLabel.set(l, []);
      byLabel.get(l).push([e.timestamp, w.cpuTimeMs]);
      first = Math.min(first, e.timestamp);
      n++;
    }
  }
  for (let a = from; a < to; a += 3_600_000) await window(a, Math.min(a + 3_600_000, to));

  const table = (since, title) => {
    console.log(`\n== per endpoint (Observability), ${title}, cpu ms`);
    console.log(`${'endpoint'.padEnd(34)}${'n'.padStart(7)}${'p50'.padStart(6)}${'p95'.padStart(6)}${'p99'.padStart(6)}${'max'.padStart(6)}`);
    const rows = [...byLabel]
      .filter(([l]) => ROUTE.test(l))
      .map(([l, xs]) => [l, xs.filter(([t]) => t >= since).map(([, ms]) => ms).sort((x, y) => x - y)])
      .filter(([, xs]) => xs.length)
      .sort((x, y) => pct(y[1], 99) - pct(x[1], 99));
    for (const [l, xs] of rows) {
      const over = pct(xs, 99) > FLAG ? `  P99 over ${FLAG}` : '';
      console.log(`${l.padEnd(34)}${String(xs.length).padStart(7)}${String(pct(xs, 50)).padStart(6)}${String(pct(xs, 95)).padStart(6)}${String(pct(xs, 99)).padStart(6)}${String(xs.at(-1)).padStart(6)}${over}`);
    }
  };
  table(0, `${n} invocations from ${Number.isFinite(first) ? new Date(first).toISOString() : '-'} to ${new Date(to).toISOString()}`);
  if (process.env.SPLIT) table(Date.parse(process.env.SPLIT), `since ${process.env.SPLIT}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
