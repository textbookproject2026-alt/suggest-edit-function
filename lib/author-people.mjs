/**
 * A book's authors, changed by its authors on the author site (api/author-people.js,
 * api/author-people-change.js).
 *
 * A change is a pull request on textbook-registry that edits only that book's
 * `authors` line, opened by the GitHub App with auto-merge on: it lands once the
 * registry's checks are green, which is the registry's rule (a pull request and green
 * checks, no review). Access follows the registry this function was built with, so a
 * change is "pending" until deploy.yml has redeployed it with the merge: the merge
 * commit is compared with BUNDLE.sha, the X-Registry-Version every response carries.
 *
 * The pull request's branch says what it does (people/<slug>/<add|remove>-<login>-<ms>)
 * and its body who asked ("by @login via the author site").
 */
import { isDeepStrictEqual } from 'node:util';
import BUNDLE from '../registry/bundled.mjs';
import { Refusal, commitAuthor, encodePath, gh, ghJson } from './author.mjs';

export const REGISTRY_REPO = 'textbookproject2026-alt/textbook-registry';
export const REGISTRY_BOOK = { slug: 'textbook-registry', content: { repo: REGISTRY_REPO } };
/** An author of every book (the registry's README, `authors`), never removed from one here. */
export const PLATFORM_OWNER = 'textbookproject2026-alt';
export { AUTHOR_SITE } from './common.mjs';
import { AUTHOR_SITE } from './common.mjs';

export const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const BRANCH_RE = /^people\/([a-z0-9-]+)\/(add|remove|mentions-off|mentions-on)-([A-Za-z0-9-]+)-\d+$/;
/** The actions that change only `mentions_off`, each author for their own login. */
export const MENTION_ACTIONS = ['mentions-off', 'mentions-on'];
const BY_RE = /by @([A-Za-z0-9-]+) via the author site/i;
// ponytail: a merge older than this is taken as live without asking GitHub; deploy.yml
// fails loudly if production falls that far behind main.
const RECENT_MS = 24 * 60 * 60 * 1000;
// The registry's people-outcome job writes a failed change's reasons under this marker
// in its description (textbook-registry .github/workflows/validate.yml).
const OUTCOME_MARKER = '<!-- people-outcome -->';
// An open change with no recorded failure that is older than this has stalled: its
// checks never ran, or nothing merged it. Shown as failed rather than "on its way".
export const STALLED_MS = 60 * 60 * 1000;

export const lower = (s) => String(s).toLowerCase();

/** Whether this function was built with a registry that includes `sha`. */
async function isLive(sha, token, left) {
  if (!sha || sha === BUNDLE.sha) return Boolean(sha);
  const c = await ghJson(`/repos/${REGISTRY_REPO}/compare/${sha}...${BUNDLE.sha}`, token, left, { allow: [404] });
  return c?.behind_by === 0;
}

/**
 * The book's people changes still on their way: open pull requests, and merged ones
 * this function's registry doesn't include yet.
 * -> [{ number, url, action, login, by, state: "open"|"merged"|"failed", when, reasons? }]
 */
export async function pendingChanges(book, token, left) {
  const prs = await ghJson(`/repos/${REGISTRY_REPO}/pulls?state=all&base=main&sort=created&direction=desc&per_page=50`, token, left);
  const out = [];
  for (const p of prs ?? []) {
    const m = BRANCH_RE.exec(p.head?.ref ?? '');
    if (!m || m[1] !== book.slug) continue;
    if (p.state !== 'open' && !p.merged_at) continue; // closed unmerged: nothing changed
    if (p.merged_at && (Date.now() - Date.parse(p.merged_at) > RECENT_MS || await isLive(p.merge_commit_sha, token, left))) continue;
    out.push({
      number: p.number, url: p.html_url, action: m[2], login: m[3], by: BY_RE.exec(p.body ?? '')?.[1] ?? null,
      when: p.created_at ?? null, ...outcome(p),
    });
  }
  return out;
}

/** Whether an open or merged change went through: { state, reasons? }. */
export function outcome(p, now = Date.now()) {
  if (p.merged_at) return { state: 'merged' };
  const body = p.body ?? '';
  const at = body.indexOf(OUTCOME_MARKER);
  if (at >= 0) {
    const reasons = body.slice(at).split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim()).filter(Boolean);
    return { state: 'failed', reasons: reasons.length ? reasons : ["the platform's checks refused it"] };
  }
  if (now - Date.parse(p.created_at) > STALLED_MS) {
    return { state: 'failed', reasons: ["it has waited over an hour without going through, so something on the platform's side is stuck"] };
  }
  return { state: 'open' };
}

/** registry.json on the registry's main: its text, parsed, and where it sits. */
async function registryAtMain(token, left) {
  const ref = await ghJson(`/repos/${REGISTRY_REPO}/git/ref/heads/main`, token, left);
  const head = ref?.object?.sha;
  const commit = await ghJson(`/repos/${REGISTRY_REPO}/git/commits/${head}`, token, left);
  const tree = await ghJson(`/repos/${REGISTRY_REPO}/git/trees/${commit.tree.sha}`, token, left);
  const entry = (tree?.tree ?? []).find((e) => e.path === 'registry.json');
  if (!entry) throw new Error('registry.json not on main');
  const blob = await ghJson(`/repos/${REGISTRY_REPO}/git/blobs/${entry.sha}`, token, left);
  const text = Buffer.from(blob.content.replace(/\s+/g, ''), 'base64').toString('utf8');
  return { head, tree: commit.tree.sha, text, registry: JSON.parse(text) };
}

/**
 * The registry's text with only `slug`'s authors line rewritten, in the file's own
 * style (one line, `["a", "b"]`). Checked by parsing: everything else must be equal.
 */
export function withAuthors(text, registry, slug, authors) {
  const at = text.indexOf(`"slug": ${JSON.stringify(slug)}`);
  const next = text.indexOf('"slug":', at + 1);
  const re = /"authors":\s*\[[^\]\n]*\]/g;
  re.lastIndex = at;
  const m = at < 0 ? null : re.exec(text);
  if (!m || (next >= 0 && m.index > next)) {
    throw new Refusal(409, 'no authors line', "This book's authors can't be changed from here. Ask the platform's technical contact.");
  }
  const out = `${text.slice(0, m.index)}"authors": [${authors.map((a) => JSON.stringify(a)).join(', ')}]${text.slice(m.index + m[0].length)}`;
  const expected = structuredClone(registry);
  expected.books.find((b) => b.slug === slug).authors = authors;
  if (JSON.stringify(JSON.parse(out)) !== JSON.stringify(expected)) throw new Error('authors edit changed more than authors');
  return out;
}

/**
 * The registry's text with `slug`'s `mentions_off` set to `list`: its line rewritten,
 * or, if it has none, one added straight after `authors` in the same indent. Checked
 * by parsing, as withAuthors is.
 */
export function withMentionsOff(text, registry, slug, list) {
  const at = text.indexOf(`"slug": ${JSON.stringify(slug)}`);
  const next = text.indexOf('"slug":', at + 1);
  const end = next < 0 ? text.length : next;
  const line = `"mentions_off": [${list.map((a) => JSON.stringify(a)).join(', ')}]`;
  const old = /"mentions_off":\s*\[[^\]\n]*\]/g;
  old.lastIndex = Math.max(at, 0);
  const m = at < 0 ? null : old.exec(text);
  let out;
  if (m && m.index < end) out = `${text.slice(0, m.index)}${line}${text.slice(m.index + m[0].length)}`;
  else {
    const re = /^([ \t]*)"authors":\s*\[[^\]\n]*\]/gm;
    re.lastIndex = Math.max(at, 0);
    const a = at < 0 ? null : re.exec(text);
    if (!a || a.index > end) throw new Refusal(409, 'no authors line', "This book's settings can't be changed from here. Ask the platform's technical contact.");
    const after = a.index + a[0].length;
    out = `${text.slice(0, after)},\n${a[1]}${line}${text.slice(after)}`;
  }
  const expected = structuredClone(registry);
  expected.books.find((b) => b.slug === slug).mentions_off = list;
  if (!isDeepStrictEqual(JSON.parse(out), expected)) throw new Error('mentions_off edit changed more than mentions_off');
  return out;
}

/**
 * Opens the pull request for one change and switches auto-merge on.
 * -> { number, url, action, login, by, state: "open", when, warning? }
 */
export async function proposeChange({ book, action, login, identity, token, left, tag }) {
  const pending = await pendingChanges(book, token, left);
  if (pending.some((c) => c.state === 'open')) {
    throw new Refusal(409, 'change in progress', "Another change to this book's people is still going through. Try again once it has.");
  }
  // A failed change would otherwise sit on the same authors line for good: it is
  // closed, saying so, and this one starts from the registry as it is.
  for (const c of pending.filter((x) => x.state === 'failed')) {
    await ghJson(`/repos/${REGISTRY_REPO}/issues/${c.number}/comments`, token, left, { method: 'POST', body: { body: `Closed: it didn't go through, and @${identity.login} has made another change to this book's people from the author site.` } });
    await ghJson(`/repos/${REGISTRY_REPO}/pulls/${c.number}`, token, left, { method: 'PATCH', body: { state: 'closed' } });
    console.log(`people: closed failed #${c.number} on ${book.slug} ${tag}`);
  }
  const main = await registryAtMain(token, left);
  const entry = main.registry.books.find((b) => b.slug === book.slug);
  const current = entry?.authors ?? [];
  let next;
  let who = login;
  let text;
  if (MENTION_ACTIONS.includes(action)) {
    // Only for oneself, and only an author: who gets emailed is each author's own call.
    if (lower(login) !== lower(identity.login)) throw new Refusal(403, 'not yourself', 'You can only change this for yourself.');
    const off = entry?.mentions_off ?? [];
    const isOff = off.some((a) => lower(a) === lower(login));
    if ((action === 'mentions-off') === isOff) throw new Refusal(409, 'already so', action === 'mentions-off' ? "You're already not mentioned on new suggestions." : "You're already mentioned on new suggestions.");
    who = current.find((a) => lower(a) === lower(login)) ?? login;
    text = withMentionsOff(main.text, main.registry, book.slug, action === 'mentions-off' ? [...off, who] : off.filter((a) => lower(a) !== lower(login)));
  } else if (action === 'add') {
    if (current.some((a) => lower(a) === lower(login))) throw new Refusal(409, 'already an author', `@${login} is already one of this book's authors.`);
    const res = await gh(`/users/${encodeURIComponent(login)}`, token, left, { allow: [404] });
    if (res.status === 404) throw new Refusal(404, 'no such account', `There's no GitHub account called “${login}”. Check the spelling.`);
    const user = await res.json();
    if (user.type !== 'User') throw new Refusal(400, 'not a person', `@${user.login} is a GitHub ${String(user.type).toLowerCase()}, and only a person can sign in.`);
    if ((main.registry.platform?.automation_logins ?? []).some((a) => lower(a) === lower(user.login))) {
      throw new Refusal(400, 'automation login', `@${user.login} is one of the platform's automation accounts, which can't be an author.`);
    }
    who = user.login; // the account's own case: the registry's github-facts check asks for it
    next = [...current, who];
  } else {
    const i = current.findIndex((a) => lower(a) === lower(login));
    if (i < 0) throw new Refusal(409, 'not an author', `@${login} isn't one of this book's authors.`);
    who = current[i];
    if (lower(who) === lower(PLATFORM_OWNER)) throw new Refusal(403, 'platform owner', `@${who} looks after the platform and is an author of every book, so they can't be removed here.`);
    if (current.length === 1) throw new Refusal(409, 'last author', `@${who} is this book's only author, so they can't be removed.`);
    next = current.filter((_, k) => k !== i);
  }
  text ??= withAuthors(main.text, main.registry, book.slug, next);

  const by = `by @${identity.login} via the author site`;
  const subject = {
    add: `${book.slug}: add ${who} to authors (${by})`,
    remove: `${book.slug}: remove ${who} from authors (${by})`,
    'mentions-off': `${book.slug}: stop mentioning ${who} on new suggestions (${by})`,
    'mentions-on': `${book.slug}: mention ${who} on new suggestions again (${by})`,
  }[action];
  const branch = `people/${book.slug}/${action}-${who}-${Date.now()}`;
  const blob = await ghJson(`/repos/${REGISTRY_REPO}/git/blobs`, token, left, { method: 'POST', body: { content: text, encoding: 'utf-8' } });
  const tree = await ghJson(`/repos/${REGISTRY_REPO}/git/trees`, token, left, { method: 'POST', body: { base_tree: main.tree, tree: [{ path: 'registry.json', mode: '100644', type: 'blob', sha: blob.sha }] } });
  const commit = await ghJson(`/repos/${REGISTRY_REPO}/git/commits`, token, left, { method: 'POST', body: { message: subject, tree: tree.sha, parents: [main.head], author: commitAuthor(identity) } });
  await ghJson(`/repos/${REGISTRY_REPO}/git/refs`, token, left, { method: 'POST', body: { ref: `refs/heads/${branch}`, sha: commit.sha } });

  const body = MENTION_ACTIONS.includes(action)
    ? [action === 'mentions-off'
      ? `${who} is no longer @mentioned (and so not emailed by GitHub) when a reader suggests a change to **${entry.title}**, once this change has gone through.`
      : `${who} is @mentioned again (and so emailed by GitHub) when a reader suggests a change to **${entry.title}**, once this change has gone through.`, '', `Changed ${by}.`]
    : action === 'add'
    ? [`@${who}: you've been invited to work on **${entry.title}** as one of its authors. Once this change has gone through (usually a few minutes after its checks pass), sign in at ${AUTHOR_SITE} with this GitHub account.`,
      '', `Added ${by}.`]
    : [`${who} is no longer one of the authors of **${entry.title}** once this change has gone through.`, '', `Removed ${by}.`];
  body.push('', '---', MENTION_ACTIONS.includes(action)
    ? `This changes only \`mentions_off\` for \`${book.slug}\` in registry.json, from the author site. It merges by itself once the registry's checks are green (auto-merge), and takes effect when deploy.yml has redeployed the suggest-edit function with it.`
    : `This changes only \`authors\` for \`${book.slug}\` in registry.json, from the author site. It merges by itself once the registry's checks are green (auto-merge), and access ${action === 'add' ? 'starts' : 'ends'} when deploy.yml has redeployed the suggest-edit function with it.`);
  let pr;
  try {
    pr = await ghJson(`/repos/${REGISTRY_REPO}/pulls`, token, left, { method: 'POST', body: { title: subject.replace(` (${by})`, ''), head: branch, base: 'main', body: body.join('\n') } });
  } catch (err) {
    await gh(`/repos/${REGISTRY_REPO}/git/refs/heads/${encodePath(branch)}`, token, left, { method: 'DELETE', allow: [404, 422] }).catch(() => {});
    throw err;
  }

  let warning;
  const res = await gh('/graphql', token, left, { method: 'POST', body: {
    query: 'mutation($id: ID!, $method: PullRequestMergeMethod!) { enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $method }) { pullRequest { number } } }',
    variables: { id: pr.node_id, method: 'SQUASH' },
  } }).then((r) => r.json()).catch((err) => ({ errors: [{ message: err.message }] }));
  if (res?.errors?.length) {
    console.warn(`people: auto-merge not switched on for #${pr.number}: ${res.errors.map((e) => e.message).join('; ')} ${tag}`);
    warning = "The change couldn't be set to go through by itself, so it waits for the platform's technical contact to merge it.";
  }
  console.log(`people: #${pr.number} ${action} ${who} on ${book.slug} ${tag}`);
  return { number: pr.number, url: pr.html_url, action, login: who, by: identity.login, state: 'open', when: pr.created_at ?? null, ...(warning ? { warning } : {}) };
}

/** The App's token on the registry, with a sentence that fits if it isn't installed there. */
export async function registryCredential(appToken, tag) {
  try {
    return await appToken(REGISTRY_BOOK, tag);
  } catch (err) {
    if (err instanceof Refusal && /isn't installed/.test(err.message)) {
      err.userMessage = "Changing a book's people isn't switched on yet. Ask the platform's technical contact.";
    }
    throw err;
  }
}

/** What the People panel shows: who has access now, and what is on its way. */
export async function people(book, token, left) {
  return {
    authors: book.authors ?? [],
    mentionsOff: book.mentions_off ?? [],
    owner: PLATFORM_OWNER,
    registry: BUNDLE.sha,
    pending: await pendingChanges(book, token, left),
  };
}

