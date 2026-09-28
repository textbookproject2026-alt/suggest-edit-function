/**
 * POST /api/author-send — the author site's one way of changing a book: one commit
 * on the drafts branch, made by the GitHub App with the signed-in author as the
 * commit's author. The same path serves a chapter whose links and glossary were
 * tidied, a finished Word import, and an accepted reader suggestion.
 *
 *   POST JSON {
 *     book, base,                     base: the drafts commit the author's work is on
 *     files?: [{ path, text }],       UTF-8 text files to write
 *     deletes?: [path],
 *     import?: <id>,                  a finished import (api/author-import.js): its
 *                                     staged files and deletions are sent from the
 *                                     private requests repo, never via the browser
 *     suggestion?: <number>,          after the commit: thank the reader with a link
 *                                     to it, and close the suggestion
 *     message?: string                one line; a default is made from what is sent
 *   }
 *     -> 201 { sha, url, written, deleted, steps, warning? }
 *     -> 409 { error: "conflict", conflict: { head, commits, files } }
 *            drafts is no longer at `base`: nothing was written, and this is what moved
 *     -> 4xx/5xx { error, userMessage }
 *
 * Paths: chapters/…, assets/…, and exactly index.md, glossary.md and
 * chapter-sources.json. Anything else, or any traversal, refuses the whole send.
 */
import {
  REQUESTS_BOOK, SHA_RE, Refusal, appCredentials, authorise, blobBytes, bookFor, budget, byline, commitToDrafts, fail,
  ghJson, isAuthorPath, limits, wrap,
} from '../lib/author.mjs';
import { asString, isJsonContentType, parseBody, send } from '../lib/common.mjs';
import { checkOwner, checkedResult, readImport } from '../lib/author-import.mjs';
import { ACCEPTED, NEEDS_TRIAGE, checkReply, thanksWithChange } from '../lib/author-console.mjs';
import { suggestion as readSuggestion } from '../lib/author-console-reads.mjs';

const bookToken = appCredentials({ contents: 'write', issues: 'write' });
const requestsToken = appCredentials({ contents: 'read' });

const MAX_FILES = 60;
const MAX_TEXT = 1_000_000;
const MAX_TOTAL = 3_000_000; // under Vercel's 4.5 MB body limit
const MAX_MESSAGE = 150;

function validate(body) {
  const reject = (error, userMessage) => { throw new Refusal(400, `validation: ${error}`, userMessage); };
  const base = asString(body.base);
  if (!SHA_RE.test(base)) reject('base', 'Please reload the book and try again.');
  const files = body.files ?? [];
  const deletes = body.deletes ?? [];
  if (!Array.isArray(files) || !Array.isArray(deletes) || files.length + deletes.length > MAX_FILES) reject('files', 'That is more files than can be sent at once.');
  let total = 0;
  const seen = new Set();
  const writes = [];
  for (const f of files) {
    if (!isAuthorPath(f?.path)) reject('path rejected', 'A file is outside what the author site may change, so nothing was sent.');
    if (typeof f.text !== 'string' || f.text.length > MAX_TEXT) reject('text', 'A file is too large to send from here.');
    total += f.text.length;
    if (seen.has(f.path)) reject('duplicate path', 'The same file was listed twice.');
    seen.add(f.path);
    writes.push({ path: f.path, bytes: Buffer.from(f.text, 'utf8') });
  }
  if (total > MAX_TOTAL) reject('too large', 'That is more than can be sent at once.');
  for (const d of deletes) {
    if (!isAuthorPath(d)) reject('path rejected', 'A file is outside what the author site may change, so nothing was sent.');
    if (seen.has(d)) reject('duplicate path', 'The same file was listed twice.');
    seen.add(d);
  }
  const importId = body.import === undefined || body.import === null ? null : asString(body.import);
  const suggestion = body.suggestion === undefined || body.suggestion === null ? null : body.suggestion;
  if (suggestion !== null && (!Number.isSafeInteger(suggestion) || suggestion <= 0)) reject('suggestion', "That suggestion isn't one the author site listed.");
  if (importId !== null && suggestion !== null) reject('import and suggestion', 'An import and a suggestion are sent separately.');
  if (!writes.length && !deletes.length && importId === null) reject('empty', 'There is nothing to send.');
  const message = asString(body.message).replace(/\s+/g, ' ').slice(0, MAX_MESSAGE);
  return { base, writes, deletes, importId, suggestion, message };
}

/** A finished import's staged files, copied from the private requests repo into the book repo. */
async function importWrites(book, identity, id, left, tag, used) {
  const req = await requestsToken(REQUESTS_BOOK, tag, used);
  const imp = await readImport(id, req.token, left);
  checkOwner(imp, book, identity);
  const result = checkedResult(imp);
  if (!result) throw new Refusal(409, 'import not ready', 'That import is still being converted.');
  if (!result.ok) throw new Refusal(409, 'import failed', result.error || 'That import could not be converted.');
  const writes = [];
  for (const w of result.writes) {
    const bytes = await blobBytes(REQUESTS_BOOK.content.repo, imp.files.get(w.staged).sha, req.token, left);
    writes.push({ path: w.path, bytes });
  }
  return { result, writes, deletes: result.deletes ?? [] };
}

/** The subject line, from what the commit actually changes (unchanged files are left out). */
const defaultMessage = ({ importResult, suggestion }) => (written, deleted) => {
  if (importResult) return `Import ${importResult.chapter.path}${importResult.chapter.new ? ' (new chapter)' : ''}`;
  if (suggestion) return `Accept suggestion #${suggestion.number} on ${suggestion.page}`;
  const paths = [...written, ...deleted];
  return paths.length === 1 ? `Update ${paths[0]}` : `Update ${paths.length} files`;
};

/** After the commit: the thank-you with its link, then the suggestion closed. Failures reported, not thrown. */
async function answerSuggestion(book, token, left, s, sent, identity, tag) {
  const repo = book.content.repo;
  const reply = thanksWithChange(sent.url, identity);
  checkReply(reply, sent.url);
  try {
    await ghJson(`/repos/${repo}/issues/${s.number}/comments`, token, left, { method: 'POST', body: { body: reply } });
  } catch (err) {
    console.error(`suggestion #${s.number}: reply failed — ${err.message} ${tag}`);
    return { steps: [], warning: 'The chapter was changed in the drafts area, but the thank-you could not be sent. The suggestion is still open.' };
  }
  for (const label of [NEEDS_TRIAGE, ACCEPTED]) {
    try {
      await ghJson(`/repos/${repo}/issues/${s.number}/labels/${encodeURIComponent(label)}`, token, left, { method: 'DELETE', allow: [404] });
    } catch (err) {
      console.warn(`suggestion #${s.number}: label ${label} not removed — ${err.message} ${tag}`);
    }
  }
  try {
    await ghJson(`/repos/${repo}/issues/${s.number}`, token, left, { method: 'PATCH', body: { state: 'closed', state_reason: 'completed' } });
  } catch (err) {
    console.error(`suggestion #${s.number}: close failed — ${err.message} ${tag}`);
    return { steps: ['A thank-you was sent, with a link to the change.'], warning: 'The thank-you was sent, but the suggestion could not be marked as dealt with.' };
  }
  console.log(`suggestion #${s.number} answered and closed ${byline(identity)} ${tag}`);
  return { steps: ['A thank-you was sent, with a link to the change.', 'The suggestion was marked as dealt with.'] };
}

export default wrap(async (req, res) => {
  const auth = authorise(req, res, 'POST');
  if (!auth) return;
  const { identity, tag } = auth;
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
  const book = bookFor(body.book, auth, res);
  if (!book) return;
  const btag = `${tag} book=${book.slug}`;
  if (limits.write(identity.login.toLowerCase(), Date.now())) {
    console.warn(`rate limit: ${btag}`);
    send(res, 429, { error: 'rate limit exceeded', userMessage: "You're sending changes very quickly — please wait a little while." });
    return;
  }

  const used = [];
  try {
    const data = validate(body);
    const left = budget(50_000, 15_000);
    const credential = await bookToken(book, btag, used);
    let { writes, deletes } = data;
    let importResult = null;
    if (data.importId !== null) {
      const imp = await importWrites(book, identity, data.importId, left, btag, used);
      importResult = imp.result;
      if (importResult.base !== data.base) {
        throw new Refusal(409, 'import base', 'That import was converted against an earlier drafts area. Convert it again.');
      }
      writes = [...imp.writes, ...writes];
      deletes = [...imp.deletes, ...deletes];
    }
    const s = data.suggestion === null ? null : await readSuggestion(book, data.suggestion, credential.token, left);
    if (s && !s.open) throw new Refusal(409, 'suggestion closed', 'That suggestion has already been dealt with.');

    const message = data.message || defaultMessage({ importResult, suggestion: s });
    const sent = await commitToDrafts({
      book, token: credential.token, left, base: data.base, writes, deletes, message, identity, tag: btag,
    });
    const out = { sha: sent.sha, url: sent.url, written: sent.written, deleted: sent.deleted, steps: ['The change is in the drafts area, as one change made by you.'] };
    if (s) {
      const answered = await answerSuggestion(book, credential.token, left, s, sent, identity, btag);
      out.steps.push(...answered.steps);
      if (answered.warning) out.warning = answered.warning;
    }
    send(res, 201, out);
  } catch (err) {
    fail(res, err, btag, () => used.forEach((c) => c.refused()));
  }
});
