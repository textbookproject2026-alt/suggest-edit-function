/**
 * /api/author-import — bring a Word document into a book, for a signed-in author.
 * Conversion happens in the PRIVATE requests repo (book-requests' import-chapter
 * workflow, with the same convert.py and contents.py the desktop app used), never in
 * a public repo; lib/author-import.mjs has the staging layout.
 *
 *   POST JSON { part }                       one piece of the .docx, base64, at most
 *     -> 201 { receipt }                     2.5 MB decoded (request-book's parts).
 *                                            The receipt is good for this login only.
 *   POST JSON { action: "start", book, name, parts: [receipt, …], folder?, chapterName? }
 *     -> 201 { id, attempt, base }           name: the Word file's name. Converted
 *                                            against drafts as it is now (`base`).
 *                                            folder: "chapters" (the default; the
 *                                            chapter-NN rule names it) or a folder in
 *                                            it, where chapterName may be chosen.
 *   POST JSON { action: "again", book, id }  convert the same document again, against
 *     -> 201 { id, attempt, base }           drafts as it is now (after a conflict)
 *   GET ?book=<slug>&id=<id>
 *     -> { state: "working", attempt, since }
 *     -> { state: "done", attempt, result, chapter: { path, text } }   result: IMPORT_RESULT
 *     -> { state: "failed", attempt, error }
 *   GET ?book=<slug>&id=<id>&file=<path>     one staged file (a picture), for the preview
 *     -> { path, base64 }
 *
 * The same checks as every author endpoint (lib/author.mjs), plus: an import is
 * only ever read, converted again or sent by the author who started it, for the book
 * it was started for.
 */
import {
  REQUESTS_BOOK, REQUESTS_REPO, Refusal, appCredentials, authorise, blobBytes, bookFor, booksFor, budget, byline, draftsHead,
  encodePath, fail, ghJson, isAuthorPath, limits, query, wrap, IDENTITY_SECRET,
} from '../lib/author.mjs';
import { asString, createRateLimiter, isJsonContentType, parseBody, send } from '../lib/common.mjs';
import {
  IMPORT_DIR, MAX_BYTES, MAX_PARTS, PART_BYTES, branchOf, checkOwner, checkedResult, destination, newId, partReceipt,
  readImport, readReceipt, safeDocxName, stagedAt,
} from '../lib/author-import.mjs';

const requestsToken = appCredentials({ contents: 'write' });
const bookToken = appCredentials({ contents: 'read' });

const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
// Three imports' worth of parts at the full 20 MB, plus retries; and starts.
const partLimited = createRateLimiter(3 * MAX_PARTS + 6, 60 * 60 * 1000);
const startLimited = createRateLimiter(20, 60 * 60 * 1000);
const MAX_PREVIEW_FILE = 5 * 1024 * 1024;

// About 12 s for a small blob, growing with size (as request-book).
const blobBudget = (base64Length) => 12000 + Math.ceil(base64Length / (1024 * 1024)) * 1500;

async function handlePart(part, auth, res, used) {
  // Parts come before a book is named, so only someone who is an author of some book
  // may store anything in the requests repo at all.
  if (!booksFor(auth.identity).length) {
    console.warn(`import: @${auth.identity.login} is not an author of any book; part refused`);
    send(res, 403, { error: 'not an author', userMessage: "Your account isn't one of any book's authors." });
    return;
  }
  if (partLimited(auth.identity.login.toLowerCase(), Date.now())) {
    send(res, 429, { error: 'rate limit exceeded', userMessage: "You've uploaded a lot already. Please try again in an hour." });
    return;
  }
  if (!part || part.length % 4 !== 0 || !B64_RE.test(part) || Buffer.byteLength(part) > Math.ceil(PART_BYTES / 3) * 4) {
    send(res, 400, { error: 'validation: part', userMessage: 'The Word document could not be read.' });
    return;
  }
  try {
    const credential = await requestsToken(REQUESTS_BOOK, auth.tag, used);
    const left = budget(blobBudget(part.length) + 2000, blobBudget(part.length));
    const blob = await ghJson(`/repos/${REQUESTS_REPO}/git/blobs`, credential.token, left, { method: 'POST', body: { content: part, encoding: 'base64' } });
    send(res, 201, { receipt: partReceipt(IDENTITY_SECRET, blob.sha, auth.identity) });
  } catch (err) {
    fail(res, err, `${auth.tag} part`, () => used.forEach((c) => c.refused()));
  }
}

/**
 * One commit on the import's branch holding `files` (paths under import/). A new
 * import's branch is made from the requests repo's main, so that the push runs
 * main's import-chapter workflow: a push runs the workflow file of the commit
 * pushed, and a branch without one would run nothing.
 */
async function commitImport(id, token, left, files, parent, message) {
  const fresh = !parent;
  if (fresh) parent = (await ghJson(`/repos/${REQUESTS_REPO}/git/ref/heads/main`, token, left))?.object?.sha;
  const blobs = [];
  for (const f of files) {
    const made = await ghJson(`/repos/${REQUESTS_REPO}/git/blobs`, token, left, { method: 'POST', body: { content: f.bytes.toString('base64'), encoding: 'base64' } });
    blobs.push({ path: `${IMPORT_DIR}${f.path}`, mode: '100644', type: 'blob', sha: made.sha });
  }
  const baseTree = (await ghJson(`/repos/${REQUESTS_REPO}/git/commits/${parent}`, token, left))?.tree?.sha;
  const tree = await ghJson(`/repos/${REQUESTS_REPO}/git/trees`, token, left, { method: 'POST', body: { base_tree: baseTree, tree: blobs } });
  const commit = await ghJson(`/repos/${REQUESTS_REPO}/git/commits`, token, left, {
    method: 'POST', body: { message, tree: tree.sha, parents: [parent] },
  });
  if (fresh) {
    await ghJson(`/repos/${REQUESTS_REPO}/git/refs`, token, left, { method: 'POST', body: { ref: `refs/heads/${branchOf(id)}`, sha: commit.sha } });
  } else {
    await ghJson(`/repos/${REQUESTS_REPO}/git/refs/heads/${encodePath(branchOf(id))}`, token, left, { method: 'PATCH', body: { sha: commit.sha, force: false } });
  }
  return commit.sha;
}

function requestJson(o) {
  return Buffer.from(`${JSON.stringify(o, null, 2)}\n`, 'utf8');
}

async function start(body, auth, book, res, used) {
  const { identity } = auth;
  const name = safeDocxName(asString(body.name));
  if (!name) throw new Refusal(400, 'validation: name', 'Only Word documents (.docx) can be brought in.');
  const where = destination(body.folder, body.chapterName);
  const parts = body.parts;
  if (!Array.isArray(parts) || !parts.length || parts.length > MAX_PARTS) throw new Refusal(400, 'validation: parts', 'The Word document could not be read.');
  const shas = parts.map((r) => readReceipt(IDENTITY_SECRET, r, identity));
  if (shas.some((s) => !s)) {
    console.warn(`import: a part receipt was forged, expired or another login's ${auth.tag}`);
    throw new Refusal(400, 'validation: receipt', 'The upload expired. Please choose the Word document again.');
  }
  const btag = `${auth.tag} book=${book.slug}`;
  const req = await requestsToken(REQUESTS_BOOK, btag, used);
  const left = budget(55_000, 20_000);
  const chunks = [];
  for (const sha of shas) chunks.push(await blobBytes(REQUESTS_REPO, sha, req.token, left));
  const docx = Buffer.concat(chunks);
  if (docx.length === 0 || docx.length > MAX_BYTES) throw new Refusal(400, 'validation: size', 'The Word document must be under 20 MB.');
  if (docx.subarray(0, 4).toString('binary') !== 'PK\x03\x04') throw new Refusal(400, 'validation: not docx', `${name} does not look like a Word document.`);

  const bt = await bookToken(book, btag, used);
  const base = await draftsHead(book, bt.token, left);
  const id = newId();
  const request = {
    version: 1, id, attempt: 1,
    login: identity.login, user_id: identity.id, author_name: identity.name,
    book: book.slug, repo: book.content.repo, drafts_branch: book.content.drafts_branch, base,
    docx: name, ...where, created: new Date().toISOString(),
  };
  await commitImport(id, req.token, left, [
    { path: 'request.json', bytes: requestJson(request) },
    { path: 'source.docx', bytes: docx },
  ], null, `Import ${id}: ${name} for ${book.slug}, ${byline(identity)}`);
  console.log(`import ${id} started: ${name} (${docx.length} bytes) for ${book.slug} at ${base.slice(0, 7)} ${btag}`);
  send(res, 201, { id, attempt: 1, base });
}

async function again(body, auth, book, res, used) {
  const btag = `${auth.tag} book=${book.slug}`;
  const req = await requestsToken(REQUESTS_BOOK, btag, used);
  const left = budget(30_000);
  const imp = await readImport(asString(body.id), req.token, left);
  checkOwner(imp, book, auth.identity);
  const bt = await bookToken(book, btag, used);
  const base = await draftsHead(book, bt.token, left);
  const request = { ...imp.request, attempt: imp.request.attempt + 1, base, again: new Date().toISOString() };
  await commitImport(request.id, req.token, left, [{ path: 'request.json', bytes: requestJson(request) }], imp.head,
    `Import ${request.id}: convert again (attempt ${request.attempt}), ${byline(auth.identity)}`);
  console.log(`import ${request.id} again: attempt ${request.attempt} at ${base.slice(0, 7)} ${btag}`);
  send(res, 201, { id: request.id, attempt: request.attempt, base });
}

async function status(params, auth, book, res, used) {
  const btag = `${auth.tag} book=${book.slug}`;
  const req = await requestsToken(REQUESTS_BOOK, btag, used);
  const left = budget(20_000);
  const imp = await readImport(params.get('id'), req.token, left);
  checkOwner(imp, book, auth.identity);
  const file = params.get('file');
  if (file !== null) {
    const entry = isAuthorPath(file) ? imp.files.get(stagedAt(`out/${file}`)) : null;
    if (!entry) throw new Refusal(404, 'staged file not found', "That picture isn't part of this import.");
    if (entry.size > MAX_PREVIEW_FILE) throw new Refusal(413, 'staged file too large', 'That picture is too large to show here.');
    send(res, 200, { path: file, base64: (await blobBytes(REQUESTS_REPO, entry.sha, req.token, left)).toString('base64') });
    return;
  }
  const result = checkedResult(imp);
  const attempt = imp.request.attempt;
  if (!result) {
    send(res, 200, { state: 'working', attempt, since: imp.request.again ?? imp.request.created });
    return;
  }
  if (!result.ok) {
    send(res, 200, { state: 'failed', attempt, error: result.error || 'The Word document could not be converted.' });
    return;
  }
  // The converted chapter, for the preview: staged whether or not the send would
  // change it (the same Word file brought in again may convert to what drafts has).
  const preview = imp.files.get(`${IMPORT_DIR}chapter.md`);
  const text = preview ? (await blobBytes(REQUESTS_REPO, preview.sha, req.token, left)).toString('utf8') : '';
  send(res, 200, { state: 'done', attempt, result, chapter: { path: result.chapter.path, text } });
}

export default wrap(async (req, res) => {
  const auth = authorise(req, res, 'GET, POST');
  if (!auth) return;
  const used = [];
  try {
    if (req.method === 'GET') {
      if (limits.read(auth.identity.login.toLowerCase(), Date.now())) {
        send(res, 429, { error: 'rate limit exceeded', userMessage: 'Too many requests — try again in a little while.' });
        return;
      }
      const params = query(req);
      const book = bookFor(params.get('book'), auth, res);
      if (!book) return;
      await status(params, auth, book, res, used);
      return;
    }
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
    if (typeof body.part === 'string') {
      await handlePart(body.part, auth, res, used);
      return;
    }
    const book = bookFor(body.book, auth, res);
    if (!book) return;
    if (startLimited(auth.identity.login.toLowerCase(), Date.now())) {
      send(res, 429, { error: 'rate limit exceeded', userMessage: "You've brought in a lot of documents already. Please try again in an hour." });
      return;
    }
    if (body.action === 'start') await start(body, auth, book, res, used);
    else if (body.action === 'again') await again(body, auth, book, res, used);
    else send(res, 400, { error: 'validation: action' });
  } catch (err) {
    fail(res, err, auth.tag, () => used.forEach((c) => c.refused()));
  }
});
