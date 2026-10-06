/**
 * A book's own markdownlint, run here exactly as its lint workflow runs it
 * (markdownlint-cli2-action@v20 = markdownlint-cli2 0.18.1 = markdownlint 0.38.0):
 * every *.md in the repo at one commit, with the repo's .markdownlint-cli2.yaml
 * (its `config`, and its `ignores`). Publishing stops on any problem it finds
 * (author-act's publish), so a red lint never reaches readers through the author
 * site, and needs no check-run permission: the files are read like any other.
 *
 * The author site runs the same version in the browser before Send (site/lib/lint.js).
 */
import { lint } from 'markdownlint/promise';
import yaml from 'js-yaml';
import { ghJson, blobBytes } from './author.mjs';
import { globRe } from './author-console.mjs';

export const CONFIG_FILE = '.markdownlint-cli2.yaml';
const ALWAYS_IGNORED = ['node_modules/**'];
const MAX_FILES = 300;

// Blobs are content-addressed and results are per commit: a warm instance keeps them.
const blobCache = new Map();
const resultCache = new Map();

/** markdownlint's own options from a .markdownlint-cli2.yaml's text (none: markdownlint's defaults). */
export function parseConfig(text) {
  const doc = text ? yaml.load(text) ?? {} : {};
  return { config: doc.config ?? { default: true }, ignores: [...ALWAYS_IGNORED, ...(doc.ignores ?? [])] };
}

/** Lints { path: text } with a parsed config. -> [{ path, line, rule, description, detail, fixable }] */
export async function lintTexts(texts, { config, ignores }) {
  const skip = ignores.map(globRe);
  const strings = Object.fromEntries(Object.entries(texts).filter(([p]) => !skip.some((re) => re.test(p))));
  const results = await lint({ strings, config, handleRuleFailures: true });
  const out = [];
  for (const [path, errors] of Object.entries(results)) {
    for (const e of errors) {
      out.push({ path, line: e.lineNumber, rule: e.ruleNames[0], description: e.ruleDescription, detail: e.errorDetail ?? '', fixable: Boolean(e.fixInfo) });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
}

/** The book's lint at `sha` (a commit): { problems, files } or null if it can't be read in time. */
export async function lintBook(book, sha, token, left) {
  const key = `${book.content.repo}@${sha}`;
  if (resultCache.has(key)) return resultCache.get(key);
  const repo = book.content.repo;
  const commit = await ghJson(`/repos/${repo}/git/commits/${sha}`, token, left);
  const tree = await ghJson(`/repos/${repo}/git/trees/${commit.tree.sha}?recursive=1`, token, left);
  if (tree.truncated) return null;
  const blobs = (tree.tree ?? []).filter((e) => e.type === 'blob');
  const cfgEntry = blobs.find((e) => e.path === CONFIG_FILE);
  // "**/*.md" as the workflow globs it: no dot-folders (.github/…), as globby leaves them out.
  const md = blobs.filter((e) => /\.md$/i.test(e.path) && !e.path.split('/').some((p) => p.startsWith('.'))).slice(0, MAX_FILES);
  const text = async (e) => {
    if (!blobCache.has(e.sha)) blobCache.set(e.sha, (await blobBytes(repo, e.sha, token, left)).toString('utf8'));
    return blobCache.get(e.sha);
  };
  const options = parseConfig(cfgEntry ? await text(cfgEntry) : '');
  const texts = {};
  for (let i = 0; i < md.length; i += 10) {
    await Promise.all(md.slice(i, i + 10).map(async (e) => { texts[e.path] = await text(e); }));
  }
  const out = { problems: await lintTexts(texts, options), files: Object.keys(texts).length };
  resultCache.set(key, out);
  if (resultCache.size > 200) resultCache.delete(resultCache.keys().next().value);
  return out;
}

/** One sentence for a refusal, naming the first few problems. */
export function lintWords(problems) {
  const pages = new Set(problems.map((p) => p.path)).size;
  const first = problems.slice(0, 3).map((p) => `${p.path} line ${p.line} (${p.description.toLowerCase()})`).join('; ');
  return `The drafts have ${problems.length} formatting ${problems.length === 1 ? 'problem' : 'problems'} in ${pages} ${pages === 1 ? 'page' : 'pages'}, `
    + `which must be put right before they go to readers: ${first}${problems.length > 3 ? '; and more' : ''}. `
    + 'Open each page on the author site, use Edit, and send the fix; nothing went live.';
}
