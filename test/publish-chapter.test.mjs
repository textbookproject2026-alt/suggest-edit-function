import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linksOf, resolve, withContentsLines } from '../lib/publish-chapter.mjs';

const index = (items, intro = '') => `# Book\n\n${intro}## Contents\n\n${items.map((p) => `- [[chapters/${p}|${p}]]`).join('\n')}\n`;

test('Contents: a moved chapter takes its drafts place; a new one goes after its nearest neighbour; the rest of the page stays live', () => {
  const live = index(['a', 'b', 'c'], 'Live intro.\n\n');
  const drafts = index(['b', 'a', 'd', 'c'], 'Drafts intro.\n\n');
  assert.equal(withContentsLines(live, drafts, ['chapters/a.md']), index(['b', 'a', 'c'], 'Live intro.\n\n'));
  assert.equal(withContentsLines(live, drafts, ['chapters/d.md']), index(['a', 'd', 'b', 'c'], 'Live intro.\n\n'), 'after a, its neighbour before it in the drafts');
  assert.equal(withContentsLines(live, index(['a', 'b', 'c']), ['chapters/b.md']), null, 'nothing to change');
});

test('links: pages, pictures and glossary anchors, resolved as the book resolves them', () => {
  const text = '---\ntitle: x\n---\nSee [[Realism]], [[glossary#Ontology|ontology]] and [ch 2](chapter-02.md).\n![[assets/ch/fig.png]] ![a](../assets/x.png)\n```\n[[not-a-link]]\n```\n';
  const l = linksOf(text);
  assert.deepEqual(l.pages, ['Realism', 'glossary', 'chapter-02.md']);
  assert.deepEqual(l.anchors, [{ target: 'glossary', anchor: 'Ontology' }]);
  assert.deepEqual(l.pictures, ['assets/ch/fig.png', '../assets/x.png']);
  const files = new Map([['chapters/Definitions/Realism.md', 1], ['glossary.md', 1], ['chapters/chapter-02.md', 1], ['assets/x.png', 1]]);
  assert.equal(resolve('Realism', 'chapters/chapter-01.md', files), 'chapters/Definitions/Realism.md');
  assert.equal(resolve('chapter-02.md', 'chapters/chapter-01.md', files), 'chapters/chapter-02.md');
  assert.equal(resolve('../assets/x.png', 'chapters/chapter-01.md', files, false), 'assets/x.png');
});
