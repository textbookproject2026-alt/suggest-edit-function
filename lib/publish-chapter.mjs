/**
 * Publish one chapter (the author site's "Publish this chapter"): only that chapter's
 * drafts text goes to the live branch, merged three ways against the live branch (so a
 * fix made there since stays), with its pictures, and, when the chapter is new to the
 * live book or has moved in the reading order, its one line in index.md's Contents.
 * Nothing else of the drafts goes: other chapters, the book's settings and the rest of
 * the front page wait for Publish all.
 *
 * The live branch takes pull requests only, with the book's checks: so this opens one
 * from a branch off the live branch with that one commit and lets it merge itself when
 * the checks pass (a lint problem in the chapter stops only this chapter). The squash
 * commit says "Published “<title>”", who published it, and each drafts commit it carries
 * ("Publishes-commit: <sha>"), so the contributors page and History credit them now,
 * not only once Publish all brings those commits over. quartz-book's drafts sync then
 * merges the live branch into the drafts, so the two agree on the chapter and Publish all
 * finds nothing of it left to do.
 *
 * Pages the chapter links to that exist only in the drafts (a concept page, another
 * chapter, a glossary term) are listed: published too (`withLinked`), or not (their links
 * are broken on the live book until they are).
 */
import { encodePath, ghJson, gh, graphqlRepo, treeAt, blobTexts, Refusal } from './author.mjs';
import { merge3 } from './merge3.mjs';

// --- the front page's Contents (as the author site's contents.js reads it) -----------------

const CONTENTS = /^##\s+Contents\s*$/i;
const HEADING = /^#{1,6}\s/;
const ITEM = /^(?:[-*+]|\d+[.)])\s/;
const LINK = /\[\[([^\]|#]+)(#[^\]|]*)?(?:\|([^\]]*))?\]\]|\[([^\]]*)\]\(([^)\s]+)([^)]*)\)/;

const targetPath = (target) => {
  let t = target;
  try {
    t = decodeURI(t);
  } catch {
    /* as written */
  }
  t = t.split('#')[0].trim().replace(/^\.?\//, '');
  return /\.md$/i.test(t) ? t : `${t}.md`;
};

/** index.md's Contents: { lines, start, end, items: [{ at, n, path, label }], blank } or null. */
export function contentsOf(text) {
  const lines = String(text ?? '').split('\n');
  const start = lines.findIndex((l) => CONTENTS.test(l));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && HEADING.test(l));
  if (end < 0) end = lines.length;
  const items = [];
  for (let i = start + 1; i < end; i++) {
    if (ITEM.test(lines[i])) {
      const m = LINK.exec(lines[i]);
      items.push({ at: i, n: 1, path: m ? targetPath(m[1] ?? m[5]) : null, label: m ? (m[1] ? (m[3] ?? m[1].split('/').pop()) : m[4]) : null });
    } else if (items.length && /^\s+\S/.test(lines[i])) items.at(-1).n = i - items.at(-1).at + 1;
  }
  const blank = items.some((it, k) => k && it.at > items[k - 1].at + items[k - 1].n);
  return { lines, start, end, items, blank };
}

/**
 * The live index.md with `paths`' Contents lines as the drafts have them: each one taken
 * out of where it was and put after the nearest page before it in the drafts' order that
 * the live Contents has (first, if none). Nothing else of the front page changes.
 * -> the new text, or null when there is nothing to change (or no Contents on either side).
 */
export function withContentsLines(liveIndex, draftsIndex, paths) {
  const d = contentsOf(draftsIndex);
  if (!d) return null;
  let text = liveIndex;
  for (const path of paths) {
    const mine = d.items.find((it) => it.path === path);
    const live = contentsOf(text);
    if (!mine || !live) continue;
    const linesOf = (c, it) => c.lines.slice(it.at, it.at + it.n);
    const myLines = linesOf(d, mine);
    // Where the drafts put it: after the nearest page before it that the live list has.
    const before = d.items.slice(0, d.items.indexOf(mine)).reverse().map((it) => it.path);
    const kept = live.items.filter((it) => it.path !== path);
    const after = before.map((p) => kept.find((it) => it.path === p)).find(Boolean) ?? null;
    const old = live.items.find((it) => it.path === path);
    const order = live.items.filter((it) => it.path !== path).map((it) => it.path);
    const was = live.items.map((it) => it.path);
    const want = [...order];
    want.splice(after ? want.indexOf(after.path) + 1 : 0, 0, path);
    if (old && was.join('\n') === want.join('\n') && linesOf(live, old).join('\n') === myLines.join('\n')) continue;
    // Rebuild the list: the live items in `want` order, the moved one with the drafts' lines.
    const block = want.flatMap((p, k) => {
      const lines = p === path ? myLines : linesOf(live, live.items.find((it) => it.path === p));
      return [...(k && live.blank ? [''] : []), ...lines];
    });
    const first = live.items[0]?.at ?? live.start + 2;
    const lastItem = live.items.at(-1);
    const last = lastItem ? lastItem.at + lastItem.n : first;
    const head = live.items.length ? live.lines.slice(0, first) : [...live.lines.slice(0, live.start + 1), ''];
    text = [...head, ...block, ...live.lines.slice(live.items.length ? last : live.start + 1)].join('\n');
  }
  return text === liveIndex ? null : text;
}

// --- what a chapter links to and shows -------------------------------------------------------

/** Every link and embed target in a page: { pages: [target], pictures: [target], anchors: [{ target, anchor }] }. */
export function linksOf(text) {
  const pages = [];
  const pictures = [];
  const anchors = [];
  const body = String(text ?? '').replace(/^---\n[\s\S]*?\n---\n?/, '').replace(/```[\s\S]*?```/g, '');
  for (const m of body.matchAll(/(!?)\[\[([^\]|#]*)(#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)) {
    if (m[1]) pictures.push(m[2]);
    else if (m[2]) {
      pages.push(m[2]);
      if (m[3]) anchors.push({ target: m[2], anchor: m[3].slice(1) });
    }
  }
  for (const m of body.matchAll(/(!?)\[[^\]]*\]\(([^)\s]+)[^)]*\)/g)) {
    if (/^[a-z][a-z0-9+.-]*:|^#|^\/\//i.test(m[2])) continue;
    (m[1] ? pictures : /\.md(#|$)/i.test(m[2]) ? pages : pictures).push(m[2]);
  }
  return { pages, pictures, anchors };
}

/** A link target as a path in `files` (Map), the way the book resolves it: as written, beside the page, or by its name alone. */
export function resolve(target, from, files, md = true) {
  let t = target;
  try {
    t = decodeURI(t);
  } catch {
    /* as written */
  }
  t = t.split('#')[0].trim();
  if (!t) return null;
  const want = md && !/\.[a-z0-9]+$/i.test(t) ? `${t}.md` : t;
  const dir = from.split('/').slice(0, -1);
  const parts = [...dir];
  for (const seg of want.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  for (const p of [want.replace(/^\//, ''), parts.join('/')]) if (files.has(p)) return p;
  const tail = `/${want.split('/').pop()}`;
  const named = [...files.keys()].filter((p) => p.endsWith(tail) || p === tail.slice(1));
  return named.length === 1 ? named[0] : null;
}

const slug = (s) => s.toLowerCase().trim().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-');
const headingsOf = (text) => new Set([...String(text ?? '').matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)].map((m) => slug(m[1])));

// --- the plan, and doing it -------------------------------------------------------------------

const titleOf = (text, path) => /^title:\s*["']?(.+?)["']?\s*$/m.exec(/^---\n([\s\S]*?)\n---/.exec(text ?? '')?.[1] ?? '')?.[1]
  ?? /^#\s+(.+)$/m.exec(text ?? '')?.[1]?.trim() ?? path.split('/').pop().replace(/\.md$/, '');

/**
 * What publishing `path` would put on the live branch, or a Refusal.
 * -> { live, drafts, base, liveTree, title, files: [{ path, content } | { path, sha, mode }],
 *      linked: [{ path, title, why }], commits: [sha] }
 */
export async function planChapter(book, path, token, left, { withLinked = false } = {}) {
  const repo = book.content.repo;
  const cmp = await ghJson(`/repos/${repo}/compare/${encodePath(book.content.live_branch)}...${encodePath(book.content.drafts_branch)}?per_page=100`, token, left);
  const live = cmp.base_commit.sha;
  const base = cmp.merge_base_commit.sha;
  const draftsSha = (await ghJson(`/repos/${repo}/git/ref/heads/${encodePath(book.content.drafts_branch)}`, token, left)).object.sha;
  const [L, D, B] = await Promise.all([treeAt(repo, live, token, left), treeAt(repo, draftsSha, token, left), treeAt(repo, base, token, left)]);
  const d = D.files.get(path);
  if (!d) throw new Refusal(404, 'not in drafts', "That chapter isn't in the drafts.");
  const texts = await blobTexts(repo, [...new Set([d.sha, L.files.get(path)?.sha, B.files.get(path)?.sha, D.files.get('index.md')?.sha, L.files.get('index.md')?.sha].filter(Boolean))], token, left);
  const text = (files, p) => (files.get(p) ? texts.get(files.get(p).sha) ?? null : null);
  const draftsText = text(D.files, path);
  if (L.files.get(path)?.sha === d.sha) {
    const indexOnly = withContentsLines(text(L.files, 'index.md') ?? '', text(D.files, 'index.md') ?? '', [path]);
    if (!indexOnly) throw new Refusal(409, 'already live', 'This chapter is already on the live book as the drafts have it.');
  }
  const files = [];
  const pages = [path];
  // Each page: its drafts text, merged three ways with the live branch's (a fix made there since stays).
  const addPage = async (p) => {
    const extra = [L.files.get(p)?.sha, B.files.get(p)?.sha, D.files.get(p)?.sha].filter((s) => s && !texts.has(s));
    if (extra.length) for (const [k, v] of await blobTexts(repo, extra, token, left)) texts.set(k, v);
    const dt = text(D.files, p);
    const lt = text(L.files, p);
    if (dt === null) return;
    if (lt === dt) return;
    let out = dt;
    if (lt !== null) {
      const m = merge3((text(B.files, p) ?? '').replace(/\r\n/g, '\n'), lt.replace(/\r\n/g, '\n'), dt.replace(/\r\n/g, '\n'));
      if (m.overlaps.length) {
        throw new Refusal(409, 'live changed too', `“${titleOf(dt, p)}” was also changed on the live book, in the same words, since the drafts took it. Publish all shows where, so the two can be put together; nothing was published.`);
      }
      out = m.text;
    }
    files.push({ path: p, content: out });
  };
  await addPage(path);
  // Pages it links to that the live book hasn't got (or a glossary term it hasn't got yet).
  const { pages: targets, pictures, anchors } = linksOf(draftsText);
  const linked = new Map();
  for (const t of targets) {
    const p = resolve(t, path, D.files);
    if (p && p !== path && !L.files.has(p)) linked.set(p, 'only in the drafts');
  }
  for (const { target, anchor } of anchors) {
    const p = resolve(target, path, D.files);
    if (!p || !L.files.has(p) || linked.has(p)) continue;
    const extra = [L.files.get(p).sha, D.files.get(p).sha].filter((s) => !texts.has(s));
    if (extra.length) for (const [k, v] of await blobTexts(repo, extra, token, left)) texts.set(k, v);
    const a = slug(anchor);
    if (!headingsOf(text(L.files, p)).has(a) && headingsOf(text(D.files, p)).has(a)) linked.set(p, `“${anchor}” is only in the drafts`);
  }
  if (withLinked) for (const p of linked.keys()) {
    await addPage(p);
    pages.push(p);
  }
  // Its pictures (and the linked pages' when they go too): as the drafts have them.
  const shown = [...pictures.map((t) => resolve(t, path, D.files, false))];
  if (withLinked) for (const p of linked.keys()) shown.push(...linksOf(text(D.files, p)).pictures.map((t) => resolve(t, p, D.files, false)));
  for (const p of new Set(shown.filter(Boolean))) {
    const f = D.files.get(p);
    if (L.files.get(p)?.sha !== f.sha) files.push({ path: p, sha: f.sha, mode: '100644' });
  }
  // A new or moved page: its one Contents line.
  const index = withContentsLines(text(L.files, 'index.md') ?? '', text(D.files, 'index.md') ?? '', pages);
  if (index !== null) files.push({ path: 'index.md', content: index });
  // The drafts commits it carries: those not on the live branch that touched what goes.
  const going = new Set(files.map((f) => f.path));
  const commits = [];
  for (const c of cmp.commits ?? []) {
    if ((c.parents ?? []).length > 1) continue;
    const full = await ghJson(`/repos/${repo}/commits/${c.sha}`, token, left).catch(() => null);
    if ((full?.files ?? []).some((f) => going.has(f.filename))) commits.push(c.sha);
  }
  return {
    live, drafts: draftsSha, base, liveTree: L.tree, title: titleOf(draftsText, path), files, commits,
    linked: [...linked].map(([p, why]) => ({ path: p, title: titleOf(text(D.files, p), p), why })),
  };
}

/**
 * The chapter on the live branch: a branch off it with one commit, a pull request that
 * merges itself (squash) once the book's checks pass. -> { number, url, branch, title }
 */
export async function publishChapter(book, plan, byline, token, left, tag) {
  const repo = book.content.repo;
  const t = await ghJson(`/repos/${repo}/git/trees`, token, left, { method: 'POST', body: { base_tree: plan.liveTree, tree: plan.files.map((f) => (f.content !== undefined ? { path: f.path, mode: '100644', type: 'blob', content: f.content } : { path: f.path, mode: f.mode, type: 'blob', sha: f.sha })) } });
  const headline = `Published “${plan.title}”`;
  const body = [`Published ${byline}: this chapter only${plan.files.length > 1 ? `, with ${plan.files.filter((f) => f.path !== plan.files[0].path).map((f) => f.path === 'index.md' ? 'its Contents line' : f.path).join(', ')}` : ''}. The rest of the drafts waits for Publish all.`, '', ...plan.commits.map((s) => `Publishes-commit: ${s}`)].join('\n');
  const c = await ghJson(`/repos/${repo}/git/commits`, token, left, { method: 'POST', body: { message: `${headline}\n\n${body}`, tree: t.sha, parents: [plan.live] } });
  const branch = `publish-chapter/${plan.files[0].path.split('/').pop().replace(/\.md$/, '')}-${Date.now().toString(36)}`;
  await ghJson(`/repos/${repo}/git/refs`, token, left, { method: 'POST', body: { ref: `refs/heads/${branch}`, sha: c.sha } });
  let pr;
  try {
    pr = await ghJson(`/repos/${repo}/pulls`, token, left, { method: 'POST', body: { title: `Publish “${plan.title}”`, head: branch, base: book.content.live_branch,
      body: `${body}\n\nIt goes live by itself once the book's checks pass.` } });
  } catch (err) {
    await gh(`/repos/${repo}/git/refs/heads/${encodePath(branch)}`, token, left, { method: 'DELETE', allow: [404, 422] }).catch(() => {});
    throw err;
  }
  const r = await gh('/graphql', token, left, { method: 'POST', body: {
    query: 'mutation($id: ID!, $h: String!, $b: String!) { enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: SQUASH, commitHeadline: $h, commitBody: $b }) { pullRequest { number } } }',
    variables: { id: pr.node_id, h: headline, b: body },
  } }).then((x) => x.json()).catch((err) => ({ errors: [{ message: err.message }] }));
  if (r?.errors?.length) console.warn(`publish chapter: auto-merge not switched on for #${pr.number}: ${r.errors.map((e) => e.message).join('; ')} ${tag}`);
  return { number: pr.number, url: pr.html_url, branch, title: plan.title, autoMerge: !r?.errors?.length };
}

/** A chapter's publish request as it stands: { state: 'checking' | 'merged' | 'failed' | 'closed', checks, sha }. */
export async function chapterState(book, number, token, left) {
  const r = await graphqlRepo(book.content.repo, `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) {
    pullRequest(number: ${Number(number)}) { state merged headRefName headRefOid title
      commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 20) { nodes { ... on CheckRun { name conclusion status } ... on StatusContext { context state } } } } } } } } } }`, {}, token, left);
  const p = r.pullRequest;
  if (!p || !String(p.headRefName).startsWith('publish-chapter/')) throw new Refusal(404, 'not a chapter publish', "That isn't a chapter being published.");
  const checks = (p.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? []).map((c) => ({ name: c.name ?? c.context, done: c.status ? c.status === 'COMPLETED' : c.state !== 'PENDING', ok: c.conclusion ? ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(c.conclusion) : c.state === 'SUCCESS' }));
  const state = p.merged ? 'merged' : p.state === 'CLOSED' ? 'closed' : checks.some((c) => c.done && !c.ok) ? 'failed' : 'checking';
  return { state, checks, sha: p.headRefOid, title: p.title };
}
