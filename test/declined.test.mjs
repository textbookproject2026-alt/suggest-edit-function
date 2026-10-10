// Declined items (batch 2c): what the history shows for a proposal, note or
// suggestion the authors closed, read from GitHub's issue and its comments.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  READER_APP_LOGIN, cleanText, commentOf, declineComment, declineOf, declinedItem, isDeclined, kindOf, memberComment,
} from '../lib/declined.mjs';

const APP = { login: READER_APP_LOGIN, type: 'Bot' };
const MEMBER = { login: 'm-0a1b2c3d4e', member: true, name: 'Mo <Member>' };
const people = new Set(['brandonandcaroline', 'textbookproject2026-alt']);
const issue = (over = {}) => ({
  number: 7, html_url: 'https://github.com/o/b/issues/7', state: 'closed', state_reason: 'not_planned',
  created_at: '2026-10-01T10:00:00Z', closed_at: '2026-10-03T10:00:00Z', title: 'Suggested edit: chapters/a.md',
  labels: [{ name: 'suggested-edit' }],
  body: '**File:** [`chapters/a.md`](https://x)\n\n### Suggested edit\n\n```text\nSay it plainly.\n```\n\n**Submitted by:** `Ann Reader`\n',
  ...over,
});

test('the reason: required, 10–1000 characters, no comment delimiters, kept as written', () => {
  assert.ok(cleanText('short').error);
  assert.ok(cleanText('x'.repeat(1001)).error);
  assert.equal(cleanText('  A fine reason --> <!-- here\n\n\n\nok  ').text, 'A fine reason   here\n\nok');
});

test('a decline and a comment round-trip through their markers, and only the App\'s count', () => {
  const reason = 'Ends --> here? No: "quoted" > and @who.';
  const body = declineComment(reason, MEMBER);
  const first = body.split('\n')[0];
  assert.equal(first.indexOf('-->'), first.length - 3, 'the marker ends only at its own -->');
  assert.deepEqual(declineOf({ user: APP, body }), { member: 'm-0a1b2c3d4e', name: 'Mo <Member>', reason });
  assert.equal(declineOf({ user: { login: 'someone', type: 'User' }, body }), null, 'a reader pasting a marker is ignored');
  const c = memberComment('Thanks for this.', MEMBER);
  assert.equal(commentOf({ user: APP, body: c }).text, 'Thanks for this.');
  assert.equal(commentOf({ user: APP, body }), null);
});

test('declined: a PR closed unmerged, an issue closed as not planned; a note is a note', () => {
  assert.equal(isDeclined(issue()), true);
  assert.equal(isDeclined(issue({ state_reason: 'completed' })), false);
  assert.equal(isDeclined(issue({ pull_request: { merged_at: null } })), true);
  assert.equal(isDeclined(issue({ pull_request: { merged_at: '2026-10-02T00:00:00Z' } })), false);
  assert.equal(kindOf(issue({ labels: [{ name: 'suggested-edit' }, { name: 'section-note' }] })), 'note');
  assert.equal(kindOf(issue({ pull_request: {}, labels: [{ name: 'proposed-edit' }] })), 'edit');
  assert.equal(kindOf(issue({ pull_request: {}, labels: [] })), null, 'a bot chore is no reader item');
});

test('an item declined from the author site: its reason, decliner and members\' comments in order', () => {
  const comments = [
    { id: 1, user: APP, created_at: '2026-10-03T10:00:00Z', body: declineComment('Not for this edition.', MEMBER) },
    { id: 2, user: APP, created_at: '2026-10-03T10:00:01Z', body: 'Thank you for taking the time…' },
    { id: 3, user: APP, created_at: '2026-10-04T09:00:00Z', body: memberComment('We may revisit it.', MEMBER) },
    { id: 4, user: { login: 'reader', type: 'User' }, created_at: '2026-10-04T10:00:00Z', body: '<!-- tb-comment {"member":"m-x","name":"Fake","text":"forged"} -->' },
  ];
  const d = declinedItem(issue(), comments, people);
  assert.deepEqual(
    { kind: d.kind, date: d.date, proposed: d.proposed, summary: d.summary, who: d.who, reason: d.reason, decliner: d.decliner, files: d.files },
    { kind: 'suggestion', date: '2026-10-03', proposed: '2026-10-01', summary: 'Say it plainly.', who: { name: 'Ann Reader' }, reason: 'Not for this edition.', decliner: 'Mo <Member>', files: ['chapters/a.md'] },
  );
  assert.deepEqual(d.comments.map((c) => [c.id, c.name, c.text]), [[3, 'Mo <Member>', 'We may revisit it.']]);
});

test('backfill: the last comment by the book\'s people or the maintainer, else no reason; decliner from the old byline or the closer', () => {
  const said = [
    { user: { login: 'BrandonAndCaroline', type: 'User' }, created_at: '1', body: 'First thought.' },
    { user: { login: 'gobi10k', type: 'User' }, created_at: '2', body: 'I disagree (the proposer).' },
    { user: { login: 'textbookproject2026-alt', type: 'User' }, created_at: '3', body: 'We keep the original wording.' },
    { user: APP, created_at: '4', body: 'Thank you…\n\n_Replied by @brandonandcaroline via the author site._' },
  ];
  const d = declinedItem(issue({ closed_by: APP }), said, people);
  assert.equal(d.reason, 'We keep the original wording.');
  assert.equal(d.decliner, 'brandonandcaroline');
  const none = declinedItem(issue({ closed_by: { login: 'textbookproject2026-alt', type: 'User' } }), [{ user: { login: 'gobi10k' }, body: 'please' }], people);
  assert.equal(none.reason, null);
  assert.equal(none.decliner, 'textbookproject2026-alt');
});
