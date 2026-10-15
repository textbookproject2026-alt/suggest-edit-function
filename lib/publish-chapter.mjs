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
import { encodePath, ghJson, gh, graphqlRepo, treeAt, blobTexts, isAuthorPath, Refusal } from './author.mjs';
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

/** A chapter: a page directly in chapters/ (the glossary, the front page and concept pages are the rest of the book). */
export const isChapter = (path) => /^chapters\/[^/]+\.md$/i.test(path);

/**
 * The live branch, the drafts and where they parted, each as a tree, and the texts read so
 * far (`read(paths)` adds more). -> { repo, cmp, live, base, draftsSha, L, D, B, text, read }
 */
async function load(book, token, left) {
  const repo = book.content.repo;
  const cmp = await ghJson(`/repos/${repo}/compare/${encodePath(book.content.live_branch)}...${encodePath(book.content.drafts_branch)}?per_page=100`, token, left);
  const live = cmp.base_commit.sha;
  const base = cmp.merge_base_commit.sha;
  const draftsSha = (await ghJson(`/repos/${repo}/git/ref/heads/${encodePath(book.content.drafts_branch)}`, token, left)).object.sha;
  const [L, D, B] = await Promise.all([treeAt(repo, live, token, left), treeAt(repo, draftsSha, token, left), treeAt(repo, base, token, left)]);
  const texts = new Map();
  const text = (files, p) => (files.get(p) ? texts.get(files.get(p).sha) ?? null : null);
  const read = async (paths) => {
    const want = [...new Set(paths.flatMap((p) => [L.files.get(p)?.sha, B.files.get(p)?.sha, D.files.get(p)?.sha]).filter((x) => x && !texts.has(x)))];
    if (want.length) for (const [k, v] of await blobTexts(repo, want, token, left)) texts.set(k, v);
  };
  return { repo, cmp, live, base, draftsSha, L, D, B, text, read };
}

/** A page's drafts text merged three ways with the live branch's (a fix made there since stays); null when the live book has it already. */
function merged(ctx, p) {
  const { L, D, B, text } = ctx;
  const dt = text(D.files, p);
  const lt = text(L.files, p);
  if (dt === null || lt === dt) return null;
  if (lt === null) return dt;
  const m = merge3((text(B.files, p) ?? '').replace(/\r\n/g, '\n'), lt.replace(/\r\n/g, '\n'), dt.replace(/\r\n/g, '\n'));
  if (m.overlaps.length) {
    throw new Refusal(409, 'live changed too', `“${titleOf(dt, p)}” was also changed on the live book, in the same words, since the drafts took it. Publish all shows where, so the two can be put together; nothing was published.`);
  }
  return m.text;
}

/** Pages `from` links to that the live book hasn't got: Map(path -> why). */
async function linkedFrom(ctx, from, has) {
  const { L, D, text, read } = ctx;
  const linked = new Map();
  for (const path of from) {
    const { pages: targets, anchors } = linksOf(text(D.files, path));
    for (const t of targets) {
      const p = resolve(t, path, D.files);
      if (p && !from.includes(p) && !has(p)) linked.set(p, 'only in the drafts');
    }
    for (const { target, anchor } of anchors) {
      const p = resolve(target, path, D.files);
      if (!p || !L.files.has(p) || linked.has(p) || from.includes(p)) continue;
      await read([p]);
      const a = slug(anchor);
      if (!headingsOf(text(L.files, p)).has(a) && headingsOf(text(D.files, p)).has(a)) linked.set(p, `“${anchor}” is only in the drafts`);
    }
  }
  await read([...linked.keys()]);
  return linked;
}

/** The drafts commits a publish carries: those not on the live branch that touched what goes. */
async function carried(ctx, files, token, left) {
  const going = new Set(files.map((f) => f.path));
  const commits = [];
  // A merge counts when all it merges is drafts work (a review's accept, merging the
  // proposals); one bringing the live book's changes into the drafts doesn't.
  const ahead = new Set((ctx.cmp.commits ?? []).map((c) => c.sha));
  for (const c of ctx.cmp.commits ?? []) {
    if ((c.parents ?? []).slice(1).some((p) => !ahead.has(p.sha))) continue;
    const full = await ghJson(`/repos/${ctx.repo}/commits/${c.sha}`, token, left).catch(() => null);
    if ((full?.files ?? []).some((f) => going.has(f.filename))) commits.push(c.sha);
  }
  return commits;
}

/** index.md without `paths`' Contents lines. -> the new text, or null when none was there. */
export function withoutContentsLines(text, paths) {
  const c = contentsOf(text);
  const gone = c ? c.items.filter((it) => paths.includes(it.path)) : [];
  if (!gone.length) return null;
  const drop = new Set(gone.flatMap((it) => Array.from({ length: it.n }, (_, k) => it.at + k)));
  const lines = c.lines.filter((_, i) => !drop.has(i));
  // A blank line the list kept between items, left doubled where one went: one again.
  return lines.filter((l, i) => !(c.blank && l === '' && lines[i - 1] === '' && i > c.start)).join('\n');
}

const done = (ctx, plan) => ({ live: ctx.live, drafts: ctx.draftsSha, base: ctx.base, liveTree: ctx.L.tree, ...plan });

/**
 * What publishing `path` would put on the live branch, or a Refusal.
 * -> { live, drafts, base, liveTree, title, files: [{ path, content } | { path, sha, mode }],
 *      linked: [{ path, title, why }], commits: [sha] }
 */
export async function planChapter(book, path, token, left, { withLinked = false } = {}) {
  const ctx = await load(book, token, left);
  const { L, D, text, read } = ctx;
  const d = D.files.get(path);
  await read([path, 'index.md']);
  if (!d && L.files.has(path)) {
    // Removed in the drafts: gone from the live book too, with its Contents line.
    const files = [{ path, sha: null, mode: '100644' }];
    const index = withoutContentsLines(text(L.files, 'index.md') ?? '', [path]);
    if (index !== null) files.push({ path: 'index.md', content: index });
    return done(ctx, { title: titleOf(text(L.files, path), path), files, commits: await carried(ctx, files, token, left), linked: [], removed: true });
  }
  if (!d) throw new Refusal(404, 'not in drafts', "That chapter isn't in the drafts.");
  if (L.files.get(path)?.sha === d.sha) {
    const indexOnly = withContentsLines(text(L.files, 'index.md') ?? '', text(D.files, 'index.md') ?? '', [path]);
    if (!indexOnly) throw new Refusal(409, 'already live', 'This chapter is already on the live book as the drafts have it.');
  }
  const files = [];
  const pages = [path];
  const addPage = async (p) => {
    await read([p]);
    const out = merged(ctx, p);
    if (out !== null) files.push({ path: p, content: out });
  };
  await addPage(path);
  // Pages it links to that the live book hasn't got (or a glossary term it hasn't got yet).
  const linked = await linkedFrom(ctx, [path], (p) => L.files.has(p));
  if (withLinked) for (const p of linked.keys()) {
    await addPage(p);
    pages.push(p);
  }
  // Its pictures (and the linked pages' when they go too): as the drafts have them.
  const shown = pages.flatMap((p) => linksOf(text(D.files, p)).pictures.map((t) => resolve(t, p, D.files, false)));
  for (const p of new Set(shown.filter(Boolean))) {
    const f = D.files.get(p);
    if (L.files.get(p)?.sha !== f.sha) files.push({ path: p, sha: f.sha, mode: '100644' });
  }
  // A new or moved page: its one Contents line.
  const index = withContentsLines(text(L.files, 'index.md') ?? '', text(D.files, 'index.md') ?? '', pages);
  if (index !== null) files.push({ path: 'index.md', content: index });
  return done(ctx, {
    title: titleOf(text(D.files, path), path), files, commits: await carried(ctx, files, token, left),
    linked: [...linked].map(([p, why]) => ({ path: p, title: titleOf(text(D.files, p), p), why })),
  });
}

/**
 * The rest of the book: everything the drafts hold that isn't a chapter. Pages other than
 * chapters (the glossary, concept pages, others) as the drafts have them, merged three
 * ways; ones removed in the drafts removed; the front page merged three ways, its
 * Contents listing what the live book will have (a chapter still only in the drafts
 * stays out of it, one removed only in the drafts stays in); pictures no changed chapter
 * shows. Chapters these pages link to that the live book hasn't got are `linked`, as for
 * a chapter. Same result as planChapter.
 */
export async function planRest(book, token, left, { withLinked = false } = {}) {
  const ctx = await load(book, token, left);
  const { L, D, B, text, read } = ctx;
  const differs = (p) => L.files.get(p)?.sha !== D.files.get(p)?.sha;
  const all = [...new Set([...L.files.keys(), ...D.files.keys()])].filter((p) => differs(p) && isAuthorPath(p) && p !== 'chapter-sources.json');
  const pages = all.filter((p) => /\.md$/i.test(p) && p !== 'index.md' && !isChapter(p));
  const chapters = all.filter(isChapter);
  await read([...pages, ...chapters, 'index.md']);
  const files = [];
  for (const p of pages) {
    if (!D.files.has(p)) files.push({ path: p, sha: null, mode: '100644' });
    else {
      const out = merged(ctx, p);
      if (out !== null) files.push({ path: p, content: out });
    }
  }
  const going = pages.filter((p) => D.files.has(p));
  const linked = await linkedFrom(ctx, going, (p) => L.files.has(p));
  const extra = withLinked ? [...linked.keys()] : [];
  for (const p of extra) {
    const out = merged(ctx, p);
    if (out !== null) files.push({ path: p, content: out });
  }
  // Pictures: the ones these pages show, and any no changed chapter shows (a changed
  // chapter's go with it, or with Publish all).
  const shows = (ps) => new Set(ps.flatMap((p) => linksOf(text(D.files, p)).pictures.map((t) => resolve(t, p, D.files, false))).filter(Boolean));
  const mine = shows([...going, ...extra]);
  const theirs = shows(chapters.filter((p) => D.files.has(p) && !extra.includes(p)));
  for (const p of all.filter((x) => x.startsWith('assets/'))) {
    if (theirs.has(p) && !mine.has(p)) continue;
    files.push(D.files.has(p) ? { path: p, sha: D.files.get(p).sha, mode: '100644' } : { path: p, sha: null, mode: '100644' });
  }
  // The front page: merged three ways, then its Contents as the live book will have it.
  const after = new Set(L.files.keys());
  for (const f of files) {
    if (f.sha === null) after.delete(f.path);
    else after.add(f.path);
  }
  const lt = text(L.files, 'index.md');
  const dt = text(D.files, 'index.md');
  if (dt !== null && lt !== dt) {
    let index = lt === null ? dt : null;
    if (index === null) {
      const m = merge3((text(B.files, 'index.md') ?? '').replace(/\r\n/g, '\n'), lt.replace(/\r\n/g, '\n'), dt.replace(/\r\n/g, '\n'));
      if (m.overlaps.length) throw new Refusal(409, 'live changed too', 'The front page was also changed on the live book, in the same words, since the drafts took it. Publish all shows where, so the two can be put together; nothing was published.');
      index = m.text;
    }
    const listed = (contentsOf(index)?.items ?? []).map((it) => it.path).filter(Boolean);
    index = withoutContentsLines(index, listed.filter((p) => !after.has(p))) ?? index;
    const missing = (contentsOf(lt)?.items ?? []).map((it) => it.path).filter((p) => p && after.has(p) && !listed.includes(p));
    if (missing.length) index = withContentsLines(index, lt, missing) ?? index;
    if (index !== lt) files.push({ path: 'index.md', content: index });
  }
  if (!files.length) throw new Refusal(409, 'already live', 'The rest of the book is already on the live book as the drafts have it.');
  return done(ctx, {
    rest: true, title: 'the rest of the book', files, commits: await carried(ctx, files, token, left),
    linked: [...linked].map(([p, why]) => ({ path: p, title: titleOf(text(D.files, p), p), why })),
  });
}

/**
 * The chapter on the live branch: a branch off it with one commit, a pull request that
 * merges itself (squash) once the book's checks pass. -> { number, url, branch, title }
 */
export async function publishChapter(book, plan, byline, token, left, tag) {
  const repo = book.content.repo;
  const t = await ghJson(`/repos/${repo}/git/trees`, token, left, { method: 'POST', body: { base_tree: plan.liveTree, tree: plan.files.map((f) => (f.content !== undefined ? { path: f.path, mode: '100644', type: 'blob', content: f.content } : { path: f.path, mode: f.mode, type: 'blob', sha: f.sha })) } });
  const headline = plan.rest ? 'Published the rest of the book' : `Published “${plan.title}”`;
  const what = plan.rest
    ? `the rest of the book: ${plan.files.map((f) => f.path).join(', ')}. Chapters wait for their own Publish, or Publish all.`
    : `${plan.removed ? 'this chapter removed' : 'this chapter only'}${plan.files.length > 1 ? `, with ${plan.files.filter((f) => f.path !== plan.files[0].path).map((f) => f.path === 'index.md' ? 'its Contents line' : f.path).join(', ')}` : ''}. The rest of the drafts waits for Publish all.`;
  const body = [`Published ${byline}: ${what}`, '', ...plan.commits.map((s) => `Publishes-commit: ${s}`)].join('\n');
  const c = await ghJson(`/repos/${repo}/git/commits`, token, left, { method: 'POST', body: { message: `${headline}\n\n${body}`, tree: t.sha, parents: [plan.live] } });
  const stem = plan.rest ? 'rest-of-the-book' : plan.files[0].path.split('/').pop().replace(/\.md$/, '');
  // An earlier publish of this chapter still open (its checks failed, say): this one replaces it.
  const open = await ghJson(`/repos/${repo}/pulls?state=open&base=${encodeURIComponent(book.content.live_branch)}&per_page=100`, token, left);
  for (const old of (open ?? []).filter((p) => String(p.head?.ref).startsWith(`publish-chapter/${stem}-`))) {
    await ghJson(`/repos/${repo}/pulls/${old.number}`, token, left, { method: 'PATCH', body: { state: 'closed' } }).catch(() => {});
    await gh(`/repos/${repo}/git/refs/heads/${encodePath(old.head.ref)}`, token, left, { method: 'DELETE', allow: [404, 422] }).catch(() => {});
  }
  const branch = `publish-chapter/${stem}-${Date.now().toString(36)}`;
  await ghJson(`/repos/${repo}/git/refs`, token, left, { method: 'POST', body: { ref: `refs/heads/${branch}`, sha: c.sha } });
  let pr;
  try {
    pr = await ghJson(`/repos/${repo}/pulls`, token, left, { method: 'POST', body: { title: plan.rest ? 'Publish the rest of the book' : `Publish “${plan.title}”`, head: branch, base: book.content.live_branch,
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
  return { number: pr.number, url: pr.html_url, branch, title: plan.rest ? 'The rest of the book' : plan.title, autoMerge: !r?.errors?.length };
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
