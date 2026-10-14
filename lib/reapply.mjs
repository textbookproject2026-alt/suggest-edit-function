/**
 * A reader's proposed edit, brought up to date with the drafts. Each proposal is its own
 * pull request against the drafts as they were when the reader opened the editor, and
 * git merges by line: a Markdown paragraph is one line, so once one suggestion on a
 * paragraph is accepted every other one on it conflicts. Here the page is merged again
 * word by word (lib/merge3.mjs) and, where the changes don't overlap, the result is
 * committed to the proposal's branch as a merge of the drafts, so GitHub can merge it.
 *
 *   reapply(book, pr, token, left, { partial })
 *     -> { state: 'clean', sha }        the branch now holds the drafts plus the edit
 *     -> { state: 'overlap', overlaps } a paragraph changed under the same words:
 *                                       [{ path, line, base, current, suggested, merged? }]; nothing written
 *     -> { state: 'partial', sha, overlaps }  with `partial` only: committed all the same,
 *                                       the drafts' words kept where both changed them
 *     -> { state: 'already' }           everything it changes is in the drafts already
 *     -> { state: 'unsupported', why }  not a page edit this can redo (another repo's
 *                                       branch, a deleted or renamed file, a binary)
 *   An overlap is never resolved here by taking the suggestion: its copy of the paragraph
 *   holds the old wording of whatever the drafts changed there since. `partial` is the
 *   author's "Edit before accepting": the rest of the edit goes in, and they finish it.
 */
import { appCredentials, gh, ghJson, graphqlRepo } from './author.mjs';
import { merge3 } from './merge3.mjs';
import { describeChange, isProposal } from './author-console.mjs';

export const NEEDS_LOOK = 'paragraph changed';

/**
 * A pull request with only what accepting it reads, in REST's shape: GraphQL's answer is
 * about 2 KB where REST's is over 20 KB of JSON to parse on the Worker.
 */
export async function readPull(repo, n, token, left) {
  const r = await graphqlRepo(repo, `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) {
    p0: pullRequest(number: ${Number(n)}) { number title body state merged mergeable baseRefName headRefName headRefOid
      headRepository { nameWithOwner } baseRepository { nameWithOwner } labels(first: 20) { nodes { name } } } } }`, {}, token, left);
  const p = r.p0;
  if (!p) return null;
  return {
    number: p.number, title: p.title, body: p.body, state: p.state === 'OPEN' ? 'open' : 'closed', merged: p.merged,
    mergeable: p.mergeable === 'MERGEABLE' ? true : p.mergeable === 'CONFLICTING' ? false : null,
    base: { ref: p.baseRefName, repo: { full_name: p.baseRepository?.nameWithOwner } },
    head: { ref: p.headRefName, sha: p.headRefOid, repo: { full_name: p.headRepository?.nameWithOwner ?? null } },
    labels: p.labels?.nodes ?? [],
  };
}
const MAX_FILES = 10;

const enc = (p) => p.split('/').map(encodeURIComponent).join('/');

async function textAt(repo, ref, path, token, left) {
  const res = await gh(`/repos/${repo}/contents/${enc(path)}?ref=${ref}`, token, left, { accept: 'application/vnd.github.raw', allow: [404] });
  if (res.status === 404) return null;
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.includes(0)) throw Object.assign(new Error('binary'), { unsupported: true });
  return new TextDecoder().decode(bytes);
}

/**
 * Where the proposal stands against the drafts: the drafts' head, the commit its branch
 * last took from the drafts (the merge base), and its pages. A reader's proposal names
 * its one page in its body, and its commits (oldest first) say the rest without a compare
 * (whose answer carries every patch: CPU the Worker hasn't got to spare). Anything else
 * is compared.
 */
async function standing(book, pr, token, left, commits) {
  const repo = book.content.repo;
  const path = describeChange(pr).path;
  if (path && commits?.length) {
    const inPr = new Set(commits.map((c) => c.sha));
    const merges = commits.filter((c) => (c.parents ?? []).length > 1);
    const fromDrafts = merges.length ? merges.at(-1).parents.find((x) => !inPr.has(x.sha))?.sha : commits[0].parents?.[0]?.sha;
    if (fromDrafts) {
      const branch = await ghJson(`/repos/${repo}/branches/${enc(book.content.drafts_branch)}`, token, left);
      return { drafts: branch.commit.sha, tree: branch.commit.commit.tree.sha, base: fromDrafts, files: [{ filename: path, status: 'modified' }] };
    }
  }
  const cmp = await ghJson(`/repos/${repo}/compare/${enc(book.content.drafts_branch)}...${pr.head.sha}`, token, left);
  return { drafts: cmp.base_commit?.sha, tree: cmp.base_commit?.commit?.tree?.sha, base: cmp.merge_base_commit?.sha, files: cmp.files ?? [] };
}

/** `commits`: the pull request's commits, if already read (oldest first, with parents). */
export async function reapply(book, pr, token, left, { commits, partial = false } = {}) {
  const repo = book.content.repo;
  if (String(pr.head?.repo?.full_name ?? repo).toLowerCase() !== repo.toLowerCase()) {
    return { state: 'unsupported', why: 'it was proposed from another copy of the book, so it can’t be updated from here' };
  }
  commits ??= await ghJson(`/repos/${repo}/pulls/${pr.number}/commits?per_page=100`, token, left);
  const where = await standing(book, pr, token, left, commits);
  const { drafts, base, files } = where;
  let { tree } = where;
  if (!drafts || !base) throw new Error('reapply: no merge base');
  if (files.length > MAX_FILES || files.some((f) => !['modified', 'added'].includes(f.status))) {
    return { state: 'unsupported', why: 'it adds, removes or renames pages rather than editing them' };
  }
  const merged = [];
  const overlaps = [];
  try {
    for (const f of files) {
      const path = f.filename;
      const [was, now, sug] = await Promise.all([base, drafts, pr.head.sha].map((ref) => textAt(repo, ref, path, token, left)));
      if (sug === null) return { state: 'unsupported', why: 'it removes a page' };
      // A page written with "\r\n" goes back with it; merged with "\n" throughout.
      const crlf = (now ?? '').includes('\r\n');
      const lf = (t) => (t ?? '').replace(/\r\n/g, '\n');
      const r = merge3(lf(was), lf(now), lf(sug), { partial });
      overlaps.push(...r.overlaps.map((o) => ({ path, ...o })));
      const text = crlf ? r.text.replace(/\n/g, '\r\n') : r.text;
      if (text !== (now ?? '')) merged.push({ path, text });
    }
  } catch (err) {
    if (err.unsupported) return { state: 'unsupported', why: 'it changes a file that isn’t text' };
    throw err;
  }
  if (overlaps.length && !partial) return { state: 'overlap', overlaps };
  if (!merged.length) return overlaps.length ? { state: 'overlap', overlaps } : { state: 'already' };
  tree ??= (await ghJson(`/repos/${repo}/git/commits/${drafts}`, token, left)).tree.sha;
  const t = await ghJson(`/repos/${repo}/git/trees`, token, left, {
    method: 'POST', body: { base_tree: tree, tree: merged.map(({ path, text }) => ({ path, mode: '100644', type: 'blob', content: text })) },
  });
  // A merge of the drafts into the proposal: its own commits (and their authors) stay.
  const c = await ghJson(`/repos/${repo}/git/commits`, token, left, {
    method: 'POST',
    body: { message: `Bring the drafts into #${pr.number}, merged word by word${overlaps.length ? '; the drafts\' words kept where both changed them' : ''}`, tree: t.sha, parents: [pr.head.sha, drafts] },
  });
  await ghJson(`/repos/${repo}/git/refs/heads/${enc(pr.head.ref)}`, token, left, { method: 'PATCH', body: { sha: c.sha } });
  return overlaps.length ? { state: 'partial', sha: c.sha, overlaps } : { state: 'clean', sha: c.sha };
}

/** Mark (or unmark) a proposal as needing a look; failures logged, not thrown. */
export async function markNeedsLook(book, number, on, token, left, tag) {
  const repo = book.content.repo;
  try {
    if (on) await ghJson(`/repos/${repo}/issues/${number}/labels`, token, left, { method: 'POST', body: { labels: [NEEDS_LOOK] } });
    else await gh(`/repos/${repo}/issues/${number}/labels/${encodeURIComponent(NEEDS_LOOK)}`, token, left, { method: 'DELETE', allow: [404] });
  } catch (err) {
    console.warn(`#${number}: label ${NEEDS_LOOK} not ${on ? 'added' : 'removed'} — ${err.message} ${tag}`);
  }
}

const hasLook = (pr) => (pr.labels ?? []).some((l) => (l?.name ?? l) === NEEDS_LOOK);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The open proposals into the drafts (those on `paths` only, if given; not `except`),
 * brought up to date where GitHub can't merge them and their words don't overlap, and
 * marked "paragraph changed" where they do, so the author's list says so before anyone
 * clicks. Accepts, declines and merges nothing. Run after an accept (in Actions, with
 * no CPU cap: scripts/refresh-proposals.mjs) and over the whole backlog.
 * -> { clean, refreshed, overlap, other: [{ number, why }] }
 *    clean: GitHub merges it as it is; refreshed: now does; overlap: needs the author.
 */
export async function refreshProposals(book, token, left, { paths = null, except = null, tag = '', wait = pause } = {}) {
  const repo = book.content.repo;
  const open = await ghJson(`/repos/${repo}/pulls?state=open&base=${encodeURIComponent(book.content.drafts_branch)}&per_page=100`, token, left);
  const todo = (open ?? []).filter((p) => p.number !== except && isProposal(p) && (!paths || paths.has(describeChange(p).path)));
  const out = { clean: [], refreshed: [], overlap: [], other: [] };
  for (const listed of todo) {
    try {
      // GitHub works out whether it can merge only when asked: a few tries.
      let pr = await ghJson(`/repos/${repo}/pulls/${listed.number}`, token, left);
      for (let i = 0; i < 4 && pr.mergeable == null; i++) {
        await wait(2000);
        pr = await ghJson(`/repos/${repo}/pulls/${listed.number}`, token, left);
      }
      let state = pr.mergeable ? 'clean' : (await reapply(book, pr, token, left)).state;
      if (state === 'clean' && !pr.mergeable) state = 'refreshed';
      if (state === 'clean' || state === 'refreshed' || state === 'overlap') out[state].push(pr.number);
      else out.other.push({ number: pr.number, why: state });
      if (hasLook(pr) !== (state === 'overlap')) await markNeedsLook(book, pr.number, state === 'overlap', token, left, tag);
    } catch (err) {
      out.other.push({ number: listed.number, why: err.message });
      console.warn(`#${listed.number}: not brought up to date — ${err.message} ${tag}`);
    }
  }
  console.log(`${book.slug}: ${todo.length} open proposal(s)${paths ? ` on ${[...paths].join(', ')}` : ''}: ${out.clean.length} merge as they are, ${out.refreshed.length} brought up to date, ${out.overlap.length} need a look${out.other.length ? `, ${out.other.length} other` : ''} ${tag}`);
  return out;
}

// proposals.yml lives in this repository; the App starts it (as worker/writes.mjs does write-fallback).
const FUNCTION_REPO = process.env.FALLBACK_REPO || 'textbookproject2026-alt/suggest-edit-function';
const dispatchToken = appCredentials({ contents: 'write' });

/** Start proposals.yml (scripts/refresh-proposals.mjs) for one book's page. */
export async function startRefresh(slug, path, left, tag) {
  const { token } = await dispatchToken({ slug: 'c4n-api', content: { repo: FUNCTION_REPO } }, tag);
  await ghJson(`/repos/${FUNCTION_REPO}/dispatches`, token, left, {
    method: 'POST', body: { event_type: 'c4n-proposals', client_payload: { book: slug, path } },
  });
}
