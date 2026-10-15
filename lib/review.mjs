/**
 * Review all in chapter (author site #/<book>/review/<path>): the chapter's drafts text
 * with every pending reader proposal on it merged in place, one hunk per changed
 * paragraph for the author to tick, and what accepting the ticked ones writes.
 *
 * Two kinds of item change the text:
 *   edit        an open proposed-edit pull request on this page. Each paragraph region
 *               it changed (against the drafts it started from) is merged on its own
 *               into the drafts as they are now (lib/merge3.mjs, three-way, word by
 *               word): one hunk. Where the drafts changed the same words since, the
 *               hunk is `stale` (the "made on an older version" view): ticked, the
 *               suggestion's copy of the paragraph replaces the drafts' (its id ends -old).
 *   suggestion  a written suggestion that quotes the whole text it started from (the ¶
 *               margin's box), found exactly once in one paragraph of the drafts: one hunk.
 * Notes (and suggestions with no exact place) are shown beside a paragraph, no tick.
 *
 * A hunk's id stays the same while its proposal and the words it changes do, so a view
 * rebuilt after the drafts moved keeps the ticks that are still good (`rebase`).
 *
 * Pure apart from `gather`, which reads everything in two GraphQL queries.
 */
import { graphqlRepo } from './author.mjs';
import { alike, hunks, merge3, paras, wordSet } from './merge3.mjs';
import { SUGGESTED, describeChange, isProposal, parseSuggestion } from './author-console.mjs';
import { proposerOf } from './declined.mjs';

export const ACCEPTED_IN_PART = 'accepted-in-part';
export const ACCEPTED_IN_PART_LABEL = { [ACCEPTED_IN_PART]: { color: 'c2e0c6', description: 'Some of it was accepted into the drafts; the reader is credited' } };

const fnv = (s) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
};
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const lf = (t) => (t ?? '').replace(/\r\n/g, '\n');

/** The paragraph of `P` holding line `line` (0-based). */
function paraAt(P, line) {
  let at = 0;
  for (let j = 0; j < P.length; j++) {
    const n = Math.max(1, (P[j].match(/\n/g) ?? []).length);
    if (line < at + n) return j;
    at += n;
  }
  return P.length;
}

/** Each paragraph's words, worked out once per review however many items ask. */
const lazily = (P, fn) => {
  const memo = [];
  return (j) => (memo[j] ??= fn(P[j]));
};

/** Text as a reader sees it, roughly: links as their words, lower case, punctuation as spaces. */
const plain = (t) => ` ${t.replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1').replace(/\[\[([^\]]*)\]\]/g, (_m, x) => x.split('/').pop())
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').toLowerCase().replace(/[^a-z0-9\u00c0-\uffff]+/g, ' ')} `;

/** The paragraph a quote is from (by the words a reader saw), or -1. */
function placeOf(P, lower, seen, quote) {
  const q = plain(quote.replace(/…$/, '')).slice(0, 80).replace(/ \S*$/, ' ');
  if (!q.trim()) return -1;
  // Only paragraphs holding its two longest words as written are made plain.
  const first = q.trim().split(' ').sort((a, b) => b.length - a.length).slice(0, 2);
  return P.findIndex((_p, j) => first.every((w) => lower(j).includes(w)) && seen(j).includes(q));
}

/** The paragraph of `P` most like `text`, or -1 (as merge3 pairs a paragraph that moved). */
function closest(P, sets, text) {
  const ws = wordSet(text);
  let best = 0.3;
  let at = -1;
  for (let j = 0; j < P.length; j++) {
    const s = alike(ws, sets(j));
    if (s > best) [best, at] = [s, j];
  }
  return at;
}

/** A suggestion's text put in for `original`, where that is in exactly one place: { at, to } or null. */
function exactly(P, original, suggestion) {
  const re = new RegExp(original.trim().split(/\s+/).map(escape).join('\\s+'), 'g');
  let found = null;
  for (let j = 0; j < P.length; j++) {
    const m = [...P[j].matchAll(re)];
    if (!m.length) continue;
    if (found || m.length > 1) return null; // in more than one place: which is unclear
    found = { at: j, to: P[j].slice(0, m[0].index) + suggestion.trim() + P[j].slice(m[0].index + m[0][0].length) };
  }
  return found;
}

/** One proposed edit's hunks against the drafts' paragraphs `P`. */
function editHunks(it, current, P) {
  const B = paras(it.base);
  const S = paras(it.suggested);
  const regions = hunks(B, S);
  const moved = hunks(B, P); // what the drafts changed since it started
  if (!regions || !moved) return null;
  const out = [];
  const seen = new Map();
  for (const r of regions) {
    const was = B.slice(r.lo, r.hi).join('');
    const now = S.slice(r.from, r.to).join('');
    let id = `p${it.number}-${fnv(`${was}\u0000${now}`)}`;
    const k = seen.get(id) ?? 0;
    seen.set(id, k + 1);
    if (k) id += `-${k}`;
    // The usual case: the drafts didn't touch these paragraphs, so they map straight across.
    if (!moved.some((c) => clash({ at: c.lo, end: c.hi }, { at: r.lo, end: r.hi }))) {
      const shift = moved.filter((c) => c.hi <= r.lo).reduce((n, c) => n + (c.to - c.from) - (c.hi - c.lo), 0);
      out.push({ id, item: it.key, at: r.lo + shift, end: r.hi + shift, from: P.slice(r.lo + shift, r.hi + shift).join(''), to: now });
      continue;
    }
    // Otherwise this region alone, merged into the drafts as they are now, word by word.
    const m = merge3(it.base, current, [...B.slice(0, r.lo), now, ...B.slice(r.hi)].join(''));
    if (m.overlaps.length) {
      out.push(staleHunk(`${id}-old`, it.key, P, m.overlaps));
      continue;
    }
    const M = paras(m.text);
    const d = hunks(P, M);
    if (!d?.length) {
      out.push({ id, item: it.key, already: true });
      continue;
    }
    const lo = Math.min(...d.map((x) => x.lo));
    const hi = Math.max(...d.map((x) => x.hi));
    out.push({ id, item: it.key, at: lo, end: hi, from: P.slice(lo, hi).join(''), to: M.slice(Math.min(...d.map((x) => x.from)), Math.max(...d.map((x) => x.to))).join('') });
  }
  return out;
}

/**
 * A region the drafts changed under the same words: its paragraphs as now, and what
 * ticking it puts there, the suggestion's copy of each (the drafts' words there go).
 */
function staleHunk(id, item, P, overlaps) {
  const rows = overlaps.map((o) => ({ j: paraAt(P, o.line), o }));
  const at = Math.min(...rows.map((r) => r.j));
  const end = Math.max(...rows.map((r) => r.j + (r.o.current ? 1 : 0)));
  const sep = (k) => /\n*$/.exec(P[k] ?? '')[0] || '\n\n';
  let to = '';
  for (let k = at; k <= end; k++) {
    // A paragraph removed from the drafts since: the suggestion's comes back in its place.
    for (const r of rows.filter((x) => x.j === k && !x.o.current && x.o.suggested)) to += `${r.o.suggested}\n\n`;
    if (k === end) break;
    const r = rows.find((x) => x.j === k && x.o.current);
    to += !r ? P[k] : r.o.suggested ? `${r.o.suggested}${sep(k)}` : '';
  }
  return { id, item, at, end, from: P.slice(at, end).join(''), to, stale: overlaps };
}

// `lost`: a written suggestion whose words are nowhere in the drafts now; nothing to put them in.
const tickable = (h) => !h.already && !h.lost;
// Ranges of paragraphs that share one, or an insertion at the other's edge (which goes first?).
function clash(a, b) {
  return (a.at < b.end && b.at < a.end) || ((a.at === a.end || b.at === b.end) && a.at <= b.end && b.at <= a.end);
}

/**
 * The review of one page. `current`: the drafts' text; `edits`: [{ number, who, title,
 * url, base, suggested } | { …, why }]; `issues`: parseSuggestion()s with `note`.
 * -> { paragraphs, items: [{ key, kind, number, who, title, url, hunks, why? }],
 *      hunks: [{ id, item, at, end, from, to, overlaps } | { id, item, at, stale } | { id, item, already }],
 *      notes: [{ item, at, text }] }
 */
export function buildReview(current, { edits = [], issues = [] }) {
  const P = paras(current);
  const seen = lazily(P, plain);
  const lower = lazily(P, (t) => t.toLowerCase());
  const sets = lazily(P, wordSet);
  const items = [];
  const all = [];
  const notes = [];
  for (const e of edits) {
    const it = { key: `p${e.number}`, kind: 'edit', number: e.number, who: e.who, title: e.title, summary: e.summary ?? '', url: e.url, hunks: [] };
    items.push(it);
    if (e.why || e.deferred) {
      // Deferred: read on its own (gather's `number`), and merged into the view by the page.
      Object.assign(it, e.why ? { why: e.why } : { deferred: true });
      continue;
    }
    const hs = editHunks({ ...e, key: it.key }, current, P);
    if (!hs) it.why = 'it changes too much of the page to show here';
    else {
      it.hunks = hs.map((x) => x.id);
      all.push(...hs);
    }
  }
  for (const s of issues) {
    const it = { key: `i${s.number}`, kind: s.note ? 'note' : 'suggestion', number: s.number, who: s.who, title: s.suggestion, summary: s.reasoning ?? '', url: s.url, hunks: [] };
    items.push(it);
    const ex = !s.note && s.original && s.suggestion.trim() !== s.original.trim() ? exactly(P, s.original, s.suggestion) : null;
    if (ex) {
      it.hunks = [`i${s.number}`];
      all.push({ id: `i${s.number}`, item: it.key, at: ex.at, end: ex.at + 1, from: P[ex.at], to: ex.to });
    } else if (!s.note && s.original) {
      // Its text isn't in the drafts word for word any more: the older-version view, on
      // the paragraph most like it; ticked, the suggestion replaces that paragraph.
      const at = closest(P, sets, s.original);
      const stale = [{ base: s.original, suggested: s.suggestion, current: at < 0 ? '' : P[at].trimEnd() }];
      it.hunks = [`i${s.number}-old`];
      all.push(at < 0 ? { id: `i${s.number}-old`, item: it.key, lost: true, stale }
        : { id: `i${s.number}-old`, item: it.key, at, end: at + 1, from: P[at], to: `${s.suggestion.trim()}${/\n*$/.exec(P[at])[0]}`, stale });
    } else {
      it.why = s.note ? 'a note to the authors' : 'it doesn’t say which words it replaces';
      notes.push({ item: it.key, at: s.quote ? placeOf(P, lower, seen, s.quote) : -1, text: s.suggestion });
    }
  }
  const live = all.filter(tickable);
  for (const a of live) {
    a.overlaps = live.filter((b) => b !== a && clash(a, b)).map((b) => b.id);
  }
  return { paragraphs: P, items, hunks: all, notes };
}

const word = { stale: 'its paragraph changed in the drafts since', gone: 'it is no longer there to accept' };
/** Why `id` isn't in `byId`: a clean edit the drafts have since changed under (now `id`-old), or gone. */
const missing = (byId, id) => (byId.has(`${id}-old`) ? word.stale : word.gone);

/**
 * The ticked hunks of `view` put into its text. -> { text, hunks } or { error, bad: [{ id, why }] }
 * Refused: none ticked, one that isn't there or can't be ticked, two that overlap.
 */
export function applyTicks(view, ids) {
  if (!ids.length) return { error: 'none', bad: [] };
  const byId = new Map(view.hunks.map((x) => [x.id, x]));
  const bad = [];
  const picked = [];
  for (const id of new Set(ids)) {
    const x = byId.get(id);
    if (!x || x.already || x.lost) bad.push({ id, why: x ? word.gone : missing(byId, id) });
    else if (picked.some((p) => clash(p, x))) bad.push({ id, why: 'it overlaps another ticked change' });
    else picked.push(x);
  }
  if (bad.length) return { error: 'bad', bad };
  const P = [...view.paragraphs];
  for (const x of [...picked].sort((a, b) => b.at - a.at || b.end - a.end)) P.splice(x.at, x.end - x.at, x.to);
  return { text: P.join(''), hunks: picked };
}

/** After the drafts moved: which of `ids` still hold in the rebuilt `view`, and why the rest don't. */
export function rebase(view, ids) {
  const byId = new Map(view.hunks.map((x) => [x.id, x]));
  const kept = [];
  const invalid = [];
  for (const id of new Set(ids)) {
    const x = byId.get(id);
    if (!x || x.already || x.lost) invalid.push({ id, why: x ? word.gone : missing(byId, id) });
    else if (kept.some((k) => clash(byId.get(k), x))) invalid.push({ id, why: 'it overlaps another ticked change' });
    else kept.push(id);
  }
  return { kept, invalid };
}

/**
 * Per item, what the ticks accept: 'all' (every hunk ticked or already in the drafts:
 * a proposal merged whole), 'some', or nothing.
 */
export function acceptance(view, ids) {
  const ticked = new Set(ids);
  const byId = new Map(view.hunks.map((x) => [x.id, x]));
  const out = new Map();
  for (const it of view.items) {
    const mine = it.hunks.filter((id) => ticked.has(id));
    if (!mine.length) continue;
    const all = it.hunks.every((id) => ticked.has(id) || byId.get(id)?.already);
    out.set(it.key, { item: it, all, ticked: mine.map((id) => byId.get(id)) });
  }
  return out;
}

// --- reading -------------------------------------------------------------------------

const PR_FIELDS = (commits) => `number title body url headRefName headRefOid changedFiles author { __typename login } headRepository { nameWithOwner } labels(first: 10) { nodes { name } }
  ${commits ? 'commits(last: 100) { nodes { commit { oid parents(first: 2) { nodes { oid } } } } }' : ''}`;
const ISSUES = `issues(states: OPEN, labels: ["${SUGGESTED}"], first: 100, orderBy: { field: CREATED_AT, direction: ASC }) { nodes {
  number title body createdAt url labels(first: 20) { nodes { name } } } }`;

const restOf = (n) => ({
  number: n.number, title: n.title, body: n.body, created_at: n.createdAt, html_url: n.url, state: 'open',
  labels: n.labels?.nodes ?? [], head: { ref: n.headRefName },
  user: n.author ? { login: n.author.__typename === 'Bot' ? `${n.author.login}[bot]` : n.author.login } : null,
});

/** The commit a proposal last took from the drafts (as lib/reapply.mjs reads it). */
function baseOf(commits) {
  const inPr = new Set(commits.map((c) => c.oid));
  const merges = commits.filter((c) => c.parents.nodes.length > 1);
  return merges.length ? merges.at(-1).parents.nodes.find((x) => !inPr.has(x.oid))?.oid : commits[0]?.parents.nodes[0]?.oid;
}

/**
 * Everything a review of `path` needs, as the drafts are now:
 * -> { drafts, tree, crlf, text, edits, issues, heads: Map(number -> head sha) }
 * On the Worker the page asks in parts, each well inside its CPU: `light` reads the page,
 * the suggestions and which proposals there are (each `deferred`, no texts); `number`
 * reads that one proposal in full, and no suggestions.
 */
export async function gather(book, path, token, left, { light = false, number = null } = {}) {
  const repo = book.content.repo;
  const prs = number ? `one: pullRequest(number: ${Number(number)}) { ${PR_FIELDS(true)} }`
    : `pullRequests(states: OPEN, baseRefName: ${JSON.stringify(book.content.drafts_branch)}, first: 50, orderBy: { field: CREATED_AT, direction: ASC }) { nodes { ${PR_FIELDS(!light)} } }`;
  const r = await graphqlRepo(repo, `query($owner: String!, $name: String!, $ref: String!, $path: String!) { repository(owner: $owner, name: $name) {
    ref(qualifiedName: $ref) { target { oid ... on Commit { tree { oid } file(path: $path) { object { ... on Blob { text isBinary } } } } } }
    ${prs} ${number ? '' : ISSUES} } }`, { ref: `refs/heads/${book.content.drafts_branch}`, path }, token, left);
  const head = r.ref?.target;
  const blob = head?.file?.object;
  if (!head?.oid || !blob || blob.isBinary || typeof blob.text !== 'string') return null;
  const edits = [];
  const heads = new Map();
  const wanted = new Map(); // "<sha>:<path>" -> alias
  const nodes = number ? [r.one].filter((n) => n && !n.merged) : r.pullRequests?.nodes ?? [];
  for (const n of nodes) {
    const pr = restOf(n);
    if (!isProposal(pr) || describeChange(pr).path !== path) continue;
    const who = proposerOf(String(n.body ?? ''))?.name ?? pr.user?.login ?? 'a reader';
    // The reader's own words for it: the Summary propose-edit fenced in the body.
    const summary = /^### Summary\n\n(`{3,})text\n([\s\S]*?)\n\1/m.exec(String(n.body ?? ''))?.[2].trim() ?? '';
    const e = { number: n.number, who, title: describeChange(pr).title, summary, url: n.url };
    edits.push(e);
    const commits = (n.commits?.nodes ?? []).map((c) => c.commit);
    const base = baseOf(commits);
    if (String(n.headRepository?.nameWithOwner ?? '').toLowerCase() !== repo.toLowerCase()) e.why = 'it was proposed from another copy of the book';
    else if (n.changedFiles !== 1) e.why = 'it changes more than this page';
    else if (light) e.deferred = true;
    else if (!base) e.why = 'where it started from can’t be found';
    else {
      heads.set(n.number, n.headRefOid);
      for (const sha of [base, n.headRefOid]) if (!wanted.has(sha)) wanted.set(sha, `t${wanted.size}`);
      Object.assign(e, { baseSha: base, headSha: n.headRefOid });
    }
  }
  const texts = new Map();
  if (wanted.size) {
    const t = await graphqlRepo(repo, `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) {
      ${[...wanted].map(([sha, a]) => `${a}: object(expression: ${JSON.stringify(`${sha}:${path}`)}) { ... on Blob { text isBinary } }`).join('\n')} } }`, {}, token, left);
    for (const [sha, a] of wanted) if (t[a] && !t[a].isBinary && typeof t[a].text === 'string') texts.set(sha, lf(t[a].text));
  }
  for (const e of edits) {
    if (e.why || e.deferred) continue;
    if (!texts.has(e.baseSha)) e.why = 'it adds this page rather than editing it';
    else if (!texts.has(e.headSha)) e.why = 'it removes this page';
    else Object.assign(e, { base: texts.get(e.baseSha), suggested: texts.get(e.headSha) });
  }
  const issues = number ? [] : (r.issues?.nodes ?? []).map(restOf).map(parseSuggestion).filter((s) => s?.path === path).map((s) => {
    const n = r.issues.nodes.find((x) => x.number === s.number);
    const note = (n.labels?.nodes ?? []).some((l) => l.name === 'section-note') && !s.original;
    const quote = /\*\*Where:\*\*[^\n]*\n+(`{3,})[^\n]*\n([\s\S]*?)\n\1/.exec(String(n.body ?? ''))?.[2] ?? '';
    return { ...s, note, quote };
  });
  return {
    drafts: head.oid, tree: head.tree?.oid, crlf: blob.text.includes('\r\n'), text: lf(blob.text),
    edits: edits.map(({ baseSha, headSha, ...e }) => e), issues, heads,
  };
}

/** The view the author site draws: the review, and the drafts commit it was built on. */
export const viewOf = (g, path) => ({ path, drafts: g.drafts, ...buildReview(g.text, g) });

/**
 * Whether two hunks can't both be accepted: for the page, which joins a view read in
 * parts and works out the overlaps itself (the same rule applyTicks holds them to).
 */
export { clash };
