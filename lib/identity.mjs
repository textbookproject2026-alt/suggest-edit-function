/**
 * "Signed in with GitHub", without keeping anyone's GitHub token.
 *
 * api/github-auth.js runs the OAuth dance, asks GitHub who the reader is, revokes
 * the GitHub token at once, and hands the page this module's identity token
 * instead: the reader's login, id and display name, the book origin it was issued
 * for, and an expiry, HMAC-signed with IDENTITY_SECRET. api/propose-edit.js
 * verifies it and credits the commit to that GitHub account. The token grants
 * nothing at GitHub; it only says "GitHub told us this reader is @login".
 *
 * Format: v1.<base64url JSON>.<base64url HMAC-SHA256 of "v1.<payload>">
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const IDENTITY_TTL_MS = 8 * 60 * 60 * 1000;
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const MIN_SECRET = 32;

/** The secret, or null (sign-in off) when it is missing or too short to trust. */
export function readIdentitySecret(env) {
  const s = typeof env.IDENTITY_SECRET === 'string' ? env.IDENTITY_SECRET.trim() : '';
  return s.length >= MIN_SECRET ? s : null;
}

const mac = (secret, input) => createHmac('sha256', secret).update(input).digest('base64url');

/** Generic signed blob, also used for the OAuth `state`. */
export function sign(secret, payload) {
  const body = `v1.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  return `${body}.${mac(secret, body)}`;
}

/** The payload if the signature holds and `e` (expiry, ms) is in the future, else null. */
export function verify(secret, token, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 2000) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const body = `${parts[0]}.${parts[1]}`;
  const want = Buffer.from(mac(secret, body));
  const got = Buffer.from(parts[2]);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload.e !== 'number' || payload.e <= now) return null;
  return payload;
}

/** An identity token for a GitHub user, bound to one book origin. */
export function issueIdentity(secret, { login, id, name }, origin, now = Date.now()) {
  return sign(secret, { k: 'id', login, id, name: name || '', o: origin, e: now + IDENTITY_TTL_MS });
}

/**
 * @returns {{ login: string, id: number, name: string } | null} the reader, if the
 *   token is genuine, unexpired, and was issued for this book's origin
 */
export function readIdentity(secret, token, origin, now = Date.now()) {
  const p = verify(secret, token, now);
  if (!p || p.k !== 'id' || p.o !== origin) return null;
  if (typeof p.login !== 'string' || !LOGIN_RE.test(p.login)) return null;
  if (!Number.isSafeInteger(p.id) || p.id <= 0) return null;
  return { login: p.login, id: p.id, name: typeof p.name === 'string' ? p.name.slice(0, 200) : '' };
}

/** GitHub's noreply address, which credits a commit to the account without exposing email. */
export const noreplyEmail = ({ login, id }) => `${id}+${login}@users.noreply.github.com`;
