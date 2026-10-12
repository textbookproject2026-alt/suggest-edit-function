/**
 * Traffic for measuring the Worker's CPU (measure.yml): every route once, then three
 * more times. Run it right after a new version is deployed and each route's first
 * request loads its code (load=1 in the log); the rest are warm. History and revision
 * reads carry a fresh `_m` so no cache answers them: their full cost is measured.
 * Nothing here writes anything: suggestion and request bodies carry the honeypot. With
 * NOTES=1, one real note per round goes to the platform test book (an issue, to close
 * and label platform-test afterwards), so a note's write is measured too.
 *
 *
 * Paced (GAP_MS, default 1 s between requests): sent back to back (~25 a second),
 * `wrangler tail` samples and kept only about a third of them (11 Oct). The count sent
 * is added to SENT_FILE, so the summary can tell a complete capture from a sampled one.
 * At 0.4 s apart it still kept only 63% (12 Oct); at about 0.65 s, 98%.
 *
 *   node scripts/measure-load.mjs <base> [round]
 */
import { appendFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import BUNDLE from '../registry/bundled.mjs';

const [base, round = '0'] = process.argv.slice(2);
const book = BUNDLE.registry.books.find((b) => b.slug === 'ontology-for-social-research-a-criti');
const origin = `https://${book.site.domain}`;
const portal = `https://${BUNDLE.registry.platform.portal.domain}`;
const author = 'https://author.confused4now.org';
const slug = book.slug;
const others = BUNDLE.registry.books.filter((b) => b.status !== 'retired' && b.site?.domain && b.slug !== slug);
const json = { 'Content-Type': 'application/json' };
const GAP_MS = Number(process.env.GAP_MS ?? 1000);

const gh = async (path) => (await fetch(`https://api.github.com${path}`, {
  headers: { Accept: 'application/vnd.github+json', ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) },
})).json();
const [c0, c1] = (await gh(`/repos/${book.content.repo}/commits?per_page=2&path=chapters`)).map((c) => c.sha);
const path = (await gh(`/repos/${book.content.repo}/commits/${c0}`)).files.map((f) => f.filename).find((f) => /^chapters\/.*\.md$/.test(f));
// The names a History panel asks for: its "a reader" commits (none: the two above).
const built = await (await fetch(`${origin}/.well-known/history.json`)).json().catch(() => null);
const readers = [...new Set((built?.pages ?? []).flatMap((p) => [...(p.published ?? []), ...(p.drafts ?? [])]).filter((e) => e.who === 'a reader').map((e) => e.sha))];
const shas = (readers.length ? readers.slice(0, 30) : [c0, c1]).join(',');

let n = 0;
const fresh = () => `_m=${round}-${++n}`;
/** [method, path, headers, body] */
const requests = () => [
  ['OPTIONS', '/api/suggest-edit', { Origin: origin, 'Access-Control-Request-Method': 'POST' }],
  ['POST', '/api/suggest-edit', { Origin: origin, ...json }, JSON.stringify({ name: 'measure', path: 'index.md', suggestion: 'A measurement, discarded.', website: 'x' })],
  ['GET', `/api/history?book=${slug}&${fresh()}`, { Origin: origin }],
  ['GET', `/api/history?book=${slug}&declined=1&${fresh()}`, { Origin: origin }],
  ['GET', `/api/page-revision?book=${slug}&shas=${shas}&${fresh()}`, { Origin: origin }],
  ['GET', `/api/page-revision?book=${slug}&sha=${c0}&path=${encodeURIComponent(path)}&base=${c1}&${fresh()}`, { Origin: origin }],
  // Show changes: one version against the one before it.
  ['GET', `/api/page-revision?book=${slug}&sha=${c0}&path=${encodeURIComponent(path)}&${fresh()}`, { Origin: origin }],
  ['GET', '/api/propose-edit?path=index.md', { Origin: origin }],
  ['GET', `/api/github-auth?origin=${encodeURIComponent(origin)}`, {}],
  ['POST', '/api/request-book', { Origin: portal, ...json }, JSON.stringify({ title: 'A measurement', authors: 'Nobody', email: 'delivered@resend.dev', summary: 'A measurement of the API, discarded by the honeypot.', agreeLicence: true, website: 'x' })],
  // Every live book's history: a book's lists are kept 90 s (120 with declined), so
  // the rounds also measure working them out again (logged with subrequests > 0).
  ...others.flatMap((b) => [
    ['GET', `/api/history?book=${b.slug}&${fresh()}`, { Origin: `https://${b.site.domain}` }],
    ['GET', `/api/history?book=${b.slug}&declined=1&${fresh()}`, { Origin: `https://${b.site.domain}` }],
  ]),
  ['OPTIONS', '/api/author-read', { Origin: author, 'Access-Control-Request-Method': 'GET' }],
  ['GET', '/api/author-read?what=books', { Origin: author }],
  ['POST', '/api/author-act', { Origin: author, ...json }, '{}'],
];

const test = BUNDLE.registry.books.find((b) => b.slug === 'platform-test-book');
const note = () => ['POST', '/api/suggest-edit?mode=note', { Origin: `https://${test.site.domain}`, ...json }, JSON.stringify({
  name: 'CPU measurement', path: 'chapters/chapter-01.md', page: '/chapters/chapter-01', paragraph: 1, quote: 'measurement',
  suggestion: `A measurement of the API's CPU (round ${round}): please ignore, it is closed and labelled platform-test afterwards.`,
})];

// FOCUS=1: only reader names (first, so it is this isolate's first load) and the people
// sync, which answers "in sync" without writing unless the author site's list changed.
// Rotates books: author-sync allows 20 an hour per book.
const live = BUNDLE.registry.books.filter((b) => b.status !== 'retired');
const focus = () => [
  ['GET', `/api/page-revision?book=${slug}&shas=${shas}&${fresh()}`, { Origin: origin }],
  ['POST', '/api/author-sync', { ...json }, JSON.stringify({ book: live[Number(round) % live.length].slug })],
];

const statuses = [];
const versions = new Set();
for (let pass = 0; pass < (process.env.FOCUS === '1' ? 1 : 4); pass++) {
  if (process.env.FOCUS === '1') {
    for (const [method, p, headers, body] of focus()) {
      const res = await fetch(base + p, { method, headers, body, redirect: 'manual' });
      await res.arrayBuffer();
      statuses.push(`${method} ${p.split('?')[0]} ${res.status}`);
      versions.add(res.headers.get('x-worker-version'));
      await sleep(GAP_MS);
    }
    continue;
  }
  const list = requests();
  // Odd rounds: a fresh isolate's very first request is a path with no route, so its
  // CPU is the isolate's start alone (logged cold=1); every route after it then loads
  // (load=1). Even rounds: a read route is that very first request instead, each in
  // turn, so the reads are measured cold too.
  const reads = list.map((r, i) => (r[0] === 'GET' && /\/api\/(history|page-revision|propose-edit)/.test(r[1]) && i < 9 ? i : -1)).filter((i) => i >= 0);
  const even = Number(round) % 2 === 0;
  const shift = even ? reads[(Number(round) / 2) % reads.length] : Number(round) % list.length;
  const first = pass === 0 && !even ? [['GET', '/api/nope', {}]] : [];
  if (pass === 1 && process.env.NOTES === '1') list.push(note());
  for (const [method, p, headers, body] of [...first, ...list.slice(shift), ...list.slice(0, shift)]) {
    const res = await fetch(base + p, { method, headers, body, redirect: 'manual' });
    await res.arrayBuffer();
    statuses.push(`${method} ${p.split('?')[0]} ${res.status}`);
    versions.add(res.headers.get('x-worker-version'));
    await sleep(GAP_MS);
  }
}
if (process.env.SENT_FILE) appendFileSync(process.env.SENT_FILE, `${statuses.length}\n`);
console.log(`round ${round}: ${statuses.length} requests; ${[...new Set(statuses)].join(', ')}`);
// The deploy may not have reached this data centre yet: then the round measured the old
// version's warm isolates, which the summary can't tell apart. Say so.
if (process.env.EXPECT && [...versions].some((v) => v !== process.env.EXPECT)) {
  console.log(`::warning::round ${round} was answered by ${[...versions].join(', ')}, not only ${process.env.EXPECT}`);
}
