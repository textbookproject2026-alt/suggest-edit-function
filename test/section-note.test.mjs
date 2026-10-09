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
  const r = await call({ body: { ...NOTE, quote: 'a\n# heading\n' + 'q'.repeat(1000) } });
  const quote = r.issue.body.split('```text\n')[1].split('\n')[0];
  assert.equal(quote.length, 300);
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
