/**
 * GET /api/author-people?book=<slug> — a book's People panel, for one of its authors:
 * who has access now (the registry this function was built with), and the changes to
 * that list still on their way (lib/author-people.mjs).
 *
 *   -> 200 { authors: [login], owner, registry: <sha>, pending: [{ number, url, action,
 *            login, by, state: "open"|"merged"|"failed", when, reasons? }] }
 *   -> 4xx/5xx { error, userMessage }
 */
import { appCredentials, authorise, bookFor, budget, fail, limits, query, wrap } from '../lib/author.mjs';
import { send } from '../lib/common.mjs';
import { people, registryCredential } from '../lib/author-people.mjs';

const registryToken = appCredentials({ contents: 'read', pull_requests: 'read' });

export default wrap(async (req, res) => {
  const auth = await authorise(req, res, 'GET');
  if (!auth) return;
  const book = bookFor(query(req).get('book'), auth, res);
  if (!book) return;
  const tag = `${auth.tag} book=${book.slug} people`;
  if (limits.read(auth.identity.login.toLowerCase(), Date.now())) {
    send(res, 429, { error: 'rate limit exceeded', userMessage: 'Too many requests — try again in a little while.' });
    return;
  }
  let credential;
  try {
    credential = await registryCredential(registryToken, tag);
    send(res, 200, await people(book, credential.token, budget(20_000)));
  } catch (err) {
    fail(res, err, tag, credential?.refused);
  }
});
