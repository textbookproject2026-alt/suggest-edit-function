/**
 * The going-live list's split: what readers will see versus what the builder never
 * serves, by the rule the live site's marker states (quartz-book's SERVES).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { servedBy, servesRule, splitByServed, describePublish } from '../lib/author-console.mjs';

const RULE = servesRule({ serves: { paths: ['index.md', 'chapters', 'assets', 'glossary.md', 'community'], except: ['assets/**/*.md'] } });
const files = (...paths) => paths.map((filename) => ({ filename }));

test('served: the allowlisted names and everything under the folders, minus the excepted globs', () => {
  for (const p of ['index.md', 'glossary.md', 'chapters/chapter-01.md', 'chapters/Definitions/Concept.md', 'assets/chapter-01/fig.png', 'community/contributors.md'])
    assert.equal(servedBy(RULE, p), true, p);
  for (const p of ['docs/README.md', '.github/workflows/lint.yml', 'README.md', 'chapter-sources.json', 'textbook.config.json', 'assets/README.md', 'assets/chapter-01/notes.md', 'chapters.md', 'index.md.bak'])
    assert.equal(servedBy(RULE, p), false, p);
});

test('the list splits into reader pages and behind-the-scenes paths', () => {
  const s = splitByServed(files('chapters/chapter-02.md', 'docs/README.md', '.github/workflows/lint.yml', 'assets/ch/fig.png'), RULE);
  assert.deepEqual(s, { reader: ['chapter-02', 'fig'], behind: ['docs/README.md', '.github/workflows/lint.yml'], split: true });
});

test('no rule (a site built before the marker said): everything stays under reader, unsplit', () => {
  assert.equal(servesRule({ slug: 'x' }), null);
  assert.equal(servesRule({ serves: { paths: 'chapters' } }), null);
  assert.deepEqual(splitByServed(files('docs/README.md'), null), { reader: ['README'], behind: [], split: false });
});

test('describePublish keeps pages and adds the split', () => {
  const d = describePublish({ number: 3, html_url: 'u' }, { files: files('chapters/a.md', 'docs/b.md'), commits: [] }, 'clean', RULE);
  assert.deepEqual(d.pages, ['a', 'b']);
  assert.deepEqual([d.reader, d.behind, d.split], [['a'], ['docs/b.md'], true]);
});
