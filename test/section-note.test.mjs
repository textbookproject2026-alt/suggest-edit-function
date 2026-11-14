/**
 * A note to the authors on one paragraph (the ¶ margin's note control), and a
 * note sent while signed in with GitHub. POST /api/suggest-edit, through the
 * shared harness. Run with `npm test`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { call, VALID, DEFAULT_BOOK, DEFAULT_ORIGIN } from './harness.mjs';
import { issueIdentity } from '../lib/identity.mjs';

process.env.IDENTITY_SECRET = 'z'.repeat(40);
const NOTE = { ...VALID, paragraph: 4, page: '/chapters/chapter-03', quote: 'Consider a situation that will be familiar…' };

test('a paragraph note: ¶ permalink on the book domain, the quote, the source path, section-note beside the usual labels', async () => {
  const r = await call({ body: NOTE });
  assert.equal(r.status, 201);
  assert.equal(r.issue.title, `Note on ¶4: ${VALID.path}`);
  assert.deepEqual(r.issue.labels, ['suggested-edit', 'needs-triage', 'section-note']);
  assert.ok(r.issue.body.includes(`**Where:** [¶4](https://${DEFAULT_BOOK.site.domain}/chapters/chapter-03#p4)`), r.issue.body);
  assert.ok(r.issue.body.includes('```text\nConsider a situation that will be familiar…\n```'), r.issue.body);
  assert.ok(r.issue.body.includes(`**File:** [\`${VALID.path}\`]`));
  assert.match(r.issue.body, /\*\*Submitted by:\*\* `Ada Lovelace`/);
});

test('a page note is as before; a half-given or unsafe paragraph is a page note', async () => {
  for (const extra of [{}, { paragraph: 4 }, { page: '/x' }, { ...NOTE, paragraph: 0 }, { ...NOTE, page: '/../x' }, { ...NOTE, page: 'https://evil.example/x' }, { ...NOTE, page: '/a b' }]) {
    const r = await call({ body: { ...VALID, ...extra } });
    assert.equal(r.status, 201);
    assert.equal(r.issue.title, `Suggested edit: ${VALID.path}`, JSON.stringify(extra));
    assert.deepEqual(r.issue.labels, ['suggested-edit', 'needs-triage']);
    assert.ok(!r.issue.body.includes('**Where:**'));
  }
});

test('the quote is capped and kept to one line inside its fence', async () => {
  const r = await call({ body: { ...NOTE, quote: 'a\n# heading\n' + 'q'.repeat(6000) } });
  const quote = r.issue.body.split('```text\n')[1].split('\n')[0];
  assert.equal(quote.length, 5000);
  assert.ok(quote.endsWith('q…'));
  assert.ok(quote.startsWith('a # heading '));
});

test('signed in: the note names @login so GitHub tells them when it closes; a bad sign-in is ignored, never refused', async () => {
  const identity = issueIdentity(process.env.IDENTITY_SECRET, { login: 'ada-l', id: 42, name: 'Ada' }, DEFAULT_ORIGIN);
  const r = await call({ body: { ...NOTE, identity } });
  assert.equal(r.status, 201);
  assert.match(r.issue.body, /\*\*Submitted by:\*\* @ada-l \(signed in with GitHub\)/);
  for (const bad of [issueIdentity('y'.repeat(40), { login: 'ada-l', id: 42 }, DEFAULT_ORIGIN), issueIdentity(process.env.IDENTITY_SECRET, { login: 'ada-l', id: 42 }, 'https://other.example'), 'junk']) {
    const b = await call({ body: { ...NOTE, identity: bad } });
    assert.equal(b.status, 201);
    assert.match(b.issue.body, /\*\*Submitted by:\*\* `Ada Lovelace`/);
    assert.ok(!b.issue.body.includes('@ada-l'));
  }
});

const ANCHOR = {
  start: 4, end: 4, exact: 'a situation', prefix: 'Consider ', suffix: ' that will be familiar',
  text: 'Consider a situation that will be familiar to @everyone [here](x).', commit: 'abc1234def',
};

test('an anchored note: the paragraph quoted with the words in bold, inert, and the anchor in a comment', async () => {
  const r = await call({ body: { ...NOTE, note: true, anchor: ANCHOR } });
  assert.equal(r.status, 201);
  assert.deepEqual(r.issue.labels, ['suggested-edit', 'needs-triage', 'section-note']);
  const body = r.issue.body;
  assert.ok(body.includes(`**Where:** [¶4](https://${DEFAULT_BOOK.site.domain}/chapters/chapter-03#p4)`), body);
  assert.ok(body.includes('> Consider **a situation** that will be familiar to @&#8203;everyone &#91;here&#93;&#40;x&#41;&#46;'), body);
  assert.ok(!body.includes('```text\nConsider'), 'the anchor replaces the fenced quote');
  const json = JSON.parse(body.match(/<!-- c4n-anchor (.*) -->/)[1]);
  assert.deepEqual(json, ANCHOR);
});

test('an anchor across paragraphs says ¶4–6; words not in the paragraph are listed after it', async () => {
  const r = await call({ body: { ...NOTE, anchor: { ...ANCHOR, end: 6, exact: 'familiar to everyone. Next one', prefix: 'will be ' } } });
  assert.ok(r.issue.body.includes('[¶4–6]('), r.issue.body);
  assert.ok(r.issue.body.includes('**Selected:** familiar to everyone&#46; Next one'), r.issue.body);
});

test('a malformed anchor is dropped and the note is as before; old clients without one still work', async () => {
  for (const bad of [{ ...ANCHOR, start: 3 }, { ...ANCHOR, end: 2 }, { ...ANCHOR, exact: '' }, { ...ANCHOR, commit: 'zz' }, { ...ANCHOR, prefix: 'p'.repeat(65) }, 'x']) {
    const r = await call({ body: { ...NOTE, anchor: bad } });
    assert.equal(r.status, 201);
    assert.ok(!r.issue.body.includes('c4n-anchor'), JSON.stringify(bad));
    assert.ok(r.issue.body.includes('```text\nConsider a situation'), JSON.stringify(bad));
  }
  const page = await call({ body: { ...VALID, anchor: ANCHOR } });
  assert.ok(!page.issue.body.includes('c4n-anchor'), 'no paragraph, no anchor');
});

test('an anchor cannot close its HTML comment early', async () => {
  const r = await call({ body: { ...NOTE, anchor: { ...ANCHOR, exact: 'a situation --> <b>x</b>', text: 'Consider a situation --> <b>x</b>' } } });
  const tail = r.issue.body.slice(r.issue.body.indexOf('<!-- c4n-anchor'));
  assert.equal(tail.indexOf('-->'), tail.length - 3);
  assert.equal(JSON.parse(tail.match(/<!-- c4n-anchor (.*) -->/)[1]).exact, 'a situation --> <b>x</b>');
});

test('an anchored suggestion keeps the text it started from in its fence (the review replaces it), then the quoted paragraph', async () => {
  const r = await call({ body: { ...NOTE, quote: 'a situation', suggestion: 'a case', anchor: ANCHOR } });
  const body = r.issue.body;
  assert.ok(body.indexOf('```text\na situation\n```') < body.indexOf('> Consider **a situation**'), body);
  const { parseSuggestion } = await import('../lib/author-console.mjs');
  const s = parseSuggestion({ ...r.issue, number: 1, state: 'open', labels: r.issue.labels.map((name) => ({ name })) });
  assert.equal(s.original, 'a situation');
  const n = await call({ body: { ...NOTE, note: true, anchor: ANCHOR } });
  assert.equal(parseSuggestion({ ...n.issue, number: 2, state: 'open', labels: n.issue.labels.map((name) => ({ name })) }).original, '');
});
