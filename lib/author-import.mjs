/**
 * Word import for the author site: the staging layout in the PRIVATE requests repo
 * (book-requests), shared by api/author-import.js (upload, start, status) and
 * api/author-send.js (sending a finished import to drafts).
 *
 * An unpublished manuscript never touches a public repo until the author sends it.
 * Each import is one branch of its own in the requests repo, made from its main
 * (so the push runs main's import-chapter workflow, which a branch without the
 * workflow file would not), with the import's own files under import/:
 *
 *   author-imports/<id>
 *     import/request.json   written here: who, which book, the drafts commit to
 *                           convert against, `attempt` (1, then +1 for each
 *                           "convert again"), and optionally `folder` (chapters or
 *                           a folder inside it) and `name` (outside chapters/ only)
 *     import/source.parts/000, 001, …
 *                           written here: the uploaded parts as they came, by blob
 *                           sha, never joined here (20 MB is too much CPU for one
 *                           request); the workflow joins them into
 *     import/source.docx    (whatever the document's type: request.json's `docx` is
 *                           its real name). Imports started before 11 Oct 2026 have
 *                           source.docx itself.
 *     import/result.json    written by book-requests' import-chapter workflow, for
 *                           the attempt it answers (see IMPORT_RESULT below)
 *     import/out/<path>     written by the workflow: each file to write, at its path
 *                           in the book (import/out/chapters/chapter-04.md, ...)
 *
 * A branch per import means no two imports (or an import and its workflow) ever
 * race for one ref, and cleaning up is deleting the branch: the workflow's
 * scheduled cleanup removes branches older than a few days.
 *
 * Upload parts reuse request-book's mechanism (1 MB each, 20 MB in all), with one
 * difference that matters: here the converted text is shown back to the author, so a
 * part is only ever accepted with a receipt this endpoint signed for the same login.
 * A forged or borrowed blob SHA would otherwise read someone else's private
 * manuscript out of the requests repo.
 *
 * IMPORT_RESULT (import/result.json), version 1:
 *   { version: 1, id, attempt, ok: true,
 *     book, base, login,
 *     chapter: { path, title, new: bool, how: "new" | "recorded" | "existing" | null, media_dir,
 *                replaces: null | { who, when, message, url, lines_differ: { removed, added } } },
 *     writes: [{ path, staged: "out/<path>", kind: "chapter" | "picture" | "index" | "sources" }],
 *     deletes: [path],                 // pictures the Word file no longer has
 *     removed_pictures: [name],        // the same, inside the chapter's pictures folder
 *     contents_line: string | null,    // the line added under "Contents" in index.md
 *     notes: [string],                 // e.g. "no Contents heading, so nothing was added"
 *     report: [{ level: "ok" | "look" | "warn", headline, body, check }],  // convert.report
 *     counts: { lines, words, pictures, headings, pipe_tables, html_tables, footnotes },
 *     pandoc: "<version>" }
 *   or { version: 1, id, attempt, ok: false, error: "<words for the author>" }
 *   `staged` is relative to import/.
 */
import { randomBytes } from 'node:crypto';
import { sign, verify } from './identity.mjs';
import { REQUESTS_REPO, Refusal, filesIn, graphqlRepo, isAuthorPath } from './author.mjs';

// The largest part taken (base64 3.4 MB: under Vercel's 4.5 MB body limit). The
// author site sends 1 MB parts, which keep each request well inside the Worker's CPU
// limit, so a document may have up to 20; its size is checked from the parts' sizes.
export const PART_BYTES = 2.5 * 1024 * 1024;
export const MAX_BYTES = 20 * 1024 * 1024;
export const MAX_PARTS = 20;
const RECEIPT_TTL_MS = 2 * 60 * 60 * 1000;
export const ID_RE = /^[0-9a-f]{20}$/;
export const branchOf = (id) => `author-imports/${id}`;
export const newId = () => randomBytes(10).toString('hex');
/** Where an import's own files sit on its branch. */
export const IMPORT_DIR = 'import/';
export const stagedAt = (staged) => `${IMPORT_DIR}${staged}`;

/**
 * Where the Word file goes, as the desktop app offered: the book's chapters folder
 * (the chapter-NN rule names it), or a folder inside it with a name of the author's
 * choosing (a concept page in chapters/Definitions keeps its name). Returns
 * { folder, name } or throws a Refusal.
 */
export function destination(folderIn, nameIn) {
  const folder = String(folderIn ?? '').trim() || 'chapters';
  if (folder !== 'chapters' && !(folder.startsWith('chapters/') && isAuthorPath(`${folder}/x.md`))) {
    throw new Refusal(400, 'validation: folder', "That folder isn't inside the book's chapters folder.");
  }
  if (folder === 'chapters') return { folder, name: null };
  let name = String(nameIn ?? '').trim();
  if (name && !/\.(md|markdown)$/i.test(name)) name += '.md';
  if (name && (name.includes('/') || !isAuthorPath(`${folder}/${name}`))) {
    throw new Refusal(400, 'validation: name', 'That name has characters a chapter name cannot have.');
  }
  return { folder, name: name || null };
}

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

/**
 * The documents an author may bring in, and how each one's bytes begin: .docx and
 * .odt are zip files, .doc an OLE compound file, .rtf text starting "{\\rtf".
 * book-requests turns anything but .docx into .docx (LibreOffice) before converting.
 */
export const WORD_TYPES = {
  docx: 'PK\x03\x04',
  odt: 'PK\x03\x04',
  doc: '\xD0\xCF\x11\xE0',
  rtf: '{\\rtf',
};
export const WORD_WORDS = 'a Word document (.docx or .doc), an OpenDocument text (.odt) or a Rich Text file (.rtf)';

/** A document name we can safely store: letters, digits, space, . _ - and ending in one of WORD_TYPES. */
export function safeWordName(name) {
  const cleaned = String(name ?? '').normalize('NFKD').replace(/[^\w .-]+/g, '-').replace(/\s+/g, ' ').replace(/^[.\s-]+/, '').trim().slice(-100);
  const ext = /\.([a-z]+)$/i.exec(cleaned)?.[1]?.toLowerCase();
  return ext && Object.hasOwn(WORD_TYPES, ext) && cleaned.length > ext.length + 1 ? cleaned : '';
}

/** Whether the bytes start the way a file of that name's type does. */
/** The most bytes looksLike reads: the longest magic number. */
export const MAGIC_BYTES = 8;

export function looksLike(name, bytes) {
  const magic = WORD_TYPES[name.split('.').pop().toLowerCase()];
  return Boolean(magic) && bytes.subarray(0, magic.length).toString('binary') === magic;
}

/** An import's request, result and staged files, as its branch holds them now. */
export async function readImport(id, token, left) {
  if (!ID_RE.test(id ?? '')) throw new Refusal(400, 'validation: import id', "That import isn't one the author site knows.");
  // One query for the head, request.json, result.json and the import folder's tree;
  // then that folder's listing only (not the whole requests repo).
  const text = (alias, path) => `${alias}: file(path: "${IMPORT_DIR}${path}") { object { ... on Blob { text } } }`;
  const r = await graphqlRepo(REQUESTS_REPO,
    `query($owner: String!, $name: String!, $ref: String!) { repository(owner: $owner, name: $name) { ref(qualifiedName: $ref) { target { oid ... on Commit { tree { oid }
      ${text('req', 'request.json')} ${text('res', 'result.json')} dir: file(path: "${IMPORT_DIR.replace(/\/$/, '')}") { oid } } } } } }`,
    { ref: `refs/heads/${branchOf(id)}` }, token, left);
  const t = r.ref?.target;
  if (!t) throw new Refusal(404, 'import not found', 'That import has expired. Please bring the Word document in again.');
  const json = (f) => {
    try {
      return JSON.parse(f?.object?.text);
    } catch {
      return null;
    }
  };
  const request = json(t.req);
  if (!request || !t.dir?.oid) throw new Refusal(404, 'import has no request', 'That import has expired. Please bring the Word document in again.');
  const result = json(t.res);
  const files = await filesIn(REQUESTS_REPO, t.dir.oid, token, left, IMPORT_DIR);
  return { head: t.oid, tree: t.tree.oid, files, request, result: result && result.attempt === request.attempt ? result : null };
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
    if (w.staged !== `out/${w.path}` || !imp.files.has(stagedAt(w.staged))) throw bad(`staged file missing for ${w.path}`);
  }
  for (const d of r.deletes ?? []) if (!isAuthorPath(d)) throw bad(`delete outside the author paths: ${JSON.stringify(d)}`);
  if (!isAuthorPath(r.chapter?.path)) throw bad('chapter path');
  return r;
}
