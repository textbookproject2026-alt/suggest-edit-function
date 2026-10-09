/**
 * Members who sign in on the author site by email (batch 2b). The author site's own
 * backend (Cloudflare Pages Functions, D1) holds who is on each book and their
 * sessions; for each request it proxies here, it writes a one-minute, single-use
 * assertion bound to that exact request and sends only its id:
 *
 *   Authorization: Member <id>
 *
 * This reads it back from the author site over HTTPS, once, with the binding it
 * computes itself from the request it received (method, endpoint, query, a hash
 * of the body, the book). The author site answers only if the id is unused,
 * unexpired, the binding matches and the member is still on that book, and marks
 * it used. There is no shared secret: the trust is in the hard-coded origin below
 * and in TLS.
 */
import { createHash } from 'node:crypto';

/** The only place an assertion is read back from. Never taken from a request. */
export const AUTHOR_SITE_ORIGIN = 'https://author.confused4now.org';
const READBACK_TIMEOUT_MS = 5000;

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/** The query, without the router's own `route`, sorted, as the author site writes it. */
export function canonicalQuery(params) {
  return [...params]
    .filter(([k]) => k !== 'route')
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

/**
 * The request's binding: what the assertion was written for. `bodyText` is the
 * body as JSON.stringify writes the parsed body ("" for GET); the author site
 * forwards exactly that text, so both sides hash the same bytes.
 */
export function bindingOf({ method, endpoint, params, bodyText, book }) {
  return sha256([method.toUpperCase(), `/api/${endpoint}`, canonicalQuery(params), sha256(bodyText), book].join('\n'));
}

/** Which book a request is for, by the same rule the author site's proxy uses. */
export function bookOfRequest(method, params, body) {
  if (method === 'GET') return params.get('book') ?? '';
  const b = body && typeof body === 'object' ? body.book : undefined;
  return typeof b === 'string' ? b : '';
}

const ID_RE = /^[A-Za-z0-9_-]{20,100}$/;

/**
 * The member behind `Authorization: Member <id>`, or null.
 * -> { member: { id, name, github }, book, books }
 */
export async function readAssertion(id, binding, fetchImpl = fetch) {
  if (!ID_RE.test(id) || !/^[0-9a-f]{64}$/.test(binding)) return null;
  let res;
  try {
    res = await fetchImpl(`${AUTHOR_SITE_ORIGIN}/api/internal/assertion`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, binding }),
      redirect: 'error',
      signal: AbortSignal.timeout(READBACK_TIMEOUT_MS),
    });
  } catch (err) {
    console.error(`member: assertion read-back failed: ${err.message}`);
    return null;
  }
  if (!res.ok) return null;
  const out = await res.json().catch(() => null);
  const m = out?.member;
  if (!m || !/^[0-9a-f]{10}$/.test(m.id ?? '') || typeof m.name !== 'string' || !Array.isArray(out.books)) return null;
  return { member: { id: m.id, name: m.name.slice(0, 80), github: typeof m.github === 'string' ? m.github : null }, book: String(out.book ?? ''), books: out.books.filter((b) => typeof b === 'string') };
}

/** The identity the author endpoints use for a member. Only the asserted books count. */
export const memberIdentity = ({ member, books }) => ({
  login: `m-${member.id}`,
  id: 0,
  name: member.name,
  member: true,
  memberId: member.id,
  github: member.github,
  books,
});

/** A member's address in git history: never their own email. */
export const memberNoreply = (memberId) => `m-${memberId}@users.noreply.confused4now.org`;

/**
 * Tells the author site a reader just sent something on a book, so members who want
 * them get an email (batch 2b). The author site reads the item back through this
 * function (mode=item) before it sends anything, so this carries only the book and
 * the number. Best effort: never holds up or fails the reader's request for long.
 */
export async function notifyAuthors(slug, htmlUrl, fetchImpl = fetch) {
  const number = Number(/\/(?:issues|pull)\/(\d+)$/.exec(String(htmlUrl ?? ''))?.[1]);
  if (!Number.isInteger(number)) return;
  try {
    await fetchImpl(`${AUTHOR_SITE_ORIGIN}/api/internal/notify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ book: slug, number }),
      redirect: 'error',
      signal: AbortSignal.timeout(3000),
    });
  } catch (err) {
    console.warn(`notify: ${err.message} book=${slug} #${number}`);
  }
}
