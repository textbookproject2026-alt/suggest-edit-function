/**
 * POST /api/author-act — the console's actions for a signed-in author of the book:
 * answering reader suggestions, accepting or declining draft changes, and sending the
 * drafts to the live book. Made by the GitHub App; every comment, merge message and
 * publish description names the author ("by @login via the author site").
 *
 *   { book, action: "suggestion-accept", number }
 *       taken on by hand: a thank-you saying so, labelled `accepted`, left open
 *   { book, action: "suggestion-decline", number, reason }
 *       the reason (10–1000 characters, public) under the member's name, the polite
 *       reply, then closed as not planned and locked (a written suggestion or a note)
 *   { book, action: "suggestion-made", number, sha }
 *       closes an accepted suggestion with a link to `sha`, which must be the newest
 *       commit on drafts to have changed its page since it was accepted
 *       (GET author-read?what=suggestion-changes names it)
 *   { book, action: "change-accept", number, title?, resolve? }
 *       squash-merges a draft change (an open PR into drafts) and puts the drafts in
 *       line for the live book (opens or refreshes the one publish request); merged
 *       again word by word if the drafts moved. resolve "suggestion" is the same;
 *       "edit" keeps the drafts' words where both changed them and answers `edit`
 *       ({ path, line, paragraphs }) for the editor (lib/author-console.mjs CHOICES)
 *   { book, action: "change-decline", number, reason }
 *       the reason, a note thanking them, then closed unmerged and locked
 *   { book, action: "review-accept", path, drafts, hunks: [id] }
 *       Review all in chapter (lib/review.mjs): the ticked hunks, merged again here
 *       against the drafts, in one commit on drafts, all or nothing. Its parents are
 *       the drafts and the head of every proposal ticked whole, so GitHub marks those
 *       merged; one ticked in part is closed unmerged with the parts quoted and labelled
 *       accepted-in-part (credited); a written suggestion ticked is closed as completed
 *       with the thank-you. `drafts` is the commit the view was built on: if the drafts
 *       moved, nothing is written and the answer is 409 { view, kept, invalid }
 *   { book, action: "part-decline", number, reason, part }
 *       a part left over from a proposal accepted in part, declined: the reason and the
 *       part, as a comment on it
 *   { book, action: "part-keep", number }
 *       a proposal accepted in part, opened again for its other parts
 *   { book, action: "comment-add", number, text }
 *       a comment by the member on a declined item (2–1000 characters, public)
 *   { book, action: "comment-delete", number, id }
 *       deletes one of the member's own comments on a declined item
 *   { book, action: "publish-prepare" }
 *       opens or refreshes the publish request; publishes nothing
 *   { book, action: "publish", number, confirm: true }
 *       merges the publish request, only if it is the one the author was shown and
 *       GitHub says it can merge cleanly
 *     -> 200 { done, steps, warning?, publish? }
 *     -> 4xx/5xx { error, userMessage }
 *
 * Accepting a suggestion *with* the change made goes through api/author-send.js
 * (one send path), which replies and closes after the commit.
 */
import { lintAt, lintWords } from '../lib/lint-job.mjs';
import { ACCEPTED_IN_PART, ACCEPTED_IN_PART_LABEL, acceptance, applyTicks, gather, rebase, viewOf } from '../lib/review.mjs';
import { NEEDS_LOOK, markNeedsLook, readPull, reapply, startRefresh } from '../lib/reapply.mjs';
import { platform } from '../lib/platform.mjs';
import {
  GitHubError, SHA_RE, Refusal, appCredentials, authorise, bookFor, budget, byline, fail, gh, ghJson, graphqlRepo, isAuthorPath, limits, wrap,
} from '../lib/author.mjs';
import { isJsonContentType, parseBody, send, withLabels } from '../lib/common.mjs';
import { cacheKeys, forget } from '../lib/kv-cache.mjs';
import { COMMENT_MIN, cleanText, commentOf, declineComment, isDeclined, kindOf, memberComment } from '../lib/declined.mjs';
import {
  ACCEPTED, ACCEPTED_LABEL, NEEDS_TRIAGE, PUBLISH_STATE_WORDS, PUBLISH_TITLE, PUBLISHED_STEPS, checkReply, declined,
  CHOICES, describeChange, describePublish, pageName, publishRequestBody, takenOn, thanksWithChange,
} from '../lib/author-console.mjs';
import {
  acceptedAt, changesSince, compareDrafts, liveServes, mergeability, openPublishRequest, publishChecks, suggestion,
} from '../lib/author-console-reads.mjs';

const appToken = appCredentials({ contents: 'write', pull_requests: 'write', issues: 'write' });

const number = (body) => {
  const n = body.number;
  if (!Number.isSafeInteger(n) || n <= 0) throw new Refusal(400, 'validation: number', "That isn't one the author site listed.");
  return n;
};

async function dropLabel(book, token, left, n, label, tag) {
  try {
    await ghJson(`/repos/${book.content.repo}/issues/${n}/labels/${encodeURIComponent(label)}`, token, left, { method: 'DELETE', allow: [404] });
  } catch (err) {
    console.warn(`#${n}: label ${label} not removed — ${err.message} ${tag}`);
  }
}

async function comment(book, token, left, n, text) {
  return ghJson(`/repos/${book.content.repo}/issues/${n}/comments`, token, left, { method: 'POST', body: { body: text } });
}

/** A decline's reason, checked before anything is written: required, 10–1000 characters. */
function reasonOf(body) {
  const r = cleanText(body.reason);
  if (r.error) throw new Refusal(400, 'validation: reason', `Why is this being declined? ${r.error}`);
  return r.text;
}

/** Declined items take no replies on GitHub: only the book's people comment, here. */
async function lock(book, token, left, n, tag) {
  try {
    await ghJson(`/repos/${book.content.repo}/issues/${n}/lock`, token, left, { method: 'PUT', body: { lock_reason: 'resolved' } });
  } catch (err) {
    console.warn(`#${n}: not locked — ${err.message} ${tag}`);
  }
}

/**
 * `fn` on a declined item whose conversation is locked: the App can't write on a
 * locked conversation, so it unlocks, writes and locks again (readers never get the
 * gap: GitHub's lock is only about who may comment there).
 */
async function whileUnlocked(book, token, left, it, tag, fn) {
  if (!it.locked) return fn();
  await ghJson(`/repos/${book.content.repo}/issues/${it.number}/lock`, token, left, { method: 'DELETE', allow: [404] });
  try {
    return await fn();
  } finally {
    await lock(book, token, left, it.number, tag);
  }
}

// --- comments on declined items ---------------------------------------------------

async function declinedThing(book, n, token, left) {
  const it = await ghJson(`/repos/${book.content.repo}/issues/${n}`, token, left);
  if (!it || !kindOf(it) || !isDeclined(it)) throw new Refusal(404, 'not declined', "That isn't a declined proposal, note or suggestion of this book.");
  return it;
}

async function commentAdd(book, body, ctx) {
  const { token, left, identity, tag } = ctx;
  if (!identity.member) throw new Refusal(403, 'members only', 'Only the book\'s people can comment here.');
  const t = cleanText(body.text, COMMENT_MIN);
  if (t.error) throw new Refusal(400, 'validation: text', t.error);
  const it = await declinedThing(book, number(body), token, left);
  const c = await whileUnlocked(book, token, left, it, tag, () => comment(book, token, left, it.number, memberComment(t.text, identity)));
  console.log(`#${it.number}: comment ${c?.id} by ${identity.login} ${tag}`);
  return { done: true, id: c?.id ?? null, steps: ['Your comment was added. Anyone can read it in the book\'s history.'] };
}

async function commentDelete(book, body, ctx) {
  const { token, left, identity, tag } = ctx;
  const id = body.id;
  if (!Number.isSafeInteger(id) || id <= 0) throw new Refusal(400, 'validation: id', "That isn't a comment the author site listed.");
  const it = await declinedThing(book, number(body), token, left);
  const c = await ghJson(`/repos/${book.content.repo}/issues/comments/${id}`, token, left, { allow: [404] }).catch(() => null);
  const d = c ? commentOf(c) : null;
  // Only the member's own comment, on this item.
  if (!d || !String(c.issue_url ?? '').endsWith(`/issues/${it.number}`) || !identity.member || d.member !== identity.login) {
    throw new Refusal(403, 'not yours', 'You can only delete your own comments.');
  }
  await whileUnlocked(book, token, left, it, tag, () => ghJson(`/repos/${book.content.repo}/issues/comments/${id}`, token, left, { method: 'DELETE' }));
  console.log(`#${it.number}: comment ${id} deleted by ${identity.login} ${tag}`);
  return { done: true, steps: ['Your comment was deleted.'] };
}

// --- suggestions ---------------------------------------------------------------

async function suggestionAccept(book, body, ctx) {
  const { token, left, identity, tag } = ctx;
  const s = await suggestion(book, number(body), token, left);
  if (!s.open) throw new Refusal(409, 'closed', 'That suggestion has already been dealt with.');
  if (s.accepted) {
    throw new Refusal(409, 'already accepted', 'You have already accepted this one, and the reader has been thanked. Once the change is in the drafts area, press “I\'ve made the change”.');
  }
  const reply = takenOn(identity);
  checkReply(reply);
  await comment(book, token, left, s.number, reply);
  await dropLabel(book, token, left, s.number, NEEDS_TRIAGE, tag);
  try {
    await withLabels(book.content.repo, token, ACCEPTED_LABEL, () => gh(`/repos/${book.content.repo}/issues/${s.number}/labels`, token, left, { method: 'POST', body: { labels: [ACCEPTED] }, allow: [404, 422] }), 2500)
      .then((r) => { if (!r.ok) throw new Error(`status ${r.status}`); });
  } catch (err) {
    console.error(`suggestion #${s.number}: accepted label failed — ${err.message} ${tag}`);
    return { done: true, steps: ['A thank-you was sent, saying you will make the change by hand.'],
      warning: 'The thank-you was sent, but the suggestion could not be marked as accepted. It is still open.' };
  }
  console.log(`suggestion #${s.number} taken on ${byline(identity)} ${tag}`);
  return { done: true, steps: [
    'A thank-you was sent, saying you will make the change by hand. The chapter itself was not changed.',
    'The suggestion stays in the list, marked Accepted, until the change is made. Once it is in the drafts area, open it and press “I\'ve made the change”.',
  ] };
}

async function suggestionDecline(book, body, ctx) {
  const { token, left, identity, tag } = ctx;
  const reason = reasonOf(body);
  const s = await suggestion(book, number(body), token, left);
  if (!s.open) throw new Refusal(409, 'closed', 'That suggestion has already been dealt with.');
  await comment(book, token, left, s.number, declineComment(reason, identity));
  await comment(book, token, left, s.number, declined(identity));
  await dropLabel(book, token, left, s.number, NEEDS_TRIAGE, tag);
  try {
    await ghJson(`/repos/${book.content.repo}/issues/${s.number}`, token, left, { method: 'PATCH', body: { state: 'closed', state_reason: 'not_planned' } });
  } catch (err) {
    console.error(`suggestion #${s.number}: close failed — ${err.message} ${tag}`);
    return { done: true, steps: ['A polite reply was sent.'], warning: 'The reply was sent, but the suggestion could not be closed.' };
  }
  await lock(book, token, left, s.number, tag);
  console.log(`suggestion #${s.number} declined ${byline(identity)} ${tag}`);
  return { done: true, steps: ['Your reason was posted, with a polite reply.', 'The suggestion was closed. It shows as Declined in the book\'s history.'] };
}

async function suggestionMade(book, body, ctx) {
  const { token, left, identity, tag } = ctx;
  const s = await suggestion(book, number(body), token, left);
  if (!s.open) throw new Refusal(409, 'closed', 'That suggestion has already been dealt with.');
  if (!s.accepted) throw new Refusal(409, 'not accepted', "This suggestion hasn't been accepted yet.");
  const since = await acceptedAt(book, s.number, token, left);
  const changes = since ? await changesSince(book, s.path, since, token, left) : [];
  const newest = changes[0];
  if (!newest) {
    throw new Refusal(409, 'no change yet', `Nothing has changed ${s.page} in the drafts area since you accepted this, so there is no change to show the reader yet.`);
  }
  if (!SHA_RE.test(String(body.sha ?? '')) || body.sha !== newest.sha) {
    throw new Refusal(409, 'moved', 'The page has changed again since you looked, so nothing was sent. Please look again.', { change: newest });
  }
  const reply = thanksWithChange(newest.url, identity);
  checkReply(reply, newest.url);
  await comment(book, token, left, s.number, reply);
  await dropLabel(book, token, left, s.number, ACCEPTED, tag);
  try {
    await ghJson(`/repos/${book.content.repo}/issues/${s.number}`, token, left, { method: 'PATCH', body: { state: 'closed', state_reason: 'completed' } });
  } catch (err) {
    console.error(`suggestion #${s.number}: close failed — ${err.message} ${tag}`);
    return { done: true, steps: ['A thank-you was sent, with a link to your change.'], warning: 'The thank-you was sent, but the suggestion could not be marked as dealt with.' };
  }
  console.log(`suggestion #${s.number} closed with ${newest.sha.slice(0, 7)} ${byline(identity)} ${tag}`);
  return { done: true, steps: ['A thank-you was sent, with a link to your change.', 'The suggestion was marked as dealt with.'] };
}

// --- draft changes and going live -------------------------------------------------

/** An open PR into this book's drafts branch, from anywhere, or a Refusal. */
async function draftChange(book, n, token, left, read = null) {
  const pr = read ?? await ghJson(`/repos/${book.content.repo}/pulls/${n}`, token, left);
  if (pr?.state !== 'open' || pr.base?.ref !== book.content.drafts_branch
      || String(pr.base?.repo?.full_name).toLowerCase() !== book.content.repo.toLowerCase()) {
    throw new Refusal(409, 'not an open draft change', "That isn't an open draft change for this book any more. Press “Check again”.");
  }
  return pr;
}

/** Open the one publish request, or rewrite its description. Returns the publish info, or null (nothing waiting). */
async function openOrRefresh(book, token, left, identity, tag) {
  const [compare, existing] = await Promise.all([compareDrafts(book, token, left), openPublishRequest(book, token, left)]);
  if (!existing && (Number(compare?.ahead_by) || 0) <= 0) return null;
  const body = publishRequestBody(compare, identity);
  let pr = existing;
  let opened = false;
  if (existing) {
    try {
      pr = await ghJson(`/repos/${book.content.repo}/pulls/${existing.number}`, token, left, { method: 'PATCH', body: { title: PUBLISH_TITLE, body } });
    } catch (err) {
      // It carries the drafts whatever its description says.
      console.warn(`publish request #${existing.number}: description not rewritten — ${err.message} ${tag}`);
    }
  } else {
    try {
      pr = await ghJson(`/repos/${book.content.repo}/pulls`, token, left, {
        method: 'POST', body: { title: PUBLISH_TITLE, body, head: book.content.drafts_branch, base: book.content.live_branch },
      });
      opened = true;
    } catch (err) {
      // Someone else may have opened one in the moment between looking and asking.
      pr = await openPublishRequest(book, token, left);
      if (!pr) throw err;
    }
  }
  const [state, rule, checks] = await Promise.all([mergeability(book, pr.number, token, left, 4), liveServes(book), publishChecks(book, pr, token, left)]);
  const info = describePublish(pr, compare, state, rule, checks);
  return { ...info, opened };
}

/**
 * Co-authored-by trailers for the people whose commits the change holds. A squash
 * merge's author is whoever opened the pull request, which for a signed-in reader's
 * in-site edit is the App; the reader's own commits carry their noreply address, and
 * this keeps their credit in the one commit that lands. Bots are left out.
 */
async function coAuthors(book, pr, token, left, tag, read = null) {
  try {
    const commits = read ?? await ghJson(`/repos/${book.content.repo}/pulls/${pr.number}/commits?per_page=100`, token, left);
    const seen = new Map();
    for (const c of commits ?? []) {
      const a = c?.commit?.author;
      if (!a?.email || /\[bot\]/.test(`${a.name} ${a.email} ${c.author?.login ?? ''}`) || c.author?.type === 'Bot') continue;
      if (!seen.has(a.email.toLowerCase())) seen.set(a.email.toLowerCase(), `Co-authored-by: ${a.name.replace(/[<>\n]/g, '')} <${a.email}>`);
    }
    return seen.size ? `\n\n${[...seen.values()].join('\n')}` : '';
  } catch (err) {
    console.warn(`#${pr.number}: commit authors not read — ${err.message} ${tag}`);
    return '';
  }
}

// The `resolve` values change-accept takes, from the one list the page's buttons come from.
const RESOLVES = new Set(Object.values(CHOICES).filter((c) => c.action === 'change-accept' && c.resolve).map((c) => c.resolve));

const hasLook = (pr) => (pr.labels ?? []).some((l) => l?.name === NEEDS_LOOK);
const OVERLAP_WORDS = 'This suggestion was made on an older version of this paragraph.';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Re-apply a proposal onto the drafts as they are now, or refuse in words the author can act on.
 * `partial` (Edit before accepting): an overlap keeps the drafts' words there instead of refusing.
 * -> { sha, overlaps }
 */
async function refreshed(book, pr, ctx, commits, partial = false) {
  const { token, left, tag } = ctx;
  if (platform.cpuCapped) {
    // Merging it again is more than the Worker's 10 ms of CPU allows on top of an accept:
    // answered 503 at once, before any of it, so the page sends it to the Actions fallback
    // ("Applying…"), which runs this same accept with no cap.
    console.log(`draft change #${pr.number}: the drafts moved under it, left to the fallback to merge again ${tag}`);
    throw new Refusal(503, 'reapply in actions', 'Applying… this can take up to a minute.');
  }
  const r = await reapply(book, pr, token, left, { commits, partial });
  if (r.state === 'overlap') {
    if (!hasLook(pr)) await markNeedsLook(book, pr.number, true, token, left, tag);
    throw new Refusal(409, 'overlap', OVERLAP_WORDS, { overlap: { number: pr.number, paragraphs: r.overlaps }, choices: CHOICES });
  }
  if (r.state === 'already') {
    throw new Refusal(409, 'already in drafts', 'Everything this suggestion changes is already in the drafts, so there is nothing left to accept. You can decline it as outdated.');
  }
  if (r.state === 'unsupported') {
    throw new Refusal(409, 'cannot reapply', `The drafts have changed since this suggestion was made, and it can't be brought up to date here because ${r.why}. Open it on GitHub, or decline it as outdated.`);
  }
  if (hasLook(pr)) await markNeedsLook(book, pr.number, false, token, left, tag);
  console.log(`draft change #${pr.number} brought up to date with the drafts${r.state === 'partial' ? ', the drafts\' words kept where both changed them' : ''} ${tag}`);
  return { sha: r.sha, overlaps: r.overlaps ?? [] };
}

/** Squash-merge at `sha`; GitHub may take a moment to see a branch that just moved. -> merged, or the GitHub error. */
async function squash(book, pr, sha, message, ctx) {
  const { token, left } = ctx;
  for (let i = 0; ; i++) {
    try {
      return await ghJson(`/repos/${book.content.repo}/pulls/${pr.number}/merge`, token, left, { method: 'PUT', body: { ...message, merge_method: 'squash', sha } });
    } catch (err) {
      if (!(err instanceof GitHubError) || err.status !== 405 || i >= 3 || !ctx.retry) throw err;
      await sleep(1500);
    }
  }
}

async function changeAccept(book, body, ctx) {
  const { token, left, identity, tag } = ctx;
  // Never the suggester's copy of a paragraph that changed since: "use" is a plain accept
  // (word by word), "edit" keeps the drafts' words where both changed them (CHOICES).
  if (body.resolve !== undefined && !RESOLVES.has(body.resolve)) throw new Refusal(400, 'validation: resolve', "That isn't one of the choices offered.");
  const partial = body.resolve === CHOICES.edit.resolve;
  // Accepted already (a second click, or Actions finishing what the API began): done, not an error.
  const was = await readPull(book.content.repo, number(body), token, left);
  if (!was) throw new Refusal(409, 'not an open draft change', "That isn't an open draft change for this book any more. Press “Check again”.");
  if (was?.merged && was.base?.ref === book.content.drafts_branch) {
    return { done: true, steps: ['This change is already in the drafts area.'], publish: null };
  }
  const pr = await draftChange(book, number(body), token, left, was);
  const title = String(body.title ?? pr.title ?? 'Accepted draft change').replace(/\s+/g, ' ').slice(0, 200);
  const commits = await ghJson(`/repos/${book.content.repo}/pulls/${pr.number}/commits?per_page=100`, token, left);
  const credits = await coAuthors(book, pr, token, left, tag, commits);
  const message = { commit_title: `${title} (#${pr.number})`, commit_message: `Proposed in #${pr.number}.\n\nAccepted ${byline(identity)}.${credits}` };
  // A proposal GitHub can't merge (the drafts changed under it): merged again word by word first.
  let sha = pr.head?.sha;
  let redone = false;
  let kept = [];
  if (pr.mergeable === false) {
    ({ sha, overlaps: kept } = await refreshed(book, pr, ctx, commits, partial));
    redone = true;
  }
  let merged;
  try {
    merged = await squash(book, pr, sha, message, { ...ctx, retry: redone });
  } catch (err) {
    if (!(err instanceof GitHubError) || err.status !== 405 || redone) throw err;
    ({ sha, overlaps: kept } = await refreshed(book, pr, ctx, commits, partial)); // GitHub hadn't yet said it couldn't merge
    merged = await squash(book, pr, sha, message, { ...ctx, retry: true });
  }
  if (!merged?.merged) throw new Refusal(502, 'merge not confirmed', 'GitHub did not confirm the change was accepted. Press “Check again” and look before trying once more.');
  console.log(`draft change #${pr.number} accepted ${byline(identity)} ${tag}`);
  const steps = [kept.length
    ? 'The reader\'s change was folded into the drafts area, except where you had both changed the same words: there your wording was kept.'
    : 'The change was folded into the drafts area.'];
  // The other proposals on its page, brought up to date (or marked "needs a look") so the
  // next Accept just works: in Actions (proposals.yml, about a minute), as that is more
  // GitHub calls and merging than an accept has time or CPU for.
  const path = describeChange(pr).path;
  // Edit before accepting: where the editor opens next, with what was kept beside it.
  const edit = partial && (kept[0]?.path ?? path) ? { path: kept[0]?.path ?? path, line: kept[0]?.line ?? null, paragraphs: kept } : undefined;
  // The in-site editor's copy of the page (kept ahead in KV): the next reader starts from this.
  if (path) await forget(cacheKeys.source(book.content.repo, book.content.drafts_branch, path));
  if (path) {
    try {
      await startRefresh(book.slug, path, left, tag);
      steps.push('Other suggestions on this page are being brought up to date, so they can be accepted too (about a minute).');
    } catch (err) {
      console.warn(`after #${pr.number}: other proposals not refreshed — ${err.message} ${tag}`);
    }
  }
  let publish;
  try {
    publish = await openOrRefresh(book, token, left, identity, tag);
  } catch (err) {
    console.error(`publish request: ${err.message} ${tag}`);
    return { done: true, steps, publish: null, edit, warning:
      'The change is safely in the drafts area, but it could not be put in line for the live book. Nothing has reached readers, and nothing was lost. Press “Put it in line” to try again.' };
  }
  if (!publish) {
    steps.push('The live book already has this, so there is nothing waiting to go to readers.');
    return { done: true, steps, publish: null, edit };
  }
  steps.push(publish.opened
    ? 'It was put in line for the live book, along with everything else waiting in the drafts area.'
    : 'It joined the changes already in line for the live book.');
  steps.push('Nothing has reached readers yet. Publishing is a separate press, under “Going live”.');
  if (publish.state !== 'conflict') steps.push(publish.state_words);
  return { done: true, steps, publish, edit, ...(publish.state === 'conflict' ? { warning: publish.state_words } : {}) };
}

async function changeDecline(book, body, ctx) {
  const { token, left, identity, tag } = ctx;
  const reason = reasonOf(body);
  const pr = await draftChange(book, number(body), token, left);
  await comment(book, token, left, pr.number, declineComment(reason, identity));
  await comment(book, token, left, pr.number, `Declined ${byline(identity)}. Thank you for proposing it.`);
  await ghJson(`/repos/${book.content.repo}/pulls/${pr.number}`, token, left, { method: 'PATCH', body: { state: 'closed' } });
  await lock(book, token, left, pr.number, tag);
  console.log(`draft change #${pr.number} declined ${byline(identity)} ${tag}`);
  return { done: true, steps: ['The draft change was closed, with your reason and a note thanking them.', 'It shows as Declined in the book\'s history.'] };
}

// --- Review all in chapter (lib/review.mjs) ------------------------------------------------

const MAX_TICKS = 500;
const quoted = (t) => t.trim().replace(/@/g, '@​').split('\n').map((l) => `> ${l}`.trimEnd()).join('\n');
const itemWords = (a) => `#${a.item.number} ${a.item.kind === 'edit' ? `proposed edit “${String(a.item.title).replace(/\s+/g, ' ').slice(0, 120)}”` : 'suggestion'} by ${a.item.who}`
  + (a.all ? '' : ` (${a.ticked.length} of ${a.item.hunks.length} changes)`);

/** `fn` over `list`, `n` at a time: a few dozen comments and closes, without GitHub's abuse limits. */
async function inTurn(list, n, fn) {
  for (let i = 0; i < list.length; i += n) await Promise.all(list.slice(i, i + n).map(fn));
}

/** The drafts moved, or what was ticked no longer holds: nothing written, the view as it is now. */
async function rebuilt(book, path, ids, ctx, words) {
  const g = await gather(book, path, ctx.token, ctx.left);
  if (!g) throw new Refusal(409, 'page gone', 'That page isn’t in the drafts any more.');
  const view = viewOf(g, path);
  const { kept, invalid } = rebase(view, ids);
  throw new Refusal(409, 'review moved', words, { view, kept, invalid });
}

/** Whether GitHub has marked these pull requests merged yet: { n: merged }. */
async function mergedYet(book, numbers, ctx) {
  const r = await graphqlRepo(book.content.repo, `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) {
    ${numbers.map((n) => `p${n}: pullRequest(number: ${Number(n)}) { merged }`).join(' ')} } }`, {}, ctx.token, ctx.left);
  return Object.fromEntries(numbers.map((n) => [n, Boolean(r[`p${n}`]?.merged)]));
}

async function reviewAccept(book, body, ctx) {
  const { token, left, identity, tag } = ctx;
  const path = body.path;
  if (!isAuthorPath(path)) throw new Refusal(400, 'validation: path', 'That page is outside what the author site works on.');
  if (!SHA_RE.test(String(body.drafts ?? ''))) throw new Refusal(400, 'validation: drafts', 'Please reload the review and try again.');
  const ids = body.hunks;
  if (!Array.isArray(ids) || ids.length > MAX_TICKS || ids.some((x) => typeof x !== 'string' || x.length > 80)) {
    throw new Refusal(400, 'validation: hunks', 'Please reload the review and try again.');
  }
  if (!ids.length) throw new Refusal(400, 'validation: none ticked', 'Tick at least one change to accept.');
  if (platform.cpuCapped) {
    // Merging every proposal again is far more than the Worker's 10 ms of CPU: answered
    // 503 at once, before any of it, and the page sends it to the Actions fallback.
    console.log(`review of ${path}: left to the fallback ${tag}`);
    throw new Refusal(503, 'review in actions', 'Applying… this can take up to a minute.');
  }
  const g = await gather(book, path, token, left);
  if (!g) throw new Refusal(409, 'page gone', 'That page isn’t in the drafts any more.');
  const view = viewOf(g, path);
  if (g.drafts !== body.drafts) {
    const { kept, invalid } = rebase(view, ids);
    throw new Refusal(409, 'review moved', 'The drafts changed while you were reviewing, so nothing was accepted. The review has been brought up to date.', { view, kept, invalid });
  }
  const done = applyTicks(view, ids);
  if (done.error) {
    const { kept, invalid } = rebase(view, ids);
    throw new Refusal(409, 'review changed', 'Some of what you ticked can’t be accepted as it stands, so nothing was accepted.', { view, kept, invalid });
  }
  const accepted = [...acceptance(view, ids).values()];
  const whole = accepted.filter((a) => a.item.kind === 'edit' && a.all);
  const text = g.crlf ? done.text.replace(/\n/g, '\r\n') : done.text;
  const repo = book.content.repo;
  const t = await ghJson(`/repos/${repo}/git/trees`, token, left, { method: 'POST', body: { base_tree: g.tree, tree: [{ path, mode: '100644', type: 'blob', content: text }] } });
  const n = accepted.length;
  const message = [`Accept ${n} reader ${n === 1 ? 'suggestion' : 'suggestions'} on ${pageName(path)}`, '', ...accepted.map((a) => `- ${itemWords(a)}`), '', `Accepted ${byline(identity)}.`].join('\n');
  // The drafts first, then each proposal accepted whole: GitHub marks those merged (14 Oct, checked on the test book).
  const c = await ghJson(`/repos/${repo}/git/commits`, token, left, { method: 'POST', body: { message, tree: t.sha, parents: [g.drafts, ...whole.map((a) => g.heads.get(a.item.number))] } });
  try {
    await ghJson(`/repos/${repo}/git/refs/heads/${encodeURIComponent(book.content.drafts_branch)}`, token, left, { method: 'PATCH', body: { sha: c.sha, force: false } });
  } catch (err) {
    // Not a fast-forward: someone saved meanwhile. The commit is left unreferenced.
    if (err instanceof GitHubError && err.status === 422) return rebuilt(book, path, ids, ctx, 'The drafts changed just as you accepted, so nothing was accepted. The review has been brought up to date.');
    throw err;
  }
  const url = `https://github.com/${repo}/commit/${c.sha}`;
  console.log(`review of ${path}: ${done.hunks.length} change(s) from ${n} item(s) in ${c.sha.slice(0, 7)} ${byline(identity)} ${tag}`);
  const warnings = [];
  const others = n - 1;
  // Accepted whole: thanked; GitHub marks it merged once it sees the commit (seconds).
  let merged = {};
  for (let i = 0; whole.length && i < 8; i++) {
    merged = await mergedYet(book, whole.map((a) => a.item.number), ctx).catch(() => merged);
    if (whole.every((a) => merged[a.item.number])) break;
    await sleep(2500);
  }
  const notMerged = whole.filter((a) => !merged[a.item.number]).map((a) => `#${a.item.number}`);
  if (notMerged.length) warnings.push(`GitHub hasn't yet marked ${notMerged.join(', ')} as merged. The change is in the drafts either way.`);
  await inTurn(accepted, 4, async (a) => {
    const n = a.item.number;
    try {
      if (a.item.kind === 'edit' && a.all) {
        await comment(book, token, left, n, `Accepted ${byline(identity)}${others ? `, together with ${others} other reader ${others === 1 ? 'suggestion' : 'suggestions'} on this page,` : ''} into the drafts in one change: ${url}\n\nIt reaches readers the next time the book goes live. Thank you for proposing it.`);
        await markNeedsLook(book, n, false, token, left, tag);
      } else if (a.item.kind === 'edit') {
        await comment(book, token, left, n, [`Thank you for this. Part of it was accepted ${byline(identity)} and is now in the drafts: ${url}`, '',
          `The ${a.ticked.length === 1 ? 'part' : 'parts'} accepted:`, '', a.ticked.map((x) => quoted(x.to)).join('\n\n'), '',
          'The rest wasn\'t taken this time, so this proposal is closed. You are credited for what was accepted, and it reaches readers the next time the book goes live.'].join('\n'));
        await withLabels(repo, token, ACCEPTED_IN_PART_LABEL, () => gh(`/repos/${repo}/issues/${n}/labels`, token, left, { method: 'POST', body: { labels: [ACCEPTED_IN_PART] }, allow: [404, 422] }), 2500);
        await ghJson(`/repos/${repo}/pulls/${n}`, token, left, { method: 'PATCH', body: { state: 'closed' } });
      } else {
        const reply = thanksWithChange(url, identity);
        checkReply(reply, url);
        await comment(book, token, left, n, reply);
        await dropLabel(book, token, left, n, NEEDS_TRIAGE, tag);
        await dropLabel(book, token, left, n, ACCEPTED, tag);
        await ghJson(`/repos/${repo}/issues/${n}`, token, left, { method: 'PATCH', body: { state: 'closed', state_reason: 'completed' } });
      }
    } catch (err) {
      console.error(`review: #${n} not answered — ${err.message} ${tag}`);
      warnings.push(`#${n} is in the drafts, but the reader couldn't be answered on it just now.`);
    }
  });
  await forget(cacheKeys.source(repo, book.content.drafts_branch, path));
  try {
    await startRefresh(book.slug, path, left, tag);
  } catch (err) {
    console.warn(`after review: other proposals not refreshed — ${err.message} ${tag}`);
  }
  let publish = null;
  try {
    publish = await openOrRefresh(book, token, left, identity, tag);
  } catch (err) {
    console.error(`publish request: ${err.message} ${tag}`);
    warnings.push('It could not be put in line for the live book. Press “Put it in line” under Drafts.');
  }
  return {
    done: true, sha: c.sha, url,
    accepted: accepted.map((a) => ({ key: a.item.key, number: a.item.number, all: a.all, hunks: a.ticked.map((x) => x.id) })),
    steps: [`${done.hunks.length === 1 ? 'One change' : `${done.hunks.length} changes`} from ${n === 1 ? 'one reader item' : `${n} reader items`} went into the drafts as one change.`,
      'Nothing has reached readers yet. Publishing is a separate press, under “Going live”.'],
    publish, ...(warnings.length ? { warning: warnings.join(' ') } : {}),
  };
}

/** A proposal accepted in part (closed, labelled), or a Refusal. */
async function partly(book, n, ctx) {
  const pr = await readPull(book.content.repo, n, ctx.token, ctx.left);
  if (!pr || pr.merged || !pr.labels.some((l) => l.name === ACCEPTED_IN_PART)) throw new Refusal(409, 'not accepted in part', 'That isn’t a proposal accepted in part.');
  return pr;
}

async function partDecline(book, body, ctx) {
  const { token, left, identity, tag } = ctx;
  const reason = reasonOf(body);
  const part = String(body.part ?? '').replace(/<!--|-->/g, '').slice(0, 5000);
  const pr = await partly(book, number(body), ctx);
  await comment(book, token, left, pr.number, `${declineComment(reason, identity)}${part.trim() ? `\n\nThe part declined:\n\n${quoted(part)}` : ''}`);
  console.log(`#${pr.number}: a part declined ${byline(identity)} ${tag}`);
  return { done: true, steps: ['Your reason was posted on the proposal, with the part it is about.'] };
}

async function partKeep(book, body, ctx) {
  const { token, left, identity, tag } = ctx;
  const pr = await partly(book, number(body), ctx);
  if (pr.state !== 'open') await ghJson(`/repos/${book.content.repo}/pulls/${pr.number}`, token, left, { method: 'PATCH', body: { state: 'open' } });
  const path = describeChange(pr).path;
  if (path) await startRefresh(book.slug, path, left, tag).catch((err) => console.warn(`#${pr.number}: not refreshed — ${err.message} ${tag}`));
  console.log(`#${pr.number}: open again for its other parts ${byline(identity)} ${tag}`);
  return { done: true, steps: ['The proposal is open again: its other parts wait in the review.'] };
}

async function publishPrepare(book, body, ctx) {
  const publish = await openOrRefresh(book, ctx.token, ctx.left, ctx.identity, ctx.tag);
  return { done: true, steps: [publish ? 'The drafts are in line for the live book.' : 'The live book already has everything in the drafts area.'], publish };
}

async function publish(book, body, ctx) {
  const { token, left, identity, tag } = ctx;
  const n = number(body);
  if (body.confirm !== true) throw new Refusal(400, 'validation: confirm', 'Please tick the box to confirm before publishing.');
  // Only ever the one request the author was shown: a screen left open while the
  // drafts moved on must not merge something else into the live book.
  const existing = await openPublishRequest(book, token, left);
  if (!existing || existing.number !== n) {
    throw new Refusal(409, 'publish request changed', 'What is waiting to go live has changed since this screen was drawn, so nothing was published. Press “Check again” and look at it before publishing.');
  }
  const state = await mergeability(book, n, token, left, 3);
  if (state !== 'clean') {
    throw new Refusal(409, `not mergeable: ${state}`, PUBLISH_STATE_WORDS[state] ?? PUBLISH_STATE_WORDS.unknown, { state });
  }
  // The book's lint on exactly what goes live: a problem, or no answer, stops it.
  const lint = await lintAt(book, existing.head?.sha, left, { queue: true, tag }).catch(() => ({ state: 'failed' }));
  if (lint.state === 'checking') throw new Refusal(409, 'not mergeable: checking', PUBLISH_STATE_WORDS.checking, { state: 'checking', lint_job: { sha: existing.head?.sha } });
  if (lint.state !== 'done') throw new Refusal(409, 'not mergeable: unchecked', PUBLISH_STATE_WORDS.unchecked, { state: 'unchecked' });
  if (lint.problems.length) {
    throw new Refusal(409, 'not mergeable: lint', lintWords(lint.problems), { state: 'lint', lint: lint.problems.slice(0, 100), lint_count: lint.problems.length });
  }
  try {
    await ghJson(`/repos/${book.content.repo}/pulls/${n}`, token, left, {
      method: 'PATCH', body: { body: `${existing.body ?? ''}\n\n**Published ${byline(identity)}.**` },
    });
  } catch (err) {
    console.warn(`publish request #${n}: could not note who published — ${err.message} ${tag}`);
  }
  // A merge commit, not a squash: drafts is long-lived and must stay an ancestor of live.
  const merged = await ghJson(`/repos/${book.content.repo}/pulls/${n}/merge`, token, left, {
    method: 'PUT',
    body: { merge_method: 'merge', commit_title: PUBLISH_TITLE, commit_message: `Published ${byline(identity)}.`, sha: existing.head?.sha },
  });
  if (!merged?.merged) {
    throw new Refusal(502, 'merge not confirmed', 'GitHub did not confirm that this was published, so it may not have been. Press “Check again” and look before trying once more.');
  }
  console.log(`published #${n} to ${book.content.live_branch} ${byline(identity)} ${tag}`);
  return { done: true, steps: [...PUBLISHED_STEPS] };
}

const ACTIONS = {
  'suggestion-accept': suggestionAccept,
  'suggestion-decline': suggestionDecline,
  'suggestion-made': suggestionMade,
  'change-accept': changeAccept,
  'change-decline': changeDecline,
  'review-accept': reviewAccept,
  'part-decline': partDecline,
  'part-keep': partKeep,
  'comment-add': commentAdd,
  'comment-delete': commentDelete,
  'publish-prepare': publishPrepare,
  publish,
};

export default wrap(async (req, res) => {
  const auth = await authorise(req, res, 'POST');
  if (!auth) return;
  if (!isJsonContentType(req)) {
    send(res, 415, { error: 'unsupported content-type' });
    return;
  }
  let body;
  try {
    body = parseBody(req);
  } catch {
    send(res, 400, { error: 'body was not valid json' });
    return;
  }
  if (!body || typeof body !== 'object') {
    send(res, 400, { error: 'body was not a json object' });
    return;
  }
  const act = Object.hasOwn(ACTIONS, body.action) ? ACTIONS[body.action] : null;
  if (!act) {
    send(res, 400, { error: 'validation: action' });
    return;
  }
  const book = bookFor(body.book, auth, res);
  if (!book) return;
  const tag = `${auth.tag} book=${book.slug} action=${body.action}`;
  if (await limits.write(auth.identity.login.toLowerCase(), Date.now())) {
    console.warn(`rate limit: ${tag}`);
    send(res, 429, { error: 'rate limit exceeded', userMessage: "You're doing a lot very quickly — please wait a little while." });
    return;
  }
  let credential;
  try {
    credential = await appToken(book, tag);
    // A review's batch runs in Actions (no CPU cap), answering up to a few dozen items.
    const out = await act(book, body, { token: credential.token, left: budget(body.action === 'review-accept' ? 150_000 : 22_000), identity: auth.identity, tag });
    // Declined, answered, commented: the History lists change.
    await forget(...cacheKeys.lists(book.slug));
    send(res, 200, out);
  } catch (err) {
    fail(res, err, tag, credential?.refused);
  }
});
