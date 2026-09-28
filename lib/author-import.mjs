/**
 * Word import for the author site: the staging layout in the PRIVATE requests repo
 * (book-requests), shared by api/author-import.js (upload, start, status) and
 * api/author-send.js (sending a finished import to drafts).
 *
 * An unpublished manuscript never touches a public repo until the author sends it.
 * Each import is one branch of its own in the requests repo:
 *
 *   author-imports/<id>
 *     request.json   written here: who, which book, the drafts commit to convert
 *                    against, and `attempt` (1, then +1 for each "convert again")
 *     source.docx    written here, from the uploaded parts
 *     result.json    written by book-requests' import-chapter workflow, for the
 *                    attempt it answers (see IMPORT_RESULT below)
 *     out/<path>     written by the workflow: each file to write, at out/ + its
 *                    path in the book (out/chapters/chapter-04.md, out/assets/...)
 *
 * A branch per import means no two imports (or an import and its workflow) ever
 * race for one ref, and cleaning up is deleting the branch: the workflow's
 * scheduled cleanup removes branches older than a few days.
 *
 * Upload parts reuse request-book's mechanism (2.5 MB each, 20 MB in all), with one
 * difference that matters: here the converted text is shown back to the author, so a
 * part is only ever accepted with a receipt this endpoint signed for the same login.
 * A forged or borrowed blob SHA would otherwise read someone else's private
 * manuscript out of the requests repo.
 *
 * IMPORT_RESULT (result.json), version 1:
 *   { version: 1, id, attempt, ok: true,
 *     book, base, login,
 *     chapter: { path, title, new: bool, replaces: null | { who, when, url, lines_differ } },
 *     writes: [{ path, staged: "out/<path>", kind: "chapter" | "picture" | "index" | "sources" }],
 *     deletes: [path],                 // pictures the Word file no longer has
 *     contents_line: string | null,    // the line added under "Contents" in index.md
 *     notes: [string],                 // e.g. "no Contents heading, so nothing was added"
 *     report: [{ level: "warn" | "info", text }] }  // convert.py's things worth checking
 *   or { version: 1, id, attempt, ok: false, error: "<words for the author>" }
 */
import { randomBytes } from 'node:crypto';
import { sign, verify } from './identity.mjs';
import { REQUESTS_REPO, Refusal, blobBytes, encodePath, gh, isAuthorPath, treeAt } from './author.mjs';

export const PART_BYTES = 2.5 * 1024 * 1024; // base64 3.4 MB: under Vercel's 4.5 MB body limit
export const MAX_BYTES = 20 * 1024 * 1024;
export const MAX_PARTS = Math.ceil(MAX_BYTES / PART_BYTES);
const RECEIPT_TTL_MS = 2 * 60 * 60 * 1000;
export const ID_RE = /^[0-9a-f]{20}$/;
export const branchOf = (id) => `author-imports/${id}`;
export const newId = () => randomBytes(10).toString('hex');

const lower = (s) => String(s).toLowerCase();

/** A receipt for one uploaded part, good for this login only. */
export const partReceipt = (secret, sha, identity, now = Date.now()) =>
  sign(secret, { k: 'part', sha, u: lower(identity.login), e: now + RECEIPT_TTL_MS });

/** The part's blob SHA, if the receipt is genuine, unexpired and this login's. */
export function readReceipt(secret, receipt, identity, now = Date.now()) {
  const p = verify(secret, receipt, now);
  if (!p || p.k !== 'part' || p.u !== lower(identity.login) || typeof p.sha !== 'string' || !/^[0-9a-f]{40}$/.test(p.sha)) return null;
  return p.sha;
}

/** A Word file name we can safely store: letters, digits, space, . _ - and ending .docx. */
export function safeDocxName(name) {
  const cleaned = String(name ?? '').normalize('NFKD').replace(/[^\w .-]+/g, '-').replace(/\s+/g, ' ').replace(/^[.\s-]+/, '').trim().slice(-100);
  return /\.docx$/i.test(cleaned) && cleaned.length > 5 ? cleaned : '';
}

/** An import's request, result and staged files, as its branch holds them now. */
export async function readImport(id, token, left) {
  if (!ID_RE.test(id ?? '')) throw new Refusal(400, 'validation: import id', "That import isn't one the author site knows.");
  const ref = await gh(`/repos/${REQUESTS_REPO}/git/ref/heads/${encodePath(branchOf(id))}`, token, left, { allow: [404] });
  if (ref.status === 404) throw new Refusal(404, 'import not found', 'That import has expired. Please bring the Word document in again.');
  const head = (await ref.json())?.object?.sha;
  const { files } = await treeAt(REQUESTS_REPO, head, token, left);
  const readJson = async (path) => {
    const f = files.get(path);
    if (!f) return null;
    try {
      return JSON.parse((await blobBytes(REQUESTS_REPO, f.sha, token, left)).toString('utf8'));
    } catch {
      return null;
    }
  };
  const request = await readJson('request.json');
  if (!request) throw new Refusal(404, 'import has no request', 'That import has expired. Please bring the Word document in again.');
  const result = await readJson('result.json');
  return { head, files, request, result: result && result.attempt === request.attempt ? result : null };
}

/** Refuses an import that isn't this author's, for this book. */
export function checkOwner(imp, book, identity) {
  if (lower(imp.request.login) !== lower(identity.login) || imp.request.book !== book.slug) {
    console.warn(`import ${imp.request.id}: asked for by @${identity.login} for ${book.slug}, but it is @${imp.request.login}'s for ${imp.request.book}`);
    throw new Refusal(403, 'not your import', "That import isn't one of yours.");
  }
}

/**
 * A finished result, checked before anything in it is shown or sent: every path it
 * writes or deletes is an author path, and every staged file is under out/ and exists.
 * Returns the result, or throws a Refusal.
 */
export function checkedResult(imp) {
  const r = imp.result;
  if (!r) return null;
  if (r.ok !== true) return r;
  const bad = (why) => {
    console.error(`import ${imp.request.id}: result refused — ${why}`);
    return new Refusal(502, `import result: ${why}`, 'The conversion came back in a shape the author site cannot use. Nothing was sent. Please try again.');
  };
  if (r.book !== imp.request.book || r.base !== imp.request.base) throw bad('book or base differs from the request');
  if (!Array.isArray(r.writes) || !Array.isArray(r.deletes ?? [])) throw bad('writes/deletes not lists');
  for (const w of r.writes) {
    if (!isAuthorPath(w?.path)) throw bad(`write outside the author paths: ${JSON.stringify(w?.path)}`);
    if (w.staged !== `out/${w.path}` || !imp.files.has(w.staged)) throw bad(`staged file missing for ${w.path}`);
  }
  for (const d of r.deletes ?? []) if (!isAuthorPath(d)) throw bad(`delete outside the author paths: ${JSON.stringify(d)}`);
  if (!isAuthorPath(r.chapter?.path)) throw bad('chapter path');
  return r;
}
