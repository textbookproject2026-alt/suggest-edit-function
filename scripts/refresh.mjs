/**
 * Works out ahead what the Worker's reads would otherwise work out on a request
 * (batch 2d), and writes it to the c4n-api-cache KV namespace (lib/kv-cache.mjs): for
 * each book on the platform, its History lists (open, declined), the "a reader" names
 * its history.json asks for, and every page of its drafts branch as the editor loads
 * it, and each version its history.json lists as Show changes answers it (and its text,
 * for Compare), at most WARM_PER_RUN new ones a run. Each key is written only when what it holds changed (free-plan KV: 1,000 writes
 * a day), then HEARTBEAT is stamped, which keeps everything written current for the
 * Worker (FRESH_MS). Run by refresh.yml: every 15 minutes, after a book's build, and
 * by hand. Here, not on the Worker, so none of it counts against the Worker's CPU.
 *
 *   GITHUB_APP_ID GITHUB_APP_PRIVATE_KEY CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID CACHE_ID
 *   node scripts/refresh.mjs [slug]
 */
import { REGISTRY, appCredentials, blobTexts, budget, ghJson, encodePath } from '../lib/author.mjs';
import { declinedItems } from '../lib/declined.mjs';
import { HEARTBEAT, cacheKeys } from '../lib/kv-cache.mjs';
import pageRevision, { branchesOf, openItems, revKey, textKey } from '../api/page-revision.js';

const [only] = process.argv.slice(2);
const { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CACHE_ID } = process.env;
const KV = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${CACHE_ID}`;
const auth = { Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}` };
const appToken = appCredentials({ contents: 'read', pull_requests: 'read', issues: 'read' });
const MAX_SOURCE_BYTES = 1024 * 1024; // propose-edit's: a larger page isn't kept, the GET says so itself
const MAX_NAMES = 30; // page-revision's MAX_SHAS
// New versions kept per run: ~1,000 KV writes a day in all, two per version, the
// heartbeat 96. A book's whole history (hundreds of versions) fills over a few hours, once.
const WARM_PER_RUN = 25;
let writes = 0;
let warmed = 0;

async function kvGet(key) {
  const res = await fetch(`${KV}/values/${encodeURIComponent(key)}`, { headers: auth });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`KV read of ${key}: ${res.status}`);
  return res.json();
}
async function kvPut(pairs) {
  if (!pairs.length) return;
  const res = await fetch(`${KV}/bulk`, { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(pairs) });
  if (!res.ok) throw new Error(`KV write: ${res.status} ${(await res.text()).slice(0, 200)}`);
  writes += pairs.length;
}
async function kvDelete(key) {
  const res = await fetch(`${KV}/values/${encodeURIComponent(key)}`, { method: 'DELETE', headers: auth });
  if (!res.ok && res.status !== 404) throw new Error(`KV delete of ${key}: ${res.status}`);
  writes += 1;
}
const entry = (value) => ({ key: '', value: JSON.stringify({ at: Date.now(), value }) });

/** Written only when it differs from what KV holds. */
async function keep(key, value) {
  const now = await kvGet(key);
  if (now && JSON.stringify(now.value) === JSON.stringify(value)) return false;
  await kvPut([{ ...entry(value), key }]);
  return true;
}

async function kvKeys(prefix) {
  const out = new Set();
  let cursor = '';
  do {
    const res = await fetch(`${KV}/keys?prefix=${encodeURIComponent(prefix)}&limit=1000${cursor ? `&cursor=${cursor}` : ''}`, { headers: auth });
    if (!res.ok) throw new Error(`KV list: ${res.status}`);
    const body = await res.json();
    for (const k of body.result ?? []) out.add(k.name);
    cursor = body.result_info?.cursor ?? '';
  } while (cursor);
  return out;
}

const historyOf = async (book) => {
  const res = await fetch(`https://${book.site.domain}/.well-known/history.json`);
  return res.ok ? res.json().catch(() => null) : null;
};

/** Show changes for each listed version not kept yet, worked out by page-revision itself, here. */
async function versions(book, h) {
  const repo = book.content.repo;
  const have = await kvKeys(`rev:${repo}:`);
  const todo = (h?.pages ?? []).flatMap((p) => [...(p.published ?? []), ...(p.drafts ?? [])].map((e) => ({ sha: e.sha, path: e.path ?? p.source })))
    .filter((v) => /^[0-9a-f]{40}$/.test(v.sha ?? '') && v.path && !have.has(revKey(repo, v.sha, v.path)));
  let done = 0;
  for (const v of todo) {
    if (warmed >= WARM_PER_RUN) break;
    const res = { headers: {}, statusCode: 0, body: '', setHeader() {}, status(c) { this.statusCode = c; return this; }, json(p) { this.body = JSON.stringify(p); }, end(b) { this.body = b ?? ''; } };
    const url = `/api/page-revision?book=${encodeURIComponent(book.slug)}&sha=${v.sha}&path=${encodeURIComponent(v.path)}`;
    await pageRevision({ method: 'GET', url, query: Object.fromEntries(new URL(url, 'https://x.invalid').searchParams), headers: { 'x-forwarded-for': `10.0.${warmed >> 8}.${warmed & 255}` } }, res);
    warmed += 1;
    if (res.statusCode !== 200) continue; // a version that isn't (or no longer) public: asked again next run
    const answer = JSON.parse(res.body);
    await kvPut([
      { key: revKey(repo, v.sha, v.path), value: res.body },
      { key: textKey(repo, v.sha, v.path), value: JSON.stringify({ branch: answer.branch, text: answer.after }) },
    ]);
    done += 1;
  }
  return `${done} of ${todo.length} versions kept`;
}

/** The names the book's History panels ask for: every "a reader" commit in its history.json. */
async function names(book, token, h) {
  const shas = [...new Set((h?.pages ?? []).flatMap((p) => [...(p.published ?? []), ...(p.drafts ?? [])])
    .filter((e) => e?.who === 'a reader' && /^[0-9a-f]{40}$/.test(e.sha ?? '')).map((e) => e.sha))];
  const out = {};
  for (let i = 0; i < shas.length; i += MAX_NAMES) {
    const batch = shas.slice(i, i + MAX_NAMES);
    const got = new Map();
    const where = await branchesOf(book, batch, token, budget(20_000), { liveOnly: true, names: got });
    for (const s of batch) out[s] = where.get(s) === 'live' ? got.get(s) ?? null : null;
  }
  return out;
}

/** Every Markdown page of the branch the editor reads, as its GET sends it; only changed blobs are read. */
async function sources(book, token) {
  const repo = book.content.repo;
  const branch = book.content.drafts_branch || book.content.live_branch;
  const tree = await ghJson(`/repos/${repo}/git/trees/${encodePath(branch)}?recursive=1`, token, budget(20_000));
  const pages = new Map((tree.tree ?? []).filter((e) => e.type === 'blob' && /\.md$/i.test(e.path) && e.size <= MAX_SOURCE_BYTES).map((e) => [e.path, e.sha]));
  const indexKey = `src-index:${repo}:${branch}`;
  const was = (await kvGet(indexKey))?.value ?? {};
  const changed = [...pages].filter(([p, sha]) => was[p] !== sha);
  let written = 0;
  for (let i = 0; i < changed.length; i += 25) {
    const batch = changed.slice(i, i + 25);
    const texts = await blobTexts(repo, batch.map(([, sha]) => sha), token, budget(20_000));
    const pairs = batch.filter(([, sha]) => texts.has(sha)).map(([path, sha]) => ({
      ...entry({ branch, sha, text: texts.get(sha).replace(/\r\n/g, '\n') }), key: cacheKeys.source(repo, branch, path),
    }));
    await kvPut(pairs);
    written += pairs.length;
  }
  const gone = Object.keys(was).filter((p) => !pages.has(p));
  for (const p of gone) await kvDelete(cacheKeys.source(repo, branch, p));
  // The index last: a run that stops half-way reads the rest again next time.
  if (changed.length || gone.length) await kvPut([{ ...entry(Object.fromEntries(pages)), key: indexKey }]);
  return `${pages.size} pages, ${written} written, ${gone.length} gone`;
}

const books = REGISTRY.books.filter((b) => b.status !== 'retired' && b.content?.repo && (!only || b.slug === only));
let failed = 0;
for (const book of books) {
  const tag = `[refresh ${book.slug}]`;
  try {
    const { token } = await appToken(book, tag);
    const h = book.site?.domain ? await historyOf(book) : null;
    const [open, declined, named] = await Promise.all([
      openItems(book, token, budget(20_000)),
      declinedItems(book, token, budget(20_000)),
      names(book, token, h),
    ]);
    const lists = [
      await keep(cacheKeys.open(book.slug), open) && 'open',
      await keep(cacheKeys.declined(book.slug), declined) && 'declined',
      await keep(cacheKeys.names(book.slug), named) && 'names',
    ].filter(Boolean);
    console.log(`${book.slug}: ${open.length} open, ${declined.length} declined, ${Object.keys(named).length} names; ${await sources(book, token)}; ${await versions(book, h)}; changed: ${lists.join(', ') || 'none'}`);
  } catch (err) {
    failed += 1;
    console.log(`::warning::${book.slug}: ${err.message}`);
  }
}
// Stamped only when every book was refreshed: a stale stamp sends the Worker back to working things out itself.
if (!failed && !only) await kvPut([{ key: HEARTBEAT, value: JSON.stringify({ at: Date.now() }) }]);
console.log(`${books.length} books, ${failed} failed, ${writes} KV writes`);
process.exit(failed ? 1 : 0);
