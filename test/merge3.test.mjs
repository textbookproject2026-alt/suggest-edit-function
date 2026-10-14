import { test } from 'node:test';
import assert from 'node:assert/strict';
import { merge3 } from '../lib/merge3.mjs';

const doc = (p, q = 'Second paragraph here.') => `# T\n\n${p}\n\n${q}\n`;
const BASE = doc('The cat sat on mat and looked at dog.');

test('two fixes in different places of one paragraph both land', () => {
  const r = merge3(BASE, doc('The cat sat on the mat and looked at dog.'), doc('The cat sat on mat and looked at the dog.'));
  assert.deepEqual(r, { text: doc('The cat sat on the mat and looked at the dog.'), overlaps: [] });
});

test('changes to the same words overlap: kept as now, or the suggestion\'s paragraph when chosen', () => {
  const now = doc('The cat sat on the mat and looked at dog.');
  const sug = doc('A dog sat on the rug.');
  const want = [{ line: 2, current: 'The cat sat on the mat and looked at dog.', suggested: 'A dog sat on the rug.' }];
  assert.deepEqual(merge3(BASE, now, sug).overlaps, want);
  assert.equal(merge3(BASE, now, sug, { prefer: 'suggested' }).text, doc('A dog sat on the rug.'));
});

test('a change to another paragraph is kept beside it, even next door', () => {
  const now = doc('The cat sat on the mat and looked at dog.', 'Second paragraph changed.');
  assert.deepEqual(merge3(BASE, now, doc('A dog sat on the rug.'), { prefer: 'suggested' }).text, doc('A dog sat on the rug.', 'Second paragraph changed.'));
  assert.deepEqual(merge3(BASE, now, doc(BASE.split('\n')[2], 'Second paragraph here, edited.')).overlaps.length, 1);
});

test('a paragraph removed from the drafts and edited in the suggestion: shown empty, put back only when chosen', () => {
  const base = '# T\n\nOne.\n\nTwo words here.\n\nThree.\n';
  const now = '# T\n\nOne.\n\nThree.\n';
  const sug = '# T\n\nOne.\n\nTwo more words here.\n\nThree.\n';
  const r = merge3(base, now, sug);
  assert.deepEqual(r.overlaps.map((o) => [o.current, o.suggested]), [['', 'Two more words here.']]);
  assert.equal(r.text, now);
  assert.equal(merge3(base, now, sug, { prefer: 'suggested' }).text, sug);
});

test('the same edit on both sides, or none, is no overlap', () => {
  const now = doc('The cat sat on the mat and looked at dog.');
  assert.deepEqual(merge3(BASE, now, now), { text: now, overlaps: [] });
  assert.deepEqual(merge3(BASE, now, BASE), { text: now, overlaps: [] });
});
