/**
 * CPU per endpoint on the Worker's own code path, from recorded GitHub answers: every
 * request goes through worker/index.mjs's fetch(), as on Cloudflare, with GitHub, the
 * author site's assertion read-back, KV, D1 and the Cache API answered from memory, so
 * the time measured is the Worker's own work (parsing, shaping, signing), not waiting.
 *
 *   node scripts/cpu-bench.mjs record [slug…]   ask GitHub (gh's token; GETs and read-only
 *                                               GraphQL only, writes answered canned) and
 *                                               write fixtures/cpu/<slug>.json
 *   node scripts/cpu-bench.mjs [budgetMs]       replay them; exit 1 if any endpoint is over
 *
 * Per endpoint: `first` is its first request in a fresh process (the route's code is
 * compiled on the way, and nothing is kept: KV and memory are empty, as when the refresh
 * is stale), `warm` the median of the next RUNS. Both must be under the budget (default
 * 7 ms, the free plan's 10 ms less headroom). Node and workerd run the same V8; this
 * machine is not Cloudflare's, so the numbers are compared with live tails
 * (scripts/cpu-summary.mjs) in docs, not assumed equal.
 */
import { generateKeyPairSync, randomBytes, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const [mode, ...rest] = process.argv.slice(2);
const RECORD = mode === 'record' || mode === '--record-one';
const DISCOVER = mode === 'record';
const BUDGET = Number(RECORD || mode === '--one' ? 7 : mode ?? 7);
const RUNS = 15;
const COLD = Number(process.env.BENCH_COLD ?? 3);
const DIR = new URL('../fixtures/cpu/', import.meta.url);
const SLUGS = mode === 'record' && rest.length ? rest : ['platform-test-book', 'ontology-for-social-research-a-criti'];

// --- the environment the handlers read at import ------------------------------------
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.GITHUB_APP_ID = '1';
process.env.GITHUB_APP_PRIVATE_KEY = Buffer.from(privateKey.export({ type: 'pkcs1', format: 'pem' })).toString('base64');
process.env.IDENTITY_SECRET = randomBytes(32).toString('hex');
delete process.env.BOT_TOKEN;
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

const { default: BUNDLE } = await import('../registry/bundled.mjs');

// --- GitHub and the author site, from fixtures (or recorded) ---------------------------
const GH = 'https://api.github.com';
const ghToken = RECORD ? execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim() : '';
let tape = {}; // key -> { status, body, link }
const keyOf = (method, url, body) => `${method} ${url}${method === 'POST' && url.endsWith('/graphql') ? ` ${createHash('sha256').update(body ?? '').digest('hex').slice(0, 16)}` : ''}`;
const json = (status, value, headers = {}) => new Response(typeof value === 'string' ? value : JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
// Every book's repository and this one's: what the App's installation tokens are granted.
const BUNDLE_REPOS = () => [...BUNDLE.registry.books.map((b) => b.content.repo), 'textbookproject2026-alt/suggest-edit-function', 'textbookproject2026-alt/book-requests'];
let member = { id: 'ab738d332e', name: 'Alec Gordon', github: null };
let memberBook = '';

const canned = (method, url, body) => {
  const path = url.replace(GH, '').split('?')[0];
  if (/\/app\/installations\/\d+\/access_tokens$/.test(path)) {
    const name = JSON.parse(body ?? '{}').repositories?.[0];
    const repositories = BUNDLE_REPOS().filter((r) => r.split('/')[1] === name).map((full_name) => ({ full_name }));
    return json(201, { token: 'ghs_bench', expires_at: new Date(Date.now() + 3600_000).toISOString(), repositories });
  }
  if (/\/repos\/[^/]+\/[^/]+\/installation$/.test(path)) return json(200, { id: 1 });
  if (/\/issues\/\d+\/comments$/.test(path) && method === 'POST') return json(201, { id: 1, html_url: `${url}#c1`, body: '', user: { login: 'textbook-suggest-edit[bot]', type: 'Bot' }, created_at: new Date().toISOString() });
  if (/\/issues$/.test(path) && method === 'POST') return json(201, { number: 999, html_url: 'https://github.com/x/y/issues/999' });
  if (/\/lock$/.test(path)) return new Response(null, { status: 204 });
  if (/\/issues\/\d+$/.test(path) && method === 'PATCH') return json(200, { number: 1, state: 'closed' });
  if (/\/labels/.test(path)) return json(200, [{ name: 'x' }]);
  if (/\/dispatches$/.test(path)) return new Response(null, { status: 204 });
  return null;
};

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const body = typeof init.body === 'string' ? init.body : undefined;
  if (url === 'https://author.confused4now.org/api/internal/assertion') {
    return json(200, { member, book: memberBook, books: [memberBook] });
  }
  if (!url.startsWith(GH) && !url.startsWith('https://raw.githubusercontent.com/')) throw new Error(`bench: unexpected fetch ${method} ${url}`);
  const graphql = method === 'POST' && url === `${GH}/graphql`;
  if (!(method === 'GET' || graphql)) {
    const c = canned(method, url, body);
    if (c) return c;
  }
  if (method === 'POST' && /access_tokens$/.test(url)) return canned(method, url, body);
  if (method === 'GET' && /\/installation$/.test(url)) return canned(method, url);
  const key = keyOf(method, url, body);
  if (!RECORD) {
    const t = tape[key];
    if (!t) throw new Error(`bench: not recorded: ${key}`);
    if (process.env.BENCH_TRACE) console.error(`TRACE ${t.body.length} ${key.slice(0, 140)}`);
    return new Response(t.body, { status: t.status, headers: { 'content-type': t.type ?? 'application/json', ...(t.link ? { link: t.link } : {}) } });
  }
  if (graphql && /^\s*mutation/i.test(JSON.parse(body ?? '{}').query ?? '')) throw new Error('bench: a GraphQL mutation while recording');
  if (!(method === 'GET' || graphql)) throw new Error(`bench: refusing to record a write: ${method} ${url}`);
  const headers = new Headers(init.headers ?? {});
  headers.set('authorization', `Bearer ${ghToken}`);
  const res = await realFetch(url, { method, headers, body });
  // Email addresses out (commit authors, signature payloads): the fixtures are
  // committed, and none of the shaping reads them.
  const text = (await res.text()).replace(/[A-Za-z0-9._%+-]+@(?!users\.noreply\.)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, 'someone@example.invalid');
  tape[key] = { status: res.status, body: text, type: res.headers.get('content-type'), link: res.headers.get('link') ?? undefined };
  return new Response(text, { status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? 'application/json', ...(res.headers.get('link') ? { link: res.headers.get('link') } : {}) } });
};

// --- bindings ---------------------------------------------------------------------------
const { fakeD1 } = await import('../test/fake-d1.mjs');
const kv = () => {
  const m = new Map();
  return {
    get: async (k, type) => (m.has(k) ? (type === 'json' ? JSON.parse(m.get(k)) : m.get(k)) : null),
    put: async (k, v) => void m.set(k, String(v)),
    delete: async (k) => void m.delete(k),
    clear: () => m.clear(),
    dump: () => Object.fromEntries(m),
    load: (o) => { for (const [k, v] of Object.entries(o)) m.set(k, v); },
  };
};
const env = { TOKENS: kv(), CACHE: kv(), DB: fakeD1(), VERSION: { id: 'bench' } };
// Installation tokens live in KV for their hour on Cloudflare, so an isolate's first
// request finds one: each measured process starts with those a priming run kept.
const TOKENS_FILE = new URL('../.bench-tokens.json', import.meta.url);
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
const { default: worker } = await import('../worker/index.mjs');

// --- the requests: what the book's pages, the author site and the portal send -----------
async function cases(slug) {
  const book = BUNDLE.registry.books.find((b) => b.slug === slug);
  const origin = `https://${book.site.domain}`;
  const meta = DISCOVER ? await discover(book) : JSON.parse(readFileSync(new URL(`${slug}.meta.json`, DIR), 'utf8'));
  if (DISCOVER) writeFileSync(new URL(`${slug}.meta.json`, DIR), `${JSON.stringify(meta, null, 2)}\n`);
  const pub = (name, path) => ({ name, method: 'GET', url: path, headers: { Origin: origin } });
  const authorGet = (what, extra = {}) => ({ name: `author-read[${what}]`, member: true, method: 'GET', url: `/api/author-read?${new URLSearchParams({ what, book: slug, ...extra })}` });
  const out = [
    pub('history', `/api/history?book=${slug}`),
    pub('history[declined]', `/api/history?book=${slug}&declined=1`),
    pub('history[page]', `/api/history?book=${slug}&path=${encodeURIComponent(meta.page)}`),
    pub('propose GET', `/api/propose-edit?path=${encodeURIComponent(meta.page)}`),
    { name: 'health', method: 'GET', url: '/api/health' },
    authorGet('tree'),
    authorGet('file', { path: meta.page, ref: meta.draftsHead }),
    authorGet('drafts'),
    authorGet('suggestions'),
    authorGet('changes'),
    authorGet('declined'),
    authorGet('publish'),
    { name: 'author-history', member: true, method: 'GET', url: `/api/author-history?${new URLSearchParams({ book: slug })}` },
    { name: 'suggest POST', method: 'POST', url: '/api/suggest-edit', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Bench', path: meta.page, suggestion: 'A measured suggestion, never sent.' }), write: true },
  ];
  if (meta.shas.length > 1) {
    out.push(pub('page-revision[shas]', `/api/page-revision?book=${slug}&shas=${meta.shas.slice(0, 2).join(',')}`));
    out.push(pub('page-revision[compare]', `/api/page-revision?book=${slug}&sha=${meta.shas[0]}&path=${encodeURIComponent(meta.page)}&base=${meta.shas[1]}`));
  }
  if (meta.suggestion) {
    out.push({ name: 'author-act[suggestion-decline]', member: true, method: 'POST', url: '/api/author-act', body: JSON.stringify({ book: slug, action: 'suggestion-decline', number: meta.suggestion, reason: 'A measured decline, never sent.' }), write: true });
  }
  if (meta.declined) {
    out.push({ name: 'author-act[comment-add]', member: true, method: 'POST', url: '/api/author-act', body: JSON.stringify({ book: slug, action: 'comment-add', number: meta.declined, text: 'A measured comment, never sent.' }), write: true });
  }
  return out;
}

/** What the cases need from the book: a page, two of its commits, an open suggestion, a declined item. */
async function discover(book) {
  const gh = (p) => JSON.parse(execFileSync('gh', ['api', p], { encoding: 'utf8', maxBuffer: 64 << 20 }));
  const repo = book.content.repo;
  const tree = gh(`/repos/${repo}/git/trees/${book.content.live_branch}?recursive=1`).tree.filter((t) => /^chapters\/.*\.md$/.test(t.path));
  const page = (tree.find((t) => /chapter-01\.md$/.test(t.path)) ?? tree[0]).path;
  const shas = gh(`/repos/${repo}/commits?sha=${book.content.live_branch}&path=${encodeURIComponent(page)}&per_page=2`).map((c) => c.sha);
  const suggestion = gh(`/repos/${repo}/issues?labels=suggested-edit&state=open&per_page=1`)[0]?.number ?? null;
  const declined = gh(`/repos/${repo}/issues?state=closed&per_page=30`).find((i) => i.state_reason === 'not_planned')?.number ?? null;
  const draftsHead = gh(`/repos/${repo}/branches/${book.content.drafts_branch}`).commit.sha;
  return { page, shas, suggestion, declined, draftsHead };
}

async function send(c) {
  const url = `https://api.confused4now.org${c.url}`;
  const headers = { ...(c.headers ?? {}) };
  if (c.member) {
    const u = new URL(url);
    memberBook = c.method === 'GET' ? u.searchParams.get('book') : JSON.parse(c.body).book;
    headers.Authorization = `Member ${'a'.repeat(30)}`;
    headers.Origin = 'https://author.confused4now.org';
    if (c.body) headers['Content-Type'] = 'application/json';
  }
  if (c.write) headers['cf-connecting-ip'] = `203.0.113.${1 + Math.floor(Math.random() * 200)}`;
  const req = new Request(c.write ? `${url}${url.includes('?') ? '&' : '?'}write_key=${randomBytes(12).toString('base64url')}` : url, { method: c.method, headers, body: c.body });
  const t0 = performance.now();
  const res = await worker.fetch(req, env, ctx);
  const ms = performance.now() - t0;
  await res.arrayBuffer();
  return { ms, status: res.status };
}

// --- run --------------------------------------------------------------------------------
// Each endpoint in its own process (`--one <slug> <n>`): its first request is then a
// fresh isolate's, as most are on Cloudflare for a quiet site, with every function it
// runs compiled on the way. The module graph is loaded before the clock starts, as
// Cloudflare evaluates it before the first request and doesn't bill it.
const pad = (s, n) => String(s).padEnd(n);
async function one(slug, n) {
  const file = new URL(`${slug}.json`, DIR);
  tape = JSON.parse(readFileSync(file, 'utf8'));
  const c = (await cases(slug))[n];
  if (!c) return null;
  // BENCH_PROFILE=<file>: a CPU profile of the first request alone.
  const session = process.env.BENCH_PROFILE ? new (await import('node:inspector')).Session() : null;
  const post = (m, p) => new Promise((ok, no) => session.post(m, p ?? {}, (e, r) => (e ? no(e) : ok(r))));
  if (session) {
    session.connect();
    await post('Profiler.enable');
    await post('Profiler.setSamplingInterval', { interval: 50 });
    await post('Profiler.start');
  }
  const first = await send(c);
  if (session) writeFileSync(process.env.BENCH_PROFILE, JSON.stringify((await post('Profiler.stop')).profile));
  const warm = [];
  for (let i = 0; i < RUNS; i++) warm.push((await send(c)).ms);
  warm.sort((a, b) => a - b);
  return { slug, name: c.name, status: first.status, first: first.ms, warm: warm[Math.floor(warm.length / 2)] };
}

/** Node's own lazily loaded built-ins (undici's Request/Response, WebCrypto, streams),
 *  which workerd has ready in every isolate: used once before the clock, none of the
 *  Worker's code. */
async function warmPlatform() {
  const r = new Request('https://example.invalid/x?y=1', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' });
  await r.clone().json();
  await r.text();
  const res = new Response(JSON.stringify({ a: [1] }), { status: 201, headers: new Headers({ link: '<x>; rel="next"' }) });
  await res.clone().json();
  await res.arrayBuffer();
  await new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('x')); c.close(); } })).text();
  const k = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  await crypto.subtle.sign('HMAC', k, new TextEncoder().encode('x'));
  await crypto.subtle.digest('SHA-256', new TextEncoder().encode('x'));
  const { privateKey: rsa } = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign']);
  await crypto.subtle.sign('RSASSA-PKCS1-v1_5', await crypto.subtle.importKey('pkcs8', await crypto.subtle.exportKey('pkcs8', rsa), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']), new Uint8Array(8));
  AbortSignal.timeout(1000);
  new (await import('node:async_hooks')).AsyncLocalStorage().run({}, () => 0);
  btoa('x'); atob('eA==');
}

if (mode === '--prime') {
  for (const slug of SLUGS) {
    tape = JSON.parse(readFileSync(new URL(`${slug}.json`, DIR), 'utf8'));
    for (const c of await cases(slug)) await send(c);
  }
  writeFileSync(TOKENS_FILE, JSON.stringify(env.TOKENS.dump()));
} else if (mode === '--one') {
  if (existsSync(TOKENS_FILE)) env.TOKENS.load(JSON.parse(readFileSync(TOKENS_FILE, 'utf8')));
  await warmPlatform();
  console.log(`BENCH ${JSON.stringify(await one(rest[0], Number(rest[1])))}`);
} else if (mode === '--record-one') {
  // One case, recorded in a fresh process (nothing kept in memory from another case),
  // its answers added to the book's tape.
  const [slug, n] = [rest[0], Number(rest[1])];
  const file = new URL(`${slug}.json`, DIR);
  const c = (await cases(slug))[n];
  if (c) {
    const r = await send(c);
    const before = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    writeFileSync(file, `${JSON.stringify({ ...before, ...tape })}\n`);
    console.error(`recorded ${slug} ${c.name}: ${r.status}`);
  }
  console.log(`BENCH ${JSON.stringify(c ? { name: c.name } : null)}`);
} else if (RECORD) {
  mkdirSync(DIR, { recursive: true });
  const { execFileSync: run } = await import('node:child_process');
  for (const slug of SLUGS) {
    writeFileSync(new URL(`${slug}.json`, DIR), '{}\n');
    await cases(slug); // writes the .meta.json the children read
    for (let n = 0; ; n++) {
      const out = run(process.execPath, [new URL(import.meta.url).pathname, '--record-one', slug, String(n)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 << 20 });
      if (JSON.parse(out.split('\n').find((l) => l.startsWith('BENCH ')).slice(6)) === null) break;
    }
  }
} else {
  const { execFileSync: run } = await import('node:child_process');
  run(process.execPath, [new URL(import.meta.url).pathname, '--prime'], { stdio: 'ignore' });
  const results = [];
  for (const slug of SLUGS) {
    for (let n = 0; ; n++) {
      // COLD fresh processes per endpoint; its figures are their medians (a busy runner
      // makes any one of them noisy).
      const runs = [];
      for (let k = 0; k < COLD; k++) {
        const out = run(process.execPath, [new URL(import.meta.url).pathname, '--one', slug, String(n)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 });
        const r = JSON.parse(out.split('\n').find((l) => l.startsWith('BENCH ')).slice(6));
        if (!r) break;
        runs.push(r);
      }
      if (!runs.length) break;
      const mid = (xs) => xs.sort((x, y) => x - y)[Math.floor(xs.length / 2)];
      results.push({ ...runs[0], first: mid(runs.map((r) => r.first)), warm: mid(runs.map((r) => r.warm)) });
    }
  }
  console.log(`${pad('book', 38)}${pad('endpoint', 34)}${pad('status', 8)}${pad('first ms', 10)}warm ms`);
  let over = 0;
  for (const r of results) {
    const bad = r.first > BUDGET || r.warm > BUDGET || r.status >= 500;
    if (bad) over++;
    console.log(`${pad(r.slug, 38)}${pad(r.name, 34)}${pad(r.status, 8)}${pad(r.first.toFixed(1), 10)}${r.warm.toFixed(1)}${bad ? '  OVER' : ''}`);
  }
  console.log(over ? `${over} over the ${BUDGET} ms budget (or failed).` : `All under the ${BUDGET} ms budget.`);
  process.exitCode = over ? 1 : 0;
}
