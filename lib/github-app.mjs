/**
 * GitHub App authentication with node:crypto only: RS256 app JWT -> the installation
 * that covers a repository -> installation access token, downscoped to that one
 * repository and to issues:write (DESIGN §4c, C).
 *
 * Nothing here logs or returns the private key, the JWT, or a token.
 */
import { createPrivateKey, sign } from 'node:crypto';

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

/**
 * GITHUB_APP_PRIVATE_KEY holds the App's PEM, base64-encoded, because Vercel env vars
 * mangle the newlines in a raw PEM.
 * @returns {import('node:crypto').KeyObject}
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
  if (!/^-----BEGIN (RSA )?PRIVATE KEY-----/.test(pem.trimStart())) {
    throw new Error('GITHUB_APP_PRIVATE_KEY does not decode to a PEM private key');
  }

  let key;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new Error('GITHUB_APP_PRIVATE_KEY decodes to a PEM that is not a readable private key');
  }
  if (key.asymmetricKeyType !== 'rsa') {
    throw new Error(`GITHUB_APP_PRIVATE_KEY is a ${key.asymmetricKeyType} key; GitHub App keys are RSA`);
  }
  return key;
}

/**
 * Read and check every credential variable once, at module load.
 *
 * @returns {{
 *   app: { appId: string, privateKey: import('node:crypto').KeyObject } | null,
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
export function createAppJwt({ appId, privateKey, now = Date.now() }) {
  // Backdate iat by 60s against clock drift, as GitHub recommends; exp stays under 10 min.
  const iat = Math.floor(now / 1000) - 60;
  const exp = iat + 9 * 60;
  const segment = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const input = `${segment({ alg: 'RS256', typ: 'JWT' })}.${segment({ iat, exp, iss: appId })}`;
  const signature = sign('sha256', Buffer.from(input), privateKey).toString('base64url');
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
 * Installation tokens, cached per repository for the life of a warm instance.
 *
 * Each book's repo may belong to a different GitHub account, and so to a different
 * installation of the App. The installation is looked up per repository
 * (GET /repos/{owner}/{repo}/installation, authenticated as the App) and cached
 * alongside the token. A repository with no installation is never cached, so
 * installing the App takes effect on the next request.
 *
 * @param {object} o
 * @param {{ appId: string, privateKey: import('node:crypto').KeyObject }} o.app
 * @param {string} o.api        GitHub REST base URL
 * @param {object} o.headers    Accept / API version / User-Agent to send
 * @param {number} o.timeoutMs  abort budget for the lookup and the exchange together
 */
export function createInstallationTokenSource({ app, api, headers, timeoutMs, now = () => Date.now() }) {
  /** @type {Map<string, { token: string, expiresAt: number }>} lower-cased owner/name -> token */
  const cache = new Map();
  /** @type {Map<string, string>} lower-cased owner/name -> installation id */
  const installations = new Map();

  const appHeaders = () => ({
    ...headers,
    Authorization: `Bearer ${createAppJwt({ appId: app.appId, privateKey: app.privateKey, now: now() })}`,
  });

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

    const res = await call('installation lookup', `${api}/repos/${repo}/installation`, { method: 'GET', headers: appHeaders() }, signal);
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
      headers: { ...appHeaders(), 'Content-Type': 'application/json' },
      // Downscope: this token can touch this one repository's issues and nothing else,
      // whatever else the installation covers.
      body: JSON.stringify({ repositories: [name], permissions: { issues: 'write' } }),
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
      const hit = cache.get(key);
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
        return { token: fresh.token, cached: false, installationId: installation.id };
      } finally {
        clearTimeout(timer);
      }
    },

    /** Drop a cached token GitHub has refused, so the next request looks up and mints anew. */
    invalidate(repo) {
      cache.delete(repo.toLowerCase());
      installations.delete(repo.toLowerCase());
    },
  };
}
