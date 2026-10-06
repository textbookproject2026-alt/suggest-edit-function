/**
 * The author's console, as the author site shows it: reader suggestions, draft
 * changes and going live. Ported from the desktop app's app/console.py, keeping its
 * wording and its rules; the only change is that every reply, merge message and
 * publish description names the author who acted ("by @login via the author site"),
 * because the App, not the author's own account, now does the writing.
 *
 * Pure: no GitHub calls. api/author-read.js and api/author-act.js make those.
 */
import { byline } from './author.mjs';

export const SUGGESTED = 'suggested-edit';
export const NEEDS_TRIAGE = 'needs-triage';
// A suggestion the author has taken on but not yet made: it stays open, labelled,
// until a commit on drafts holds the change.
export const ACCEPTED = 'accepted';
export const ACCEPTED_LABEL = { [ACCEPTED]: { color: '0e8a16', description: 'Taken on by the author; not yet made' } };

// --- what the reader is told ---------------------------------------------------
//
// A reply says the chapter was changed only when a commit holds the change, and then
// it links that commit. The endpoints check every reply with claimsChange.

const signed = (identity) => `\n\n_Replied ${byline(identity)}._`;

export function thanksWithChange(url, identity) {
  if (!url) throw new Error('A reply saying the chapter changed must link the change.');
  return 'Thank you for this — it has been taken on board, and the chapter has '
    + `been changed in the drafts: ${url}\n\nIt reaches readers the next time the book goes live.${signed(identity)}`;
}

export const takenOn = (identity) =>
  'Thank you for this — it has been read and taken on board. The chapter hasn\'t been changed yet: '
  + 'the author will make the change by hand, and this suggestion stays open until they have.' + signed(identity);

export const declined = (identity) =>
  'Thank you for taking the time to send this. After a look, the text is going to stay as it is for now '
  + '— but the suggestion was read and appreciated, and please do send more.' + signed(identity);

const CLAIMS_CHANGE = /\b(?:chapter|page|text)\b[^.]{0,40}?\b(?:has|have|was|were|is)\s+(?:now\s+)?(?:been\s+)?(?:updated|changed|fixed|corrected|amended)\b/i;

/** Whether a reply tells the reader the chapter itself was changed. */
export const claimsChange = (text) => CLAIMS_CHANGE.test(text ?? '');

/** The rule every reply is held to before it is sent. */
export function checkReply(reply, commitUrl = '') {
  if (claimsChange(reply) && !(commitUrl && reply.includes(commitUrl))) {
    throw new Error('a reply claiming a change must link the commit that holds it');
  }
}

// --- reading a suggestion ------------------------------------------------------

function fencedBlock(body, heading) {
  const at = body.indexOf(heading);
  if (at === -1) return '';
  const m = /^(`{3,})[^\n]*\n([\s\S]*?)^\1\s*$/m.exec(body.slice(at + heading.length));
  return m ? m[2].replace(/\n+$/, '') : '';
}

/** 'chapters/chapter-03.md' -> 'chapter-03'. */
export function pageName(path) {
  if (!path) return 'an unknown page';
  return path.split('/').pop().replace(/\.[^.]+$/, '');
}

const labelsOf = (item) => new Set((item?.labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name)));

/** A reader suggestion (an issue suggest-edit filed), or null if the issue isn't one. */
export function parseSuggestion(issue) {
  if (!issue || issue.pull_request || !labelsOf(issue).has(SUGGESTED)) return null;
  const body = issue.body ?? '';
  let path = /^\s*Suggested edit:\s*(.+?)\s*$/.exec(issue.title ?? '')?.[1] ?? '';
  if (!path) path = /\*\*File:\*\*\s*\[`([^`]+)`\]/.exec(body)?.[1]?.trim() ?? '';
  const who = /\*\*Submitted by:\*\*\s*`([^`]*)`/.exec(body)?.[1]?.trim() ?? '';
  return {
    number: issue.number,
    who: who || 'someone who did not leave a name',
    path,
    page: pageName(path),
    suggestion: fencedBlock(body, '### Suggested edit'),
    reasoning: fencedBlock(body, '### Reasoning'),
    when: issue.created_at ?? null,
    url: issue.html_url ?? '',
    open: issue.state === 'open',
    accepted: labelsOf(issue).has(ACCEPTED),
  };
}

// --- draft changes -------------------------------------------------------------

export const MAX_READABLE_LINES = 60;
export const MAX_READABLE_PAGES = 5;

function proseLines(patch) {
  const out = [];
  for (const raw of (patch ?? '').split('\n')) {
    if (raw.startsWith('@@') || raw.startsWith('---') || raw.startsWith('+++')) continue;
    if (raw.startsWith('+')) out.push({ kind: 'after', text: raw.slice(1) });
    else if (raw.startsWith('-')) out.push({ kind: 'before', text: raw.slice(1) });
  }
  return out;
}

/** A change's files as before/after lines, or a refusal to print a wall of text. */
export function readableChange(files) {
  const total = files.reduce((n, f) => n + (Number(f.changes) || 0), 0);
  const pages = files.map((f) => ({
    page: pageName(f.filename ?? ''),
    path: f.filename ?? '',
    added: Number(f.additions) || 0,
    removed: Number(f.deletions) || 0,
    lines: proseLines(f.patch),
  }));
  if (total > MAX_READABLE_LINES || files.length > MAX_READABLE_PAGES) {
    return {
      readable: false,
      why: `This is a large change — ${total} lines across ${files.length} page${files.length === 1 ? '' : 's'}. It is easier to read on GitHub.`,
      pages: pages.map(({ lines, ...p }) => ({ ...p, lines: [] })),
    };
  }
  return { readable: true, why: '', pages };
}

export function describeChange(pr) {
  return {
    number: pr.number,
    who: pr.user?.login ?? 'someone',
    title: pr.title ?? 'Untitled change',
    when: pr.created_at ?? null,
    url: pr.html_url ?? '',
  };
}

// --- going live ----------------------------------------------------------------

export const PUBLISH_TITLE = 'Publish the drafts to the live book';

const PUBLISH_INTRO =
  'Everything now waiting in the drafts area, gathered so that it can go to readers in one go.\n\n'
  + 'This is not only the change that was accepted most recently. The drafts area also holds anything '
  + 'published from the browser editor, so what follows is the drafts area exactly as it stood when this '
  + 'description was last rewritten. Merging this is what publishes it; until then nothing here has reached a reader.';

export const PUBLISH_NOT_OPEN =
  'There is work in the drafts area that has not been put in line for the live book yet. '
  + 'Press “Put it in line” and it will be.';

export const PUBLISHED_STEPS = [
  'The drafts were sent to the live book.',
  'The site rebuilds itself from there, which takes a few minutes. Readers see the change once it has.',
  'The drafts area and the live book now hold the same text, so you can carry on in the drafts area straight away.',
];

const MAX_LISTED = 40;

function commitAuthor(c) {
  return c.author?.login || c.commit?.author?.name || 'someone';
}

/** The publish request's description: the drafts area as it stands, and who last put it in line. */
export function publishRequestBody(compare, identity) {
  const files = (compare?.files ?? []).filter((f) => f && typeof f === 'object');
  const commits = (compare?.commits ?? []).filter((c) => c && typeof c === 'object');
  const out = [PUBLISH_INTRO];
  if (files.length) {
    out.push('', `**Pages this would change (${files.length})**`, '');
    for (const f of files.slice(0, MAX_LISTED)) out.push(`- \`${f.filename ?? ''}\` — ${Number(f.additions) || 0} added, ${Number(f.deletions) || 0} removed`);
    if (files.length > MAX_LISTED) out.push(`- …and ${files.length - MAX_LISTED} more`);
  }
  if (commits.length) {
    out.push('', `**What is in the drafts area (${commits.length})**`, '');
    for (const c of commits.slice(-MAX_LISTED)) {
      const subject = String(c.commit?.message ?? '').split('\n')[0].trim() || 'an untitled change';
      out.push(`- ${subject} — ${commitAuthor(c)}`);
    }
    if (commits.length > MAX_LISTED) out.push(`- …and ${commits.length - MAX_LISTED} older`);
  }
  out.push('', `_Put in line ${byline(identity)}; this description is rewritten each time._`);
  return out.join('\n');
}

export const PUBLISH_STATE_WORDS = {
  clean: 'This can go to readers now. Nothing else is waiting on it.',
  conflict:
    'This cannot be published as it stands: the same wording has been changed both in the drafts area and in '
    + 'the live book, and the author site will not choose between them. Nothing was lost and nothing has been '
    + 'undone — open it on GitHub to settle which wording wins, then check back here.',
  blocked: 'This is waiting on the book\'s own checks before it can go to readers. That usually takes a few minutes; press “Check again” shortly.',
  unknown: 'Whether this can go to readers is still being worked out. It is safely in the drafts area either way — press “Check again” in a moment.',
};

/** GitHub's answer about a pull request, as "clean", "conflict", "blocked" or "unknown". Never guesses. */
export function mergeState(pr) {
  if (pr?.mergeable === false) return 'conflict';
  if (pr?.mergeable === true) return ['blocked', 'draft'].includes(pr.mergeable_state) ? 'blocked' : 'clean';
  return 'unknown';
}

/** "**" and "*" globs, as the builder's ignorePatterns use them. */
const globRe = (glob) => new RegExp(`^${glob
  .replace(/[.+^${}()|[\]\\]/g, '\\$&')
  .replace(/\*\*\//g, '\u0000')
  .replace(/\*\*/g, '.*')
  .replace(/\*/g, '[^/]*')
  .replace(/\u0000/g, '(?:.*/)?')}$`);

/** The served marker's `serves` rule, if it is one; anything else is null. */
export function servesRule(marker) {
  const s = marker?.serves;
  const strings = (a) => Array.isArray(a) && a.every((x) => typeof x === 'string' && x);
  return s && strings(s.paths) && strings(s.except ?? []) ? { paths: s.paths, except: s.except ?? [] } : null;
}

/** Whether the builder turns this repo path into part of the site, by its own rule. */
export function servedBy(rule, path) {
  if (!rule.paths.some((p) => path === p || path.startsWith(`${p}/`))) return false;
  return !rule.except.some((g) => globRe(g).test(path));
}

/**
 * The changed files, split by what readers will see: `reader` (page names, as
 * `pages`) and `behind` (paths, e.g. docs/, .github/). With no rule (a site built
 * before the builder said what it serves) everything stays under `reader`.
 */
export function splitByServed(files, rule) {
  const paths = files.map((f) => f.filename ?? '');
  if (!rule) return { reader: paths.map(pageName), behind: [], split: false };
  return {
    reader: paths.filter((p) => servedBy(rule, p)).map(pageName),
    behind: paths.filter((p) => !servedBy(rule, p)),
    split: true,
  };
}

export function describePublish(pr, compare, state, rule = null) {
  const files = (compare?.files ?? []).filter((f) => f && typeof f === 'object');
  const commits = (compare?.commits ?? []).filter((c) => c && typeof c === 'object');
  const who = [...new Set(commits.map(commitAuthor))];
  return {
    open: true,
    waiting: false,
    number: pr.number,
    url: pr.html_url ?? '',
    when: pr.created_at ?? null,
    pages: files.map((f) => pageName(f.filename ?? '')),
    ...splitByServed(files, rule),
    page_count: files.length,
    change_count: commits.length,
    who,
    state,
    state_words: PUBLISH_STATE_WORDS[state] ?? PUBLISH_STATE_WORDS.unknown,
    can_publish: state === 'clean',
  };
}

/** Work in drafts with no publish request open: said out loud, not left as a shut door. */
export function notOpen(compare) {
  return {
    open: false, waiting: true, number: null, url: '',
    page_count: (compare?.files ?? []).length, pages: [],
    change_count: Number(compare?.ahead_by) || 0, who: [],
    state: 'not_open', state_words: PUBLISH_NOT_OPEN, can_publish: false,
  };
}
