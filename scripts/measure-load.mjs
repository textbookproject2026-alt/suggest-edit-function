/**
 * Traffic for measuring the Worker's CPU (measure.yml): every route once, then three
 * more times. Run it right after a new version is deployed and each route's first
 * request loads its code (load=1 in the log); the rest are warm. History and revision
 * reads carry a fresh `_m` so no cache answers them: their full cost is measured.
 * Nothing here writes anything: suggestion and request bodies carry the honeypot.
 *
 *   node scripts/measure-load.mjs <base> [round]
 */
import BUNDLE from '../registry/bundled.mjs';

const [base, round = '0'] = process.argv.slice(2);
const book = BUNDLE.registry.books.find((b) => b.slug === 'ontology-for-social-research-a-criti');
const origin = `https://${book.site.domain}`;
const portal = `https://${BUNDLE.registry.platform.portal.domain}`;
const author = 'https://author.confused4now.org';
const slug = book.slug;
const json = { 'Content-Type': 'application/json' };

const gh = async (path) => (await fetch(`https://api.github.com${path}`, {
  headers: { Accept: 'application/vnd.github+json', ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) },
})).json();
const [c0, c1] = (await gh(`/repos/${book.content.repo}/commits?per_page=2&path=chapters`)).map((c) => c.sha);
const path = (await gh(`/repos/${book.content.repo}/commits/${c0}`)).files.map((f) => f.filename).find((f) => /^chapters\/.*\.md$/.test(f));

let n = 0;
const fresh = () => `_m=${round}-${++n}`;
/** [method, path, headers, body] */
const requests = () => [
  ['OPTIONS', '/api/suggest-edit', { Origin: origin, 'Access-Control-Request-Method': 'POST' }],
  ['POST', '/api/suggest-edit', { Origin: origin, ...json }, JSON.stringify({ name: 'measure', path: 'index.md', suggestion: 'A measurement, discarded.', website: 'x' })],
  ['GET', `/api/history?book=${slug}&${fresh()}`, { Origin: origin }],
  ['GET', `/api/history?book=${slug}&declined=1&${fresh()}`, { Origin: origin }],
  ['GET', `/api/page-revision?book=${slug}&shas=${c0},${c1}&${fresh()}`, { Origin: origin }],
  ['GET', `/api/page-revision?book=${slug}&sha=${c0}&path=${encodeURIComponent(path)}&base=${c1}&${fresh()}`, { Origin: origin }],
  ['GET', '/api/propose-edit?path=index.md', { Origin: origin }],
  ['GET', `/api/github-auth?origin=${encodeURIComponent(origin)}`, {}],
  ['POST', '/api/request-book', { Origin: portal, ...json }, JSON.stringify({ title: 'A measurement', authors: 'Nobody', email: 'delivered@resend.dev', summary: 'A measurement of the API, discarded by the honeypot.', agreeLicence: true, website: 'x' })],
  ['OPTIONS', '/api/author-read', { Origin: author, 'Access-Control-Request-Method': 'GET' }],
  ['GET', '/api/author-read?what=books', { Origin: author }],
  ['POST', '/api/author-act', { Origin: author, ...json }, '{}'],
];

const statuses = [];
const versions = new Set();
for (let pass = 0; pass < 4; pass++) {
  const list = requests();
  // A different route first each round, so each gets to be an isolate's very first.
  const shift = Number(round) % list.length;
  // A fresh isolate's very first request: a path with no route, so its CPU is the
  // isolate's start alone (logged cold=1); every route after it then loads (load=1).
  const first = pass === 0 ? [['GET', '/api/nope', {}]] : [];
  for (const [method, p, headers, body] of [...first, ...list.slice(shift), ...list.slice(0, shift)]) {
    const res = await fetch(base + p, { method, headers, body, redirect: 'manual' });
    await res.arrayBuffer();
    statuses.push(`${method} ${p.split('?')[0]} ${res.status}`);
    versions.add(res.headers.get('x-worker-version'));
  }
}
console.log(`round ${round}: ${statuses.length} requests; ${[...new Set(statuses)].join(', ')}`);
// The deploy may not have reached this data centre yet: then the round measured the old
// version's warm isolates, which the summary can't tell apart. Say so.
if (process.env.EXPECT && [...versions].some((v) => v !== process.env.EXPECT)) {
  console.log(`::warning::round ${round} was answered by ${[...versions].join(', ')}, not only ${process.env.EXPECT}`);
}
