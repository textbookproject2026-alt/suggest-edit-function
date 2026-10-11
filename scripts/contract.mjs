/**
 * Contract test: the same read-only requests to two hosts (the Vercel fallback and the
 * Worker), comparing status, the headers the handlers set, and the body (JSON deeply).
 * Nothing here writes: reads, preflights, and requests refused before any side effect.
 *
 *   node scripts/contract.mjs https://suggest-edit-function.vercel.app https://api.confused4now.org
 *
 * Exit 1 on any difference. GITHUB_TOKEN (optional) raises GitHub's limit for picking shas.
 */
import BUNDLE from '../registry/bundled.mjs';

const [A, B] = process.argv.slice(2);
if (!A || !B) throw new Error('usage: contract.mjs <base A> <base B>');

const HEADERS = ['content-type', 'access-control-allow-origin', 'access-control-allow-methods', 'access-control-allow-headers',
  'access-control-max-age', 'access-control-allow-credentials', 'vary', 'cache-control', 'allow', 'x-registry-version',
  'x-function-version', 'content-security-policy', 'referrer-policy'];

const gh = async (path) => {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { Accept: 'application/vnd.github+json', ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) },
  });
  return res.ok ? res.json() : null;
};

const books = BUNDLE.registry.books.filter((b) => b.status !== 'retired' && b.site?.domain);
const portal = `https://${BUNDLE.registry.platform.portal?.domain ?? 'confused4now.org'}`;
const author = 'https://author.confused4now.org';

/** [label, method, path, headers, body, options] */
const cases = [
  ['unknown path', 'GET', '/api/nope', {}, undefined, { statusOnly: true }], // Vercel's 404 carries a request id
  ['suggest: no Origin', 'OPTIONS', '/api/suggest-edit', {}],
  ['suggest: foreign Origin', 'OPTIONS', '/api/suggest-edit', { Origin: 'https://example.com' }],
  ['request-book: preflight', 'OPTIONS', '/api/request-book', { Origin: portal, 'Access-Control-Request-Method': 'POST' }],
  ['request-book: GET', 'GET', '/api/request-book', { Origin: portal }],
  ['author-read: preflight', 'OPTIONS', '/api/author-read', { Origin: author, 'Access-Control-Request-Method': 'GET' }],
  ['author-read: no auth', 'GET', '/api/author-read?what=books', { Origin: author }],
  ['author-act: no auth', 'POST', '/api/author-act', { Origin: author, 'Content-Type': 'application/json' }, '{}'],
  ['author-sync: no auth', 'POST', '/api/author-sync', { 'Content-Type': 'application/json' }, '{}'],
  ['history: unknown book', 'GET', '/api/history?book=no-such-book', {}],
  ['github-auth: no params', 'GET', '/api/github-auth', {}, undefined, { statusOnly: true }],
];

for (const book of books) {
  const origin = `https://${book.site.domain}`;
  const slug = book.slug;
  cases.push(
    [`${slug}: suggest preflight`, 'OPTIONS', '/api/suggest-edit', { Origin: origin, 'Access-Control-Request-Method': 'POST' }],
    [`${slug}: suggest GET`, 'GET', '/api/suggest-edit', { Origin: origin }],
    [`${slug}: suggest text/plain`, 'POST', '/api/suggest-edit', { Origin: origin, 'Content-Type': 'text/plain' }, 'x'],
    [`${slug}: suggest bad JSON`, 'POST', '/api/suggest-edit', { Origin: origin, 'Content-Type': 'application/json' }, '{not json'],
    [`${slug}: propose preflight`, 'OPTIONS', '/api/propose-edit', { Origin: origin, 'Access-Control-Request-Method': 'POST' }],
    [`${slug}: propose GET index`, 'GET', '/api/propose-edit?path=index.md', { Origin: origin }],
    [`${slug}: history`, 'GET', `/api/history?book=${slug}`, { Origin: origin }],
    [`${slug}: history declined`, 'GET', `/api/history?book=${slug}&declined=1`, { Origin: origin }],
    [`${slug}: page-revision preflight`, 'OPTIONS', '/api/page-revision', { Origin: origin, 'Access-Control-Request-Method': 'GET' }],
  );
  const commits = await gh(`/repos/${book.content.repo}/commits?per_page=3&path=chapters`);
  if (commits?.length >= 2) {
    const [c0, c1] = commits.map((c) => c.sha);
    const detail = await gh(`/repos/${book.content.repo}/commits/${c0}`);
    const path = detail?.files?.map((f) => f.filename).find((f) => f.startsWith('chapters/') && f.endsWith('.md') && !detail.files.find((g) => g.filename === f && g.status === 'removed'));
    cases.push([`${slug}: page-revision shas`, 'GET', `/api/page-revision?book=${slug}&shas=${c0},${c1}`, { Origin: origin }]);
    if (path) {
      cases.push(
        [`${slug}: page-revision one`, 'GET', `/api/page-revision?book=${slug}&sha=${c0}&path=${encodeURIComponent(path)}`, { Origin: origin }],
        [`${slug}: page-revision compare`, 'GET', `/api/page-revision?book=${slug}&sha=${c0}&path=${encodeURIComponent(path)}&base=${c1}`, { Origin: origin }],
      );
    }
  }
  const declined = (await (await fetch(`${A}/api/history?book=${slug}&declined=1`)).json().catch(() => ({})))?.declined ?? [];
  const pr = declined.find((d) => d.kind === 'edit');
  if (pr) cases.push([`${slug}: declined change #${pr.number}`, 'GET', `/api/history?book=${slug}&change=${pr.number}`, { Origin: origin }]);
  if (declined[0]) cases.push([`${slug}: item #${declined[0].number}`, 'GET', `/api/page-revision?mode=item&book=${slug}&number=${declined[0].number}`, {}]);
}

async function hit(base, [, method, path, headers, body]) {
  const t = Date.now();
  const res = await fetch(base + path, { method, headers, body, redirect: 'manual' });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  const seen = Object.fromEntries(HEADERS.map((h) => [h, res.headers.get(h)]));
  // The hosts deploy separately (Vercel skips workflow-only commits): compare presence, not the sha.
  if (seen['x-function-version']) seen['x-function-version'] = '<sha>';
  return { status: res.status, headers: seen, text, json, ms: Date.now() - t };
}

const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x));

let failed = 0;
for (const c of cases) {
  const [a, b] = [await hit(A, c), await hit(B, c)];
  const diffs = [];
  if (a.status !== b.status) diffs.push(`status ${a.status} vs ${b.status}`);
  if (!c[5]?.statusOnly) {
    for (const h of HEADERS) if (a.headers[h] !== b.headers[h]) diffs.push(`${h}: ${a.headers[h]} | ${b.headers[h]}`);
    const same = a.json !== undefined || b.json !== undefined ? canon(a.json) === canon(b.json) : a.text === b.text;
    if (!same) diffs.push(`body: ${(a.text).slice(0, 160)} | ${(b.text).slice(0, 160)}`);
  }
  console.log(`${diffs.length ? 'DIFF' : 'same'}  ${String(a.status).padEnd(3)} ${c[1].padEnd(7)} ${c[0]}  (${a.ms} / ${b.ms} ms)`);
  for (const d of diffs) console.log(`        ${d}`);
  if (diffs.length) failed++;
}
console.log(`\n${cases.length - failed}/${cases.length} identical`);
process.exit(failed ? 1 : 0);
