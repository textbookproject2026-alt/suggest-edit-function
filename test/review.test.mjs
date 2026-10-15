import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptance, applyTicks, buildReview, rebase } from '../lib/review.mjs';

const BASE = '# Chapter\n\nThe cat sat on mat.\n\nDogs bark at night.\n\nBirds sing in the morning.\n';
const page = (a, b, c) => `# Chapter\n\n${a}\n\n${b}\n\n${c}\n`;
const edit = (number, suggested, extra = {}) => ({ number, who: `Reader ${number}`, title: `Edit ${number}`, url: '', base: BASE, suggested, ...extra });
const ids = (v, key) => v.items.find((i) => i.key === key).hunks;
const hunk = (v, id) => v.hunks.find((h) => h.id === id);

test('clean hunks from two proposals and an exact suggestion: one text with all of them', () => {
  const v = buildReview(BASE, {
    edits: [edit(1, page('The cat sat on the mat.', 'Dogs bark at night.', 'Birds sing in the morning.')),
      edit(2, page('The cat sat on mat.', 'Dogs bark at night.', 'Birds sing at dawn.'))],
    issues: [{ number: 9, who: 'Sam', suggestion: 'Dogs howl', original: 'Dogs bark', url: '' }],
  });
  const all = v.hunks.map((h) => h.id);
  assert.equal(all.length, 3);
  assert.ok(v.hunks.every((h) => !h.stale && !h.overlaps.length));
  const r = applyTicks(v, all);
  assert.equal(r.text, page('The cat sat on the mat.', 'Dogs howl at night.', 'Birds sing at dawn.'));
  assert.deepEqual([...acceptance(v, all).values()].map((a) => [a.item.key, a.all]), [['p1', true], ['p2', true], ['i9', true]]);
});

test('two proposals on one paragraph overlap: each names the other, and both together are refused', () => {
  const v = buildReview(BASE, { edits: [
    edit(1, page('The cat sat on the mat.', 'Dogs bark at night.', 'Birds sing in the morning.')),
    edit(2, page('A cat sat on mat.', 'Dogs bark at night.', 'Birds sing in the morning.')),
  ] });
  const [a] = ids(v, 'p1');
  const [b] = ids(v, 'p2');
  assert.deepEqual(hunk(v, a).overlaps, [b]);
  assert.deepEqual(hunk(v, b).overlaps, [a]);
  assert.equal(applyTicks(v, [a, b]).error, 'bad');
  assert.equal(applyTicks(v, [b]).text, page('A cat sat on mat.', 'Dogs bark at night.', 'Birds sing in the morning.'));
});

test('a hunk whose words the drafts changed since is stale: shown three ways; ticked, the suggestion\'s words replace the drafts\'', () => {
  const now = page('The cat sat upon mat.', 'Dogs bark at night.', 'Birds sing in the morning.');
  const v = buildReview(now, { edits: [edit(1, page('The cat sat over mat.', 'Dogs bark at night.', 'Birds sing at dawn.'))] });
  const [first, second] = ids(v, 'p1').map((id) => hunk(v, id));
  assert.ok(first.stale?.length);
  assert.equal(first.stale[0].current, 'The cat sat upon mat.');
  assert.ok(first.id.endsWith('-old'));
  assert.ok(!second.stale);
  assert.equal(applyTicks(v, [first.id]).text, page('The cat sat over mat.', 'Dogs bark at night.', 'Birds sing in the morning.'));
  // One batch: the stale part and the clean one together.
  assert.equal(applyTicks(v, [first.id, second.id]).text, page('The cat sat over mat.', 'Dogs bark at night.', 'Birds sing at dawn.'));
  assert.equal(acceptance(v, [first.id, second.id]).get('p1').all, true);
  // Untouched, it is accepted only in part.
  assert.equal(acceptance(v, [second.id]).get('p1').all, false);
});

test('a whole-page proposal accepted in part: only the ticked paragraphs change', () => {
  const v = buildReview(BASE, { edits: [edit(1, page('The cat sat on the mat.', 'Dogs bark loudly at night.', 'Birds sing at dawn.'))] });
  const hs = ids(v, 'p1');
  assert.equal(hs.length, 3);
  const r = applyTicks(v, [hs[0], hs[2]]);
  assert.equal(r.text, page('The cat sat on the mat.', 'Dogs bark at night.', 'Birds sing at dawn.'));
  const a = acceptance(v, [hs[0], hs[2]]).get('p1');
  assert.equal(a.all, false);
  assert.equal(a.ticked.length, 2);
});

test('the drafts moved: ticks still good are kept, the rest named', () => {
  const sug = edit(1, page('The cat sat on the mat.', 'Dogs bark at night.', 'Birds sing at dawn.'));
  const before = buildReview(BASE, { edits: [sug] });
  const [h1, h2] = ids(before, 'p1');
  // A second tab saved: the first paragraph's same words changed, the third not.
  const moved = buildReview(page('The cat sat on a mat.', 'Dogs bark at night.', 'Birds sing in the morning.'), { edits: [sug] });
  // The clean one keeps its id; the one the drafts changed under is a different, stale choice now.
  assert.deepEqual(ids(moved, 'p1'), [`${h1}-old`, h2]);
  assert.deepEqual(rebase(moved, [h1, h2, 'p7-gone']), {
    kept: [h2],
    invalid: [{ id: h1, why: 'its paragraph changed in the drafts since' }, { id: 'p7-gone', why: 'it is no longer there to accept' }],
  });
});

test('an empty batch is refused', () => {
  const v = buildReview(BASE, { edits: [edit(1, page('The cat sat on the mat.', 'Dogs bark at night.', 'Birds sing in the morning.'))] });
  assert.equal(applyTicks(v, []).error, 'none');
});

test('notes sit beside their paragraph; a suggestion no longer word for word in the drafts is stale', () => {
  const v = buildReview(BASE, { issues: [
    { number: 3, who: 'A', note: true, quote: 'Dogs bark at…', suggestion: 'Which dogs?', original: '', url: '' },
    { number: 4, who: 'B', suggestion: 'Fish swim.', original: 'Fish float.', url: '' },
    { number: 5, who: 'C', suggestion: 'Rewrite the whole page.', original: '', url: '' },
  ] });
  assert.deepEqual(v.notes.map((n) => [n.item, n.at, n.quote]), [['i3', 2, 'Dogs bark at'], ['i5', -1, '']]);
  assert.ok(hunk(v, 'i4-old').lost, 'no paragraph like it: nothing to put it in');
  // Like a paragraph still there: ticked, the suggestion replaces that paragraph.
  const w = buildReview(BASE, { issues: [{ number: 6, who: 'D', suggestion: 'Dogs howl at night.', original: 'Dogs bark loudly at night.', url: '' }] });
  assert.equal(applyTicks(w, ['i6-old']).text, BASE.replace('Dogs bark at night.', 'Dogs howl at night.'));
});
