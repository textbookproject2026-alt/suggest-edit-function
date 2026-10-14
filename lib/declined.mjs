/**
 * Declined reader items (batch 2c, Part A): a proposal (pull request), note or
 * suggestion (issue) the authors closed without taking it. Public in the book's
 * history with the reason, who declined it, and the book's people's comments.
 *
 * The App writes two kinds of comment, each with a machine-readable marker the
 * readers below trust only when the App itself wrote the comment:
 *   <!-- tb-declined {"member":"m-…","name":"…","reason":"…"} -->   the reason
 *   <!-- tb-comment {"member":"m-…","name":"…","text":"…"} -->      a member's comment
 * The JSON is the record (nothing is parsed out of the visible Markdown); every ">"
 * in it is written >, so it can never end the HTML comment early.
 *
 * Items declined before this (the backfill): the reason is the last comment by one
 * of the book's people (its registry authors) or the platform's maintainer, and who
 * declined it is the author-site byline in the App's old reply, else whoever closed it.
 */
import { REGISTRY, gh, ghJson, graphqlRepo } from './author.mjs';
import { PLATFORM_OWNER } from './author-people.mjs';

/** ISO dates and times, newest first. Not localeCompare: its first call in an isolate
 *  sets up ICU's collator, about 8 ms of CPU on a request (13 Oct), for an order that
 *  plain comparison of these strings already gives. */
export const newestFirst = (a, b) => (a < b ? 1 : a > b ? -1 : 0);

export const READER_APP_LOGIN = 'textbook-suggest-edit[bot]';
export const REASON_MIN = 10;
export const TEXT_MAX = 1000;
export const COMMENT_MIN = 2;
/** Never shown as declined: no-credit items, the platform's own tests, and a proposal
 *  accepted in part (closed unmerged, but its accepted parts are in the drafts: lib/review.mjs). */
export const EXCLUDE_LABELS = ['no-credit', 'platform-test', 'accepted-in-part'];
const KIND_LABELS = { 'proposed-edit': 'edit', 'section-note': 'note', 'suggested-edit': 'suggestion' };
const MAX_ITEMS = 100;
const MAX_NAME = 80;
const MAX_SUMMARY = 200;

/** The platform's own account, bots and test identities (registry platform.automation_*): never shown as a person. */
const AUTOMATION = new Set(
  [PLATFORM_OWNER, ...(REGISTRY.platform?.automation_logins ?? []), ...(REGISTRY.platform?.automation_identities ?? [])].map((x) => String(x).toLowerCase()),
);
const isAutomationName = (k) => /\[bot\]/i.test(k) || AUTOMATION.has(String(k).trim().toLowerCase());
/** Who sent a reader item, as history shows them: null (so "a reader") for the platform's account or automation. */
export const readerOrNull = (who) => (who && ![who.name, who.github].some((k) => k && isAutomationName(k)) ? who : null);

const labelsOf = (it) => new Set((it.labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name)));
/** A reader item's kind, or null: a note is labelled suggested-edit too, so note wins. */
export function kindOf(it) {
  const l = labelsOf(it);
  if (l.has('section-note')) return 'note';
  if (it.pull_request || it.head) return l.has('proposed-edit') ? 'edit' : null;
  return l.has('suggested-edit') ? 'suggestion' : null;
}

/**
 * What a member typed, made safe to post publicly and to keep in a marker: one
 * paragraph break at most in a row, no HTML comment delimiters, @mentions that
 * don't ping anyone. Throws a message for the author when it is too short or long.
 */
export function cleanText(text, min = REASON_MIN) {
  const s = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/<!--|-->/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (s.length < min) return { error: `Please write at least ${min} characters.` };
  if (s.length > TEXT_MAX) return { error: `Please keep it to ${TEXT_MAX} characters.` };
  return { text: s };
}

const quote = (s) => s.replace(/@/g, '@​').split('\n').map((l) => `> ${l}`.trimEnd()).join('\n');
const marker = (tag, data) => `<!-- ${tag} ${JSON.stringify(data).replace(/>/g, '\\u003e')} -->`;
const nameOf = (identity) => (identity.name || identity.login).replace(/[*_`[\]]/g, '').slice(0, MAX_NAME);

/** The decline comment: the reason, publicly, under the member's display name. */
export function declineComment(reason, identity) {
  const name = nameOf(identity);
  return [
    marker('tb-declined', { member: identity.login, name, reason }),
    `**Declined by ${name}** (via the author site). The reason:`,
    '',
    quote(reason),
  ].join('\n');
}

/** A member's comment on a declined item. */
export function memberComment(text, identity) {
  const name = nameOf(identity);
  return [marker('tb-comment', { member: identity.login, name, text }), `**${name}** (via the author site):`, '', quote(text)].join('\n');
}

function readMarker(comment, tag) {
  if (comment?.user?.login !== READER_APP_LOGIN) return null;
  const m = new RegExp(`^<!-- ${tag} (\\{.*?\\}) -->`).exec(String(comment.body ?? ''));
  if (!m) return null;
  try {
    const d = JSON.parse(m[1]);
    return d && typeof d === 'object' ? d : null;
  } catch {
    return null;
  }
}
export const declineOf = (c) => readMarker(c, 'tb-declined');
export const commentOf = (c) => readMarker(c, 'tb-comment');

const short = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const fenced = (body, heading) => {
  const m = new RegExp(`^### ${heading}\\n\\n(\`{3,})text\\n([\\s\\S]*?)\\n\\1`, 'm').exec(body);
  return m ? m[2].replace(/\s+/g, ' ').trim() : '';
};

/** "**Proposed by:** …" / "**Submitted by:** …": who sent it, as the item already says publicly. */
export function proposerOf(body) {
  const signed = /^\*\*(?:Proposed|Submitted) by:\*\* @([A-Za-z0-9-]{1,39}) \(signed in with GitHub\)/m.exec(body);
  if (signed) return { name: signed[1], github: signed[1] };
  const named = /^\*\*(?:Proposed|Submitted) by:\*\* (`+) ?(.+?) ?\1/m.exec(body);
  const name = named?.[2].replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
  return name ? { name } : null;
}

/** The old author-site byline in an App reply: "by @login via the author site" or "by Name (member m-…) via …". */
function bylineName(body) {
  const m = /\bby (?:@([A-Za-z0-9-]{1,39})|(.{1,80}?) \(member m-[0-9a-f]{10}\)) via the author site/.exec(String(body ?? ''));
  return m ? (m[1] ?? m[2]) : null;
}

/**
 * One declined item, public fields only. `comments` are the item's issue comments
 * (oldest first); `people` the logins whose comments count as the reason when the
 * App left none (the book's authors and the maintainer, lower-cased).
 */
export function declinedItem(it, comments, people) {
  const body = String(it.body ?? '');
  const kind = kindOf(it);
  let decline = null;
  for (const c of comments) {
    const d = declineOf(c);
    if (d && typeof d.reason === 'string') decline = { d, at: c.created_at };
  }
  const notes = comments
    .map((c) => ({ c, d: commentOf(c) }))
    .filter(({ d }) => d && typeof d.text === 'string')
    .map(({ c, d }) => ({ id: c.id, member: String(d.member ?? ''), name: String(d.name ?? '').slice(0, MAX_NAME), date: c.created_at, text: d.text.slice(0, TEXT_MAX) }));
  let reason = decline?.d.reason ?? null;
  let decliner = decline ? String(decline.d.name ?? '').slice(0, MAX_NAME) || null : null;
  if (!decline) {
    const said = comments.filter((c) => people.has(String(c.user?.login ?? '').toLowerCase()) && String(c.body ?? '').trim());
    reason = said.at(-1)?.body.trim().slice(0, TEXT_MAX) ?? null;
    const app = comments.filter((c) => c.user?.login === READER_APP_LOGIN).map((c) => bylineName(c.body)).filter(Boolean);
    const closer = it.closed_by?.type === 'Bot' ? null : it.closed_by?.login;
    decliner = app.at(-1) ?? closer ?? null;
  }
  const files = [...body.matchAll(/^\*\*File:\*\* \[`([^`]+)`\]/gm)].map((m) => m[1]);
  const para = /^\*\*Where:\*\* (?:\[)?¶(\d+)/m.exec(body)?.[1];
  const summary = kind === 'edit'
    ? fenced(body, 'Summary') || String(it.title ?? '').replace(/^(?:Update|Edit ¶\d+ of) [^:]+: /, '')
    : fenced(body, 'Suggested edit') || String(it.title ?? '');
  return {
    kind,
    number: it.number,
    url: it.html_url,
    proposed: String(it.created_at ?? '').slice(0, 10),
    date: String(it.closed_at ?? '').slice(0, 10),
    summary: short(summary === '(no summary given)' ? String(it.title ?? '') : summary, MAX_SUMMARY),
    who: readerOrNull(proposerOf(body)),
    files,
    ...(para ? { paragraph: Number(para) } : {}),
    reason,
    // Whoever acted in the author site, by their member name; never the platform's account.
    decliner: decliner && !isAutomationName(decliner) ? decliner : null,
    comments: notes,
  };
}

/** The logins whose comments count as a reason for an item declined before batch 2c. */
export function peopleOf(book) {
  const entry = REGISTRY.books.find((b) => b.slug === book.slug) ?? book;
  return new Set([...(entry.authors ?? []), PLATFORM_OWNER].map((l) => String(l).toLowerCase()));
}

/** Declined: a pull request closed unmerged, or an issue closed as not planned. */
export const isDeclined = (it) =>
  it.state === 'closed' && (it.pull_request ? !it.pull_request.merged_at : it.state_reason === 'not_planned');

/** A GraphQL login as REST writes it: an App is "<slug>[bot]". */
const restUser = (a) => (a ? { login: a.__typename === 'Bot' ? `${a.login}[bot]` : a.login, type: a.__typename === 'Bot' ? 'Bot' : 'User' } : null);

/** A GraphQL issue or pull request node in the REST shape kindOf, isDeclined and declinedItem read. */
function restItem(n, pull) {
  return {
    number: n.number,
    html_url: n.url,
    title: n.title,
    body: n.body,
    state: 'closed',
    created_at: n.createdAt,
    closed_at: n.closedAt,
    updated_at: n.updatedAt,
    labels: n.labels?.nodes ?? [],
    ...(pull ? { pull_request: { merged_at: null } } : { state_reason: n.stateReason ? n.stateReason.toLowerCase() : null }),
    closed_by: restUser(n.timelineItems?.nodes?.[0]?.actor),
  };
}

const LISTED = 'number updatedAt labels(first: 20) { nodes { name } }';
const FULL = `number url title body createdAt closedAt updatedAt labels(first: 20) { nodes { name } }
  timelineItems(itemTypes: [CLOSED_EVENT], last: 1) { nodes { ... on ClosedEvent { actor { __typename login } } } }
  comments(first: 100) { nodes { databaseId author { __typename login } body createdAt } }`;

/**
 * The book's declined items, newest decline first (at most MAX_ITEMS), in two GraphQL
 * queries whatever their number: the most recently updated closed issues and closed
 * (unmerged) pull requests with only what tells a declined reader item apart, then the
 * declined ones in full, with their comments and who closed them. Only the fields used
 * are read: on the Worker every 100 KB from GitHub costs CPU.
 */
export async function declinedItems(book, token, left) {
  const repo = book.content.repo;
  const order = `first: ${MAX_ITEMS}, orderBy: { field: UPDATED_AT, direction: DESC }`;
  const listed = await graphqlRepo(repo, `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) {
    issues(states: CLOSED, ${order}) { nodes { ${LISTED} stateReason } }
    pullRequests(states: CLOSED, ${order}) { nodes { ${LISTED} } }
  } }`, {}, token, left);
  const candidates = [
    ...(listed.issues?.nodes ?? []).map((n) => ({ n, pull: false })),
    ...(listed.pullRequests?.nodes ?? []).map((n) => ({ n, pull: true })),
  ].sort((a, b) => newestFirst(String(a.n.updatedAt), String(b.n.updatedAt))).slice(0, MAX_ITEMS);
  const found = candidates.filter(({ n, pull }) => {
    const it = restItem(n, pull);
    return kindOf(it) && isDeclined(it) && !EXCLUDE_LABELS.some((l) => labelsOf(it).has(l));
  });
  if (!found.length) return [];
  const full = await graphqlRepo(repo, `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) {
    ${found.map(({ n, pull }) => `${pull ? 'p' : 'i'}${n.number}: ${pull ? 'pullRequest' : 'issue'}(number: ${Number(n.number)}) { ${FULL}${pull ? '' : ' stateReason'} }`).join('\n    ')}
  } }`, {}, token, left);
  const people = peopleOf(book);
  const items = found.map(({ n, pull }) => {
    const node = full[`${pull ? 'p' : 'i'}${n.number}`];
    const comments = (node?.comments?.nodes ?? []).map((c) => ({ id: c.databaseId, user: restUser(c.author), body: c.body, created_at: c.createdAt }));
    return declinedItem(restItem(node ?? n, pull), comments, people);
  });
  return items.sort((a, b) => newestFirst(a.date, b.date) || b.number - a.number);
}

/** A file's text at `ref` ("" when it isn't there). */
export async function textAt(repo, path, ref, token, left) {
  const res = await gh(`/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${ref}`, token, left, { allow: [404] });
  if (res.status === 404) return '';
  const file = await res.json();
  if (file?.type !== 'file' || typeof file.content !== 'string') return '';
  return Buffer.from(file.content, 'base64').toString('utf8').replace(/\r\n/g, '\n');
}

/**
 * A declined proposal's change, read from the pull request after its branch has
 * gone: GitHub keeps the head commit (refs/pull/n/head). Each file at the base the
 * proposal was made on and at its head.
 */
export async function declinedChange(book, number, token, left, read = textAt) {
  const repo = book.content.repo;
  const res = await gh(`/repos/${repo}/pulls/${number}`, token, left, { allow: [404] });
  if (res.status === 404) return null;
  const pr = await res.json();
  if (!pr || pr.merged_at || pr.state !== 'closed' || kindOf(pr) !== 'edit' || EXCLUDE_LABELS.some((l) => labelsOf(pr).has(l))) return null;
  const files = await ghJson(`/repos/${repo}/pulls/${number}/files?per_page=10`, token, left);
  const out = [];
  for (const f of (files ?? []).filter((x) => /\.md$/i.test(x.filename)).slice(0, 5)) {
    const [before, after] = await Promise.all([
      f.status === 'added' ? '' : read(repo, f.previous_filename ?? f.filename, pr.base.sha, token, left),
      f.status === 'removed' ? '' : read(repo, f.filename, pr.head.sha, token, left),
    ]);
    out.push({ path: f.filename, before, after });
  }
  return { number, files: out };
}
