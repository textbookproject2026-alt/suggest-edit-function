/**
 * POST /api/author-people-change — one of a book's authors adds or removes another:
 * a pull request on textbook-registry changing only that book's `authors`, opened by
 * the GitHub App with auto-merge on (lib/author-people.mjs). Nothing changes access
 * until it has merged and this function has been redeployed with it.
 *
 *   POST JSON { book, action: "add" | "remove" | "mentions-off" | "mentions-on", login }
 *     (the mentions actions only for the signed-in author's own login)
 *     -> 201 { number, url, action, login, by, state: "open", when, warning? }
 *     -> 4xx { error, userMessage }   no such account, already listed, the platform
 *                                     owner, the last author, another change on its way
 *
 * Rate-limited per login (limits.people).
 */
import { Refusal, appCredentials, authorise, bookFor, budget, fail, limits, wrap } from '../lib/author.mjs';
import { asString, isJsonContentType, parseBody, send } from '../lib/common.mjs';
import { LOGIN_RE, MENTION_ACTIONS, proposeChange, registryCredential } from '../lib/author-people.mjs';

const registryToken = appCredentials({ contents: 'write', pull_requests: 'write' });

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
  const book = bookFor(body.book, auth, res);
  if (!book) return;
  const tag = `${auth.tag} book=${book.slug} people-change`;
  let credential;
  try {
    const action = body.action;
    const login = asString(body.login).trim().replace(/^@/, '');
    if (!['add', 'remove', ...MENTION_ACTIONS].includes(action)) throw new Refusal(400, 'validation: action', "That isn't something the People panel does.");
    if (!LOGIN_RE.test(login)) throw new Refusal(400, 'validation: login', "That isn't a GitHub username: letters, numbers and single hyphens, at most 39.");
    if (limits.people(auth.identity.login.toLowerCase(), Date.now())) {
      console.warn(`rate limit: ${tag}`);
      throw new Refusal(429, 'rate limit exceeded', "You've made a lot of changes to people very quickly. Please wait a while.");
    }
    credential = await registryCredential(registryToken, tag);
    send(res, 201, await proposeChange({ book, action, login, identity: auth.identity, token: credential.token, left: budget(25_000), tag }));
  } catch (err) {
    fail(res, err, tag, credential?.refused);
  }
});
