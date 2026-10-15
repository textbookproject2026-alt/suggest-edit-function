/**
 * The console's reads that the author endpoints share (api/author-read.js lists,
 * api/author-act.js re-checks before it writes): reader suggestions, commits since a
 * suggestion was accepted, and the drafts-to-live publish request.
 */
import { Refusal, draftsHead, encodePath, ghJson, isAuthorPath } from './author.mjs';
import { ACCEPTED, describePublish, mergeState, notOpen, parseLinkCheck, parseSuggestion, servedBy, servesRule } from './author-console.mjs';
import { lintForPublish } from './lint-job.mjs';
import { kept } from './kv-cache.mjs';

/** When the `accepted` label was last put on an issue, or null. */
export async function acceptedAt(book, number, token, left) {
  const events = await ghJson(`/repos/${book.content.repo}/issues/${number}/events?per_page=100`, token, left);
  const times = (events ?? [])
    .filter((e) => e?.event === 'labeled' && e.label?.name === ACCEPTED && e.created_at)
    .map((e) => e.created_at);
  return times.sort().pop() ?? null;
}

/** Commits on drafts that changed `path` after `since`, newest first. */
export async function changesSince(book, path, since, token, left) {
  const list = await ghJson(
    `/repos/${book.content.repo}/commits?sha=${encodeURIComponent(book.content.drafts_branch)}`
    + `&path=${encodeURIComponent(path)}&since=${encodeURIComponent(since)}&per_page=20`, token, left);
  return (list ?? []).filter((c) => c?.sha).map((c) => ({
    sha: c.sha,
    url: c.html_url ?? `https://github.com/${book.content.repo}/commit/${c.sha}`,
    who: c.author?.login || c.commit?.author?.name || '',
    when: c.commit?.author?.date ?? null,
    message: String(c.commit?.message ?? '').split('\n')[0],
  }));
}

/** An open reader suggestion of this book's, or a Refusal. */
export async function suggestion(book, number, token, left) {
  if (!Number.isSafeInteger(number) || number <= 0) throw new Refusal(400, 'validation: number', "That suggestion isn't one the author site listed.");
  const issue = await ghJson(`/repos/${book.content.repo}/issues/${number}`, token, left);
  const s = parseSuggestion(issue);
  if (!s) throw new Refusal(404, 'not a suggestion', "That isn't a reader's suggestion for this book.");
  return s;
}

/** The one open pull request from drafts into live, or null. */
export async function openPublishRequest(book, token, left) {
  const [owner] = book.content.repo.split('/');
  const list = await ghJson(
    `/repos/${book.content.repo}/pulls?state=open&base=${encodeURIComponent(book.content.live_branch)}`
    + `&head=${encodeURIComponent(`${owner}:${book.content.drafts_branch}`)}&per_page=10`, token, left);
  return (list ?? [])[0] ?? null;
}

export async function compareDrafts(book, token, left) {
  // The compare of two commits never changes: kept (memory, and KV on the Worker) under
  // both heads, trimmed to what the author site uses. GitHub's full answer was 142 KB of
  // JSON on the ontology book, parsed by every Drafts, Publish and History read against
  // the Worker's 10 ms of CPU (13 Oct). The heads are two small ref reads.
  const repo = book.content.repo;
  const [live, drafts] = await Promise.all([
    headOf(repo, book.content.live_branch, token, left),
    draftsHead(book, token, left),
  ]);
  return kept(`cmp:${repo}:${live}...${drafts}`, COMPARE_KEEP_MS, async () =>
    trimCompare(await ghJson(`/repos/${repo}/compare/${live}...${drafts}`, token, left)));
}

const COMPARE_KEEP_MS = 7 * 86_400_000;

async function headOf(repo, branch, token, left) {
  const sha = (await ghJson(`/repos/${repo}/git/ref/heads/${encodePath(branch)}`, token, left))?.object?.sha;
  if (typeof sha !== 'string') throw new Error(`${branch} ref returned no sha`);
  return sha;
}

/** Only what describePublish, notOpen, publishRequestBody, draftsDiff and the History tab read. */
export function trimCompare(c) {
  if (!c || typeof c !== 'object') return c;
  return {
    ahead_by: c.ahead_by,
    base_commit: c.base_commit ? { sha: c.base_commit.sha } : null,
    files: (c.files ?? []).filter((f) => f && typeof f === 'object').map((f) => ({
      filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions,
      ...(f.previous_filename ? { previous_filename: f.previous_filename } : {}),
    })),
    commits: (c.commits ?? []).filter((x) => x && typeof x === 'object').map((x) => ({
      sha: x.sha,
      commit: { message: x.commit?.message ?? '', author: { name: x.commit?.author?.name ?? null } },
      author: x.author?.login ? { login: x.author.login } : null,
    })),
  };
}

/** GitHub works mergeability out in the background: ask up to `tries` times. */
export async function mergeability(book, number, token, left, tries = 1) {
  for (let i = 0; i < tries; i++) {
    const pr = await ghJson(`/repos/${book.content.repo}/pulls/${number}`, token, left);
    const state = mergeState(pr);
    if (state !== 'unknown' || i + 1 === tries) return state;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return 'unknown';
}

/**
 * The rule the live site's builder used for which repo paths it serves, from its
 * served marker; null if the site doesn't say (or can't be reached in time), and
 * the going-live list then doesn't split.
 */
export async function liveServes(book) {
  try {
    const res = await fetch(`https://${book.site.domain}/.well-known/textbook.json`, { signal: AbortSignal.timeout(4000) });
    return res.ok ? servesRule(await res.json()) : null;
  } catch {
    return null;
  }
}

/**
 * What a publish request would put live, checked: the book's lint at its head (null
 * until the author-lint job has answered: lintJob says it is being checked; neither
 * if it couldn't be) and the link check's last word on it.
 */
export async function publishChecks(book, pr, token, left) {
  const head = pr.head?.sha;
  const [checked, comments] = await Promise.all([
    head ? lintForPublish(book, head, left, `book=${book.slug}`) : { lint: null, lintJob: null },
    ghJson(`/repos/${book.content.repo}/issues/${pr.number}/comments?per_page=100`, token, left).catch(() => []),
  ]);
  return { ...checked, links: parseLinkCheck(comments, head) };
}

export async function publishState(book, token, left, tries = 1) {
  const [compare, existing, rule] = await Promise.all([compareDrafts(book, token, left), openPublishRequest(book, token, left), liveServes(book)]);
  if (!existing) {
    if ((Number(compare?.ahead_by) || 0) <= 0) return { publish: null };
    // No request yet: the drafts' own lint, so the author sees what would stop it first.
    const head = compare?.commits?.at(-1)?.sha;
    const { lint, lintJob } = head ? await lintForPublish(book, head, left, `book=${book.slug}`) : { lint: null, lintJob: null };
    return { publish: { ...notOpen(compare), ...(lint ? { lint: lint.problems.slice(0, 100), lint_count: lint.problems.length } : {}), ...(lintJob ? { lint_job: lintJob } : {}) } };
  }
  const [state, checks] = await Promise.all([mergeability(book, existing.number, token, left, tries), publishChecks(book, existing, token, left)]);
  return { publish: describePublish(existing, compare, state, rule, checks) };
}

/**
 * The person behind a commit, never a bot: for the App's commits, the member its byline
 * names ("Edited by Alec Gordon (member m-…) via the author site"; "Accepted by @login"
 * gives only the login) or the reader whose proposal it accepted; for anyone else, their
 * login (the author site knows their name). -> { who: name | null, login? }
 */
export function personOf(c) {
  const msg = String(c?.commit?.message ?? '');
  const by = /\bby (?:@([A-Za-z0-9-]{1,39})|(.{1,80}?) \(member m-[0-9a-f]{10}\)) via the author site/.exec(msg);
  if (by) return by[1] ? { who: null, login: by[1] } : { who: by[2] };
  const login = c?.author?.login ?? '';
  if (!login || /\[bot\]$/.test(login)) {
    const reader = /^- #\d+ proposed edit .*? by (.{1,80})$/m.exec(msg)?.[1]?.trim();
    if (reader) return { who: reader };
    const name = c?.commit?.author?.name ?? '';
    return { who: login || /\[bot\]$/.test(name) ? null : name || null };
  }
  return { who: null, login };
}

/**
 * What the drafts hold that the live book doesn't, file by file, for the author
 * site's Drafts tab: only what readers see (the live site's own rule; without one,
 * the author paths less chapter-sources.json), each with who last changed it on
 * drafts and when. The site reads both versions of each file itself (public raw).
 * -> { live, drafts, files: [{ path, status, previous?, who, login?, when }], more }
 */
export async function draftsDiff(book, token, left) {
  const [compare, rule, head] = await Promise.all([compareDrafts(book, token, left), liveServes(book), draftsHead(book, token, left)]);
  const shown = (compare?.files ?? []).filter((f) => f?.filename
    && (rule ? servedBy(rule, f.filename) : isAuthorPath(f.filename) && f.filename !== 'chapter-sources.json'));
  const MAX = 40;
  const files = await Promise.all(shown.slice(0, MAX).map(async (f) => {
    const list = await ghJson(`/repos/${book.content.repo}/commits?sha=${head}&path=${encodeURIComponent(f.filename)}&per_page=1`, token, left).catch(() => []);
    const c = list?.[0];
    return {
      path: f.filename,
      status: f.status,
      ...(f.previous_filename ? { previous: f.previous_filename } : {}),
      ...(c ? personOf(c) : { who: null }),
      when: c?.commit?.author?.date ?? null,
    };
  }));
  return { live: compare?.base_commit?.sha ?? null, drafts: head, files, more: Math.max(0, shown.length - MAX) };
}
