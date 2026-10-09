/**
 * POST /api/author-act — the console's actions for a signed-in author of the book:
 * answering reader suggestions, accepting or declining draft changes, and sending the
 * drafts to the live book. Made by the GitHub App; every comment, merge message and
 * publish description names the author ("by @login via the author site").
 *
 *   { book, action: "suggestion-accept", number }
 *       taken on by hand: a thank-you saying so, labelled `accepted`, left open
 *   { book, action: "suggestion-decline", number }
 *       a polite reply, then closed
 *   { book, action: "suggestion-made", number, sha }
 *       closes an accepted suggestion with a link to `sha`, which must be the newest
 *       commit on drafts to have changed its page since it was accepted
 *       (GET author-read?what=suggestion-changes names it)
 *   { book, action: "change-accept", number, title? }
 *       squash-merges a draft change (an open PR into drafts) and puts the drafts in
 *       line for the live book (opens or refreshes the one publish request)
 *   { book, action: "change-decline", number }
 *       a note saying who declined it, then closed
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
import { lintBook, lintWords } from '../lib/book-lint.mjs';
import {
  SHA_RE, Refusal, appCredentials, authorise, bookFor, budget, byline, fail, ghJson, limits, wrap,
} from '../lib/author.mjs';
import { ensureLabels, isJsonContentType, parseBody, send } from '../lib/common.mjs';
import {
  ACCEPTED, ACCEPTED_LABEL, NEEDS_TRIAGE, PUBLISH_STATE_WORDS, PUBLISH_TITLE, PUBLISHED_STEPS, checkReply, declined,
  describePublish, publishRequestBody, takenOn, thanksWithChange,
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
  await ensureLabels(book.content.repo, token, ACCEPTED_LABEL, 2500);
  try {
    await ghJson(`/repos/${book.content.repo}/issues/${s.number}/labels`, token, left, { method: 'POST', body: { labels: [ACCEPTED] } });
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
  const s = await suggestion(book, number(body), token, left);
  if (!s.open) throw new Refusal(409, 'closed', 'That suggestion has already been dealt with.');
  await comment(book, token, left, s.number, declined(identity));
  await dropLabel(book, token, left, s.number, NEEDS_TRIAGE, tag);
  try {
    await ghJson(`/repos/${book.content.repo}/issues/${s.number}`, token, left, { method: 'PATCH', body: { state: 'closed', state_reason: 'not_planned' } });
  } catch (err) {
    console.error(`suggestion #${s.number}: close failed — ${err.message} ${tag}`);
    return { done: true, steps: ['A polite reply was sent.'], warning: 'The reply was sent, but the suggestion could not be closed.' };
  }
  console.log(`suggestion #${s.number} declined ${byline(identity)} ${tag}`);
  return { done: true, steps: ['A polite reply was sent.', 'The suggestion was closed.'] };
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
async function draftChange(book, n, token, left) {
  const pr = await ghJson(`/repos/${book.content.repo}/pulls/${n}`, token, left);
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
async function coAuthors(book, pr, token, left, tag) {
  try {
    const commits = await ghJson(`/repos/${book.content.repo}/pulls/${pr.number}/commits?per_page=100`, token, left);
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

async function changeAccept(book, body, ctx) {
  const { token, left, identity, tag } = ctx;
  const pr = await draftChange(book, number(body), token, left);
  const title = String(body.title ?? pr.title ?? 'Accepted draft change').replace(/\s+/g, ' ').slice(0, 200);
  const credits = await coAuthors(book, pr, token, left, tag);
  const merged = await ghJson(`/repos/${book.content.repo}/pulls/${pr.number}/merge`, token, left, {
    method: 'PUT',
    body: {
      merge_method: 'squash',
      commit_title: `${title} (#${pr.number})`,
      commit_message: `Proposed in #${pr.number}.\n\nAccepted ${byline(identity)}.${credits}`,
      sha: pr.head?.sha,
    },
  });
  if (!merged?.merged) throw new Refusal(502, 'merge not confirmed', 'GitHub did not confirm the change was accepted. Press “Check again” and look before trying once more.');
  console.log(`draft change #${pr.number} accepted ${byline(identity)} ${tag}`);
  const steps = ['The change was folded into the drafts area.'];
  let publish;
  try {
    publish = await openOrRefresh(book, token, left, identity, tag);
  } catch (err) {
    console.error(`publish request: ${err.message} ${tag}`);
    return { done: true, steps, publish: null, warning:
      'The change is safely in the drafts area, but it could not be put in line for the live book. Nothing has reached readers, and nothing was lost. Press “Put it in line” to try again.' };
  }
  if (!publish) {
    steps.push('The live book already has this, so there is nothing waiting to go to readers.');
    return { done: true, steps, publish: null };
  }
  steps.push(publish.opened
    ? 'It was put in line for the live book, along with everything else waiting in the drafts area.'
    : 'It joined the changes already in line for the live book.');
  steps.push('Nothing has reached readers yet. Publishing is a separate press, under “Going live”.');
  if (publish.state !== 'conflict') steps.push(publish.state_words);
  return { done: true, steps, publish, ...(publish.state === 'conflict' ? { warning: publish.state_words } : {}) };
}

async function changeDecline(book, body, ctx) {
  const { token, left, identity, tag } = ctx;
  const pr = await draftChange(book, number(body), token, left);
  await comment(book, token, left, pr.number, `Declined ${byline(identity)}. Thank you for proposing it.`);
  await ghJson(`/repos/${book.content.repo}/pulls/${pr.number}`, token, left, { method: 'PATCH', body: { state: 'closed' } });
  console.log(`draft change #${pr.number} declined ${byline(identity)} ${tag}`);
  return { done: true, steps: ['The draft change was closed, with a note saying you declined it.'] };
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
  const lint = await lintBook(book, existing.head?.sha, token, left).catch(() => null);
  if (!lint) throw new Refusal(409, 'not mergeable: unchecked', PUBLISH_STATE_WORDS.unchecked, { state: 'unchecked' });
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
  if (limits.write(auth.identity.login.toLowerCase(), Date.now())) {
    console.warn(`rate limit: ${tag}`);
    send(res, 429, { error: 'rate limit exceeded', userMessage: "You're doing a lot very quickly — please wait a little while." });
    return;
  }
  let credential;
  try {
    credential = await appToken(book, tag);
    send(res, 200, await act(book, body, { token: credential.token, left: budget(22_000), identity: auth.identity, tag }));
  } catch (err) {
    fail(res, err, tag, credential?.refused);
  }
});
