import { test } from 'node:test';
import assert from 'node:assert/strict';
import { merge3 } from '../lib/merge3.mjs';

const doc = (p, q = 'Second paragraph here.') => `# T\n\n${p}\n\n${q}\n`;
const BASE = doc('The cat sat on mat and looked at dog.');

test('two fixes in different places of one paragraph both land', () => {
  const r = merge3(BASE, doc('The cat sat on the mat and looked at dog.'), doc('The cat sat on mat and looked at the dog.'));
  assert.deepEqual(r, { text: doc('The cat sat on the mat and looked at the dog.'), overlaps: [] });
});

test('changes to the same words overlap: the paragraph kept as now, with old, current and suggested', () => {
  const now = doc('The cat sat on the mat and looked at dog.');
  const sug = doc('A dog sat on the rug.');
  const want = [{ line: 2, base: 'The cat sat on mat and looked at dog.', current: 'The cat sat on the mat and looked at dog.', suggested: 'A dog sat on the rug.' }];
  assert.deepEqual(merge3(BASE, now, sug), { text: now, overlaps: want });
});

test('a change to another paragraph is kept beside it, even next door', () => {
  const now = doc('The cat sat on the mat and looked at dog.', 'Second paragraph changed.');
  assert.deepEqual(merge3(BASE, now, doc(BASE.split('\n')[2], 'Second paragraph here, edited.')).overlaps.length, 1);
  // A rewrite elsewhere lands; the drafts' change next door stays.
  assert.deepEqual(merge3(BASE, now, doc('The cat sat on the mat and looked at dog.', 'Second paragraph changed.')).overlaps, []);
});

test('a paragraph removed from the drafts and edited in the suggestion: shown empty, and stays removed', () => {
  const base = '# T\n\nOne.\n\nTwo words here.\n\nThree.\n';
  const now = '# T\n\nOne.\n\nThree.\n';
  const sug = '# T\n\nOne.\n\nTwo more words here.\n\nThree.\n';
  const r = merge3(base, now, sug);
  assert.deepEqual(r.overlaps.map((o) => [o.base, o.current, o.suggested]), [['Two words here.', '', 'Two more words here.']]);
  assert.equal(r.text, now);
});

test('no overlap ever brings back words the drafts changed: hard-wrapped paragraph, the same word edited on both sides', () => {
  // platform-test-book, 14 Oct: the author changed "misspelling," and "definately"; the reader "definately".
  const base = 'Placeholder text.\nmisspelling, which is definately wrong.\n';
  const now = 'Placeholder text.\nmisspelling; which is definitively wrong.\n';
  const sug = 'Placeholder text.\nmisspelling, which is definitely wrong.\n';
  const r = merge3(base, now, sug);
  assert.equal(r.text, now);
  assert.deepEqual(r.overlaps, [{ line: 1, base: 'misspelling, which is definately wrong.', current: 'misspelling; which is definitively wrong.', suggested: 'misspelling, which is definitely wrong.' }]);
  // A suggestion several paragraphs long, overlapping in one: that one's old text is in `base`.
  const b2 = 'A one.\n\nB two.\n\nC three.\n';
  const r2 = merge3(b2, 'A one.\n\nB 2.\n\nC three.\n', 'A one.\n\nB deux.\n\nNew.\n\nC three.\n');
  assert.equal(r2.text, 'A one.\n\nB 2.\n\nC three.\n');
  assert.deepEqual(r2.overlaps.map((o) => [o.base, o.current]), [['B two.', 'B 2.']]);
});

test('the same edit on both sides, or none, is no overlap', () => {
  const now = doc('The cat sat on the mat and looked at dog.');
  assert.deepEqual(merge3(BASE, now, now), { text: now, overlaps: [] });
  assert.deepEqual(merge3(BASE, now, BASE), { text: now, overlaps: [] });
});
