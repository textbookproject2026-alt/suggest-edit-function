/**
 * GitHub App authentication with WebCrypto only (Node and Cloudflare Workers alike): RS256 app JWT -> the installation
 * that covers a repository -> installation access token, downscoped to that one
 * repository and to the permissions its caller asks for: issues:write for
 * suggestions, contents + pull_requests + issues for proposed edits (DESIGN §4c, C).
 *
 * Nothing here logs or returns the private key, the JWT, or a token.
 */
import { platform } from './platform.mjs';

export const APP_ENV_VARS = ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY'];

// No longer read: the installation is looked up per repository. Reported at startup if
// still set, so it can be deleted from the project.
export const RETIRED_ENV_VARS = ['GITHUB_APP_INSTALLATION_ID'];

// Installation tokens live 60 minutes. Re-mint once one has less than this left, so a
// token can never expire between being handed out and the issue call (8s + 3s) using it.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '';
}

// DER: a length, and the PKCS#8 header that wraps a PKCS#1 RSA key (rsaEncryption, NULL).
const derLength = (n) => (n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : n < 0x10000 ? [0x82, n >> 8, n & 0xff] : [0x83, n >> 16, (n >> 8) & 0xff, n & 0xff]);
const RSA_ALGORITHM = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
const KEY_TYPES = { '2a8648ce3d0201': 'ec', '2b6570': 'ed25519', '2b6571': 'ed448', '2a864886f70d010101': 'rsa' };

/** The DER is one whole SEQUENCE (30 len ...), nothing more and nothing less. */
function isWholeSequence(der) {
  if (der[0] !== 0x30 || der.length < 2) return false;
  let n = der[1], at = 2;
  if (n & 0x80) {
    const k = n & 0x7f;
    if (k < 1 || k > 3) return false;
    n = 0;
    for (let i = 0; i < k; i++) n = n * 256 + der[2 + i];
    at = 2 + k;
  }
  return at + n === der.length;
}

/**
 * GITHUB_APP_PRIVATE_KEY holds the App's PEM, base64-encoded, because Vercel env vars
 * mangle the newlines in a raw PEM. GitHub hands out PKCS#1 ("RSA PRIVATE KEY");
 * WebCrypto imports only PKCS#8, so a PKCS#1 key is wrapped here.
 * @returns {{ pkcs8: Uint8Array, crypto?: Promise<CryptoKey> }} imported on first use
 * @throws {Error} with a message safe to log (it never includes key material)
 */
export function decodePrivateKey(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('-----BEGIN')) {
    throw new Error('GITHUB_APP_PRIVATE_KEY is a raw PEM; it must be base64-encoded (see README)');
  }
  const compact = trimmed.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 !== 0) {
    throw new Error('GITHUB_APP_PRIVATE_KEY is not valid base64');
  }
  const pem = Buffer.from(compact, 'base64').toString('utf8');
  const kind = pem.trimStart().match(/^-----BEGIN (RSA )?PRIVATE KEY-----/);
  if (!kind) {
    throw new Error('GITHUB_APP_PRIVATE_KEY does not decode to a PEM private key');
  }

  const der = new Uint8Array(Buffer.from(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64'));
  if (!isWholeSequence(der)) {
    throw new Error('GITHUB_APP_PRIVATE_KEY decodes to a PEM that is not a readable private key');
  }
  if (kind[1]) {
    const inner = [0x02, 0x01, 0x00, ...RSA_ALGORITHM, 0x04, ...derLength(der.length)];
    const pkcs8 = new Uint8Array([0x30, ...derLength(inner.length + der.length), ...inner, ...der]);
    return { pkcs8 };
  }
  // PKCS#8: SEQUENCE { INTEGER 0, SEQUENCE { OID algorithm, ... }, OCTET STRING key }
  const oid = der.findIndex((b, i) => b === 0x06 && i > 4 && der[i - 2] === 0x30);
  const hex = oid < 0 ? '' : Buffer.from(der.subarray(oid + 2, oid + 2 + der[oid + 1])).toString('hex');
  const type = KEY_TYPES[hex] ?? 'unknown';
  if (type !== 'rsa') {
    throw new Error(`GITHUB_APP_PRIVATE_KEY is a ${type} key; GitHub App keys are RSA`);
  }
  return { pkcs8: der };
}

function signingKey(privateKey) {
  privateKey.crypto ??= crypto.subtle.importKey('pkcs8', privateKey.pkcs8, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  return privateKey.crypto;
}

/**
 * Read and check every credential variable once, at module load.
 *
 * @returns {{
 *   app: { appId: string, privateKey: { pkcs8: Uint8Array } } | null,
 *   appProblem: string | null,   // why `app` is null; safe to log
 *   botToken: string | null,     // TEMPORARY fallback, removed once the App is proven live
 *   retired: string[],           // variables still set that nothing reads any more
 * }}
 */
export function readCredentialConfig(env) {
  const botToken = nonEmpty(env.BOT_TOKEN) ? env.BOT_TOKEN : null;
  const retired = RETIRED_ENV_VARS.filter((name) => nonEmpty(env[name]));
  const present = APP_ENV_VARS.filter((name) => nonEmpty(env[name]));

  if (present.length === 0) {
    return { app: null, appProblem: `${APP_ENV_VARS.join(', ')} are not set`, botToken, retired };
  }

  const problems = APP_ENV_VARS.filter((name) => !present.includes(name)).map((name) => `${name} is not set`);
  if (present.includes('GITHUB_APP_ID') && !/^\d+$/.test(env.GITHUB_APP_ID.trim())) {
    problems.push('GITHUB_APP_ID must be a number');
  }

  let privateKey = null;
  if (present.includes('GITHUB_APP_PRIVATE_KEY')) {
    try {
      privateKey = decodePrivateKey(env.GITHUB_APP_PRIVATE_KEY);
    } catch (err) {
      problems.push(err.message);
    }
  }

  if (problems.length) return { app: null, appProblem: problems.join('; '), botToken, retired };
  return {
    app: { appId: env.GITHUB_APP_ID.trim(), privateKey },
    appProblem: null,
    botToken,
    retired,
  };
}

/** RS256 JWT identifying the App itself. Valid for GitHub's maximum of 10 minutes, less drift. */
export async function createAppJwt({ appId, privateKey, now = Date.now() }) {
  // Backdate iat by 60s against clock drift, as GitHub recommends; exp stays under 10 min.
  const iat = Math.floor(now / 1000) - 60;
  const exp = iat + 9 * 60;
  const segment = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const input = `${segment({ alg: 'RS256', typ: 'JWT' })}.${segment({ iat, exp, iss: appId })}`;
  let key;
  try {
    key = await signingKey(privateKey);
  } catch {
    privateKey.crypto = undefined;
    throw new TokenError('GITHUB_APP_PRIVATE_KEY is not a usable RSA key');
  }
  const signature = Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(input))).toString('base64url');
  return `${input}.${signature}`;
}


/**
 * A failure to mint a token. `code` lets the handler tell "the App isn't installed on
 * this repository" (a platform setup step still to do) from GitHub being unreachable.
 */
export class TokenError extends Error {
  constructor(message, code = 'exchange_failed') {
    super(message);
    this.code = code;
  }
}

/**
 * Installation tokens, cached per repository in memory for the life of a warm instance,
 * and in KV on Cloudflare.
 *
 * Each book's repo may belong to a different GitHub account, and so to a different
 * installation of the App. The installation is looked up per repository
 * (GET /repos/{owner}/{repo}/installation, authenticated as the App) and cached
 * alongside the token. A repository with no installation is never cached, so
 * installing the App takes effect on the next request.
 *
 * @param {object} o
 * @param {{ appId: string, privateKey: { pkcs8: Uint8Array } }} o.app
 * @param {string} o.api        GitHub REST base URL
 * @param {object} o.headers    Accept / API version / User-Agent to send
 * @param {number} o.timeoutMs  abort budget for the lookup and the exchange together
 * @param {Record<string, string>} [o.permissions]  what each token is downscoped to
 */
export function createInstallationTokenSource({ app, api, headers, timeoutMs, permissions = { issues: 'write' }, now = () => Date.now() }) {
  /** @type {Map<string, { token: string, expiresAt: number }>} lower-cased owner/name -> token */
  const cache = new Map();
  /** @type {Map<string, string>} lower-cased owner/name -> installation id */
  const installations = new Map();

  // One RS256 signature serves every call for 6 minutes (a JWT is good for 8): a mint
  // (lookup + exchange) signs once, and so does a burst of mints for several books.
  let jwt = null;
  const appHeaders = async () => {
    if (!jwt || now() >= jwt.until) {
      jwt = { value: createAppJwt({ appId: app.appId, privateKey: app.privateKey, now: now() }), until: now() + 6 * 60 * 1000 };
      jwt.value.catch(() => { jwt = null; });
    }
    return { ...headers, Authorization: `Bearer ${await jwt.value}` };
  };

  // On Cloudflare, tokens are shared by every isolate through KV (platform.kv), keyed
  // by repository and the permissions asked for, and kept until REFRESH_MARGIN_MS
  // before they expire. KV failures fall back to minting: never fatal.
  const kvKey = (key) => `token:${key}:${Object.entries(permissions).sort().map((p) => p.join('=')).join(',')}`;
  async function kvGet(key) {
    try {
      return (await platform.kv?.get(kvKey(key), 'json')) ?? null;
    } catch (err) {
      console.error(`token cache: KV read failed (${err?.message})`);
      return null;
    }
  }
  async function kvPut(key, value) {
    const ttl = Math.floor((value.expiresAt - now() - REFRESH_MARGIN_MS) / 1000);
    if (!platform.kv || ttl < 60) return; // KV's minimum TTL
    try {
      await platform.kv.put(kvKey(key), JSON.stringify(value), { expirationTtl: ttl });
    } catch (err) {
      console.error(`token cache: KV write failed (${err?.message})`);
    }
  }

  async function call(what, url, init, signal) {
    try {
      return await fetch(url, { ...init, signal });
    } catch (err) {
      throw new TokenError(err?.name === 'AbortError' ? `${what} timed out` : `${what} failed`);
    }
  }

  async function detailOf(res) {
    try {
      return (await res.text()).slice(0, 300);
    } catch {
      return '<unreadable>';
    }
  }

  async function lookupInstallation(repo, signal) {
    const key = repo.toLowerCase();
    const hit = installations.get(key);
    if (hit) return { id: hit, cached: true };

    const res = await call('installation lookup', `${api}/repos/${repo}/installation`, { method: 'GET', headers: await appHeaders() }, signal);
    if (res.status === 404) {
      throw new TokenError(`the app isn't installed on ${repo}`, 'not_installed');
    }
    if (!res.ok) {
      console.error(`installation lookup: GitHub returned ${res.status} for ${repo} — ${await detailOf(res)}`);
      throw new TokenError(`installation lookup returned ${res.status}`);
    }
    const data = await res.json();
    const id = data?.id;
    if (!Number.isSafeInteger(id) || id <= 0) throw new TokenError('installation lookup returned no installation id');
    installations.set(key, String(id));
    return { id: String(id), cached: false };
  }

  async function exchange(repo, installationId, signal) {
    const [, name] = repo.split('/');
    const res = await call('token exchange', `${api}/app/installations/${installationId}/access_tokens`, {
      method: 'POST',
      headers: { ...(await appHeaders()), 'Content-Type': 'application/json' },
      // Downscope: this token can touch this one repository, with only the permissions
      // asked for, whatever else the installation covers.
      body: JSON.stringify({ repositories: [name], permissions }),
    }, signal);

    if (!res.ok) {
      // GitHub's error body is safe to log (it names the problem, never a secret).
      console.error(`token exchange: GitHub returned ${res.status} for ${repo} — ${await detailOf(res)}`);
      throw new TokenError(`token exchange returned ${res.status}`);
    }

    const data = await res.json();
    const expiresAt = Date.parse(data?.expires_at);
    if (typeof data?.token !== 'string' || !data.token || Number.isNaN(expiresAt)) {
      throw new TokenError('token exchange returned no usable token');
    }
    // Belt and braces: the installation was looked up for this repository, but a token
    // for anything other than exactly it must never be used.
    const granted = (data.repositories ?? []).map((r) => String(r?.full_name).toLowerCase());
    if (granted.length !== 1 || granted[0] !== repo.toLowerCase()) {
      throw new TokenError(`token exchange granted ${granted.join(', ') || 'no repositories'}, not ${repo}`);
    }
    return { token: data.token, expiresAt };
  }

  return {
    /** @returns {Promise<{ token: string, cached: boolean, installationId: string }>} */
    async get(repo) {
      const key = repo.toLowerCase();
      let hit = cache.get(key);
      if (!(hit && hit.expiresAt - now() > REFRESH_MARGIN_MS)) {
        hit = await kvGet(key);
        if (hit?.installationId) {
          cache.set(key, { token: hit.token, expiresAt: hit.expiresAt });
          installations.set(key, hit.installationId);
        }
      }
      if (hit && hit.expiresAt - now() > REFRESH_MARGIN_MS) {
        return { token: hit.token, cached: true, installationId: installations.get(key) };
      }
      cache.delete(key);

      // One budget for both calls, so a cold mint still fits the function's maxDuration.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const installation = await lookupInstallation(repo, controller.signal);
        let fresh;
        try {
          fresh = await exchange(repo, installation.id, controller.signal);
        } catch (err) {
          // The App may have been uninstalled or moved since the id was cached: look
          // it up again next time rather than retrying a dead installation forever.
          installations.delete(key);
          throw err;
        }
        cache.set(key, fresh);
        await kvPut(key, { ...fresh, installationId: installation.id });
        return { token: fresh.token, cached: false, installationId: installation.id };
      } finally {
        clearTimeout(timer);
      }
    },

    /** Drop a cached token GitHub has refused, so the next request looks up and mints anew. */
    invalidate(repo) {
      const key = repo.toLowerCase();
      cache.delete(key);
      installations.delete(key);
      platform.kv?.delete(kvKey(key)).catch(() => {});
    },
  };
}
