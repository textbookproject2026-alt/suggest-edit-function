/**
 * The console's reads that the author endpoints share (api/author-read.js lists,
 * api/author-act.js re-checks before it writes): reader suggestions, commits since a
 * suggestion was accepted, and the drafts-to-live publish request.
 */
import { Refusal, encodePath, ghJson } from './author.mjs';
import { ACCEPTED, describePublish, mergeState, notOpen, parseSuggestion, servesRule } from './author-console.mjs';

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
  return ghJson(
    `/repos/${book.content.repo}/compare/${encodePath(book.content.live_branch)}...${encodePath(book.content.drafts_branch)}`,
    token, left);
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

export async function publishState(book, token, left, tries = 1) {
  const [compare, existing, rule] = await Promise.all([compareDrafts(book, token, left), openPublishRequest(book, token, left), liveServes(book)]);
  if (!existing) return { publish: (Number(compare?.ahead_by) || 0) > 0 ? notOpen(compare) : null };
  return { publish: describePublish(existing, compare, await mergeability(book, existing.number, token, left, tries), rule) };
}
