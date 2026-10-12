/**
 * The book's lint before publishing, as a job: book-requests' author-lint workflow
 * runs it (scripts/lint_book.mjs there, the book's own lint workflow's markdownlint
 * and config), never this function. Linting a whole book, up to 300 files, is far
 * more CPU and more GitHub calls than one request may use on the Worker.
 *
 *   lintAt(book, sha, left, { queue })
 *     -> { state: 'done', problems, files }  the answer for that commit
 *     -> { state: 'failed' }                 the workflow couldn't finish
 *     -> { state: 'checking' }               no answer yet (asked for now, with queue)
 *
 * The answer is lint/result.json on the branch author-lint/<book>/<sha> of the private
 * requests repo. A commit's lint never changes, so it is only ever read once there.
 */
import { REQUESTS_BOOK, REQUESTS_REPO, SHA_RE, appCredentials, gh, ghJson } from './author.mjs';

const requestsToken = appCredentials({ contents: 'write' });

export const lintBranch = (book, sha) => `author-lint/${book.slug}/${sha}`;

export async function lintAt(book, sha, left, { queue = false, tag = '' } = {}) {
  if (!SHA_RE.test(sha ?? '')) return { state: 'failed' };
  const { token } = await requestsToken(REQUESTS_BOOK, tag);
  const res = await gh(`/repos/${REQUESTS_REPO}/contents/lint/result.json?ref=${encodeURIComponent(lintBranch(book, sha))}`, token, left,
    { accept: 'application/vnd.github.raw', allow: [404] });
  if (res.status === 404) {
    if (queue) {
      // A repository_dispatch needs only contents:write, which the App has (a
      // workflow_dispatch would need actions:write). A second one for the same commit
      // finds the answer there and stops.
      await ghJson(`/repos/${REQUESTS_REPO}/dispatches`, token, left, {
        method: 'POST', body: { event_type: 'author-lint', client_payload: { book: book.slug, repo: book.content.repo, sha } },
      });
      console.log(`lint of ${book.slug}@${sha.slice(0, 7)} asked for ${tag}`);
    }
    return { state: 'checking' };
  }
  const r = await res.json().catch(() => null);
  if (r?.book !== book.slug || r?.sha !== sha || !r.ok || !Array.isArray(r.problems)) return { state: 'failed' };
  return { state: 'done', problems: r.problems, files: r.files };
}

/** For a publish screen: { lint } when answered, { lintJob } while checking, neither if it failed. */
export async function lintForPublish(book, sha, left, tag) {
  const l = await lintAt(book, sha, left, { queue: true, tag }).catch((err) => {
    console.warn(`lint of ${sha} not read — ${err.message} ${tag}`);
    return { state: 'failed' };
  });
  if (l.state === 'done') return { lint: { problems: l.problems, files: l.files }, lintJob: null };
  return { lint: null, lintJob: l.state === 'checking' ? { sha } : null };
}

/** One sentence for a refusal, naming the first few problems. */
export function lintWords(problems) {
  const pages = new Set(problems.map((p) => p.path)).size;
  const first = problems.slice(0, 3).map((p) => `${p.path} line ${p.line} (${p.description.toLowerCase()})`).join('; ');
  return `The drafts have ${problems.length} formatting ${problems.length === 1 ? 'problem' : 'problems'} in ${pages} ${pages === 1 ? 'page' : 'pages'}, `
    + `which must be put right before they go to readers: ${first}${problems.length > 3 ? '; and more' : ''}. `
    + 'Open each page on the author site, use Edit, and send the fix; nothing went live.';
}
