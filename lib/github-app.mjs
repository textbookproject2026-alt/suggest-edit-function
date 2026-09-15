/**
 * GitHub App authentication with node:crypto only: RS256 app JWT -> installation
 * access token, downscoped to one repository and to issues:write (DESIGN §4c, C).
 *
 * Nothing here logs or returns the private key, the JWT, or a token.
 */
import { createPrivateKey, sign } from 'node:crypto';

export const APP_ENV_VARS = ['GITHUB_APP_ID', 'GITHUB_APP_INSTALLATION_ID', 'GITHUB_APP_PRIVATE_KEY'];

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
 *   app: { appId: string, installationId: string, privateKey: import('node:crypto').KeyObject } | null,
 *   appProblem: string | null,   // why `app` is null; safe to log
 *   botToken: string | null,     // TEMPORARY fallback, removed once the App is proven live
 * }}
 */
export function readCredentialConfig(env) {
  const botToken = nonEmpty(env.BOT_TOKEN) ? env.BOT_TOKEN : null;
  const present = APP_ENV_VARS.filter((name) => nonEmpty(env[name]));

  if (present.length === 0) {
    return { app: null, appProblem: `${APP_ENV_VARS.join(', ')} are not set`, botToken };
  }

  const problems = APP_ENV_VARS.filter((name) => !present.includes(name)).map((name) => `${name} is not set`);
  for (const name of ['GITHUB_APP_ID', 'GITHUB_APP_INSTALLATION_ID']) {
    if (present.includes(name) && !/^\d+$/.test(env[name].trim())) problems.push(`${name} must be a number`);
  }

  let privateKey = null;
  if (present.includes('GITHUB_APP_PRIVATE_KEY')) {
    try {
      privateKey = decodePrivateKey(env.GITHUB_APP_PRIVATE_KEY);
    } catch (err) {
      problems.push(err.message);
    }
  }

  if (problems.length) return { app: null, appProblem: problems.join('; '), botToken };
  return {
    app: {
      appId: env.GITHUB_APP_ID.trim(),
      installationId: env.GITHUB_APP_INSTALLATION_ID.trim(),
      privateKey,
    },
    appProblem: null,
    botToken,
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
 * Installation tokens, cached per repository for the life of a warm instance.
 *
 * @param {object} o
 * @param {{ appId: string, installationId: string, privateKey: import('node:crypto').KeyObject }} o.app
 * @param {string} o.api        GitHub REST base URL
 * @param {object} o.headers    Accept / API version / User-Agent to send
 * @param {number} o.timeoutMs  abort budget for the exchange
 */
export function createInstallationTokenSource({ app, api, headers, timeoutMs, now = () => Date.now() }) {
  /** @type {Map<string, { token: string, expiresAt: number }>} lower-cased owner/name -> token */
  const cache = new Map();

  async function exchange(repo) {
    const [, name] = repo.split('/');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res;
    try {
      res = await fetch(`${api}/app/installations/${app.installationId}/access_tokens`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          ...headers,
          Authorization: `Bearer ${createAppJwt({ appId: app.appId, privateKey: app.privateKey, now: now() })}`,
          'Content-Type': 'application/json',
        },
        // Downscope: this token can touch this one repository's issues and nothing else,
        // whatever else the installation covers.
        body: JSON.stringify({ repositories: [name], permissions: { issues: 'write' } }),
      });
    } catch (err) {
      throw new Error(err?.name === 'AbortError' ? 'token exchange timed out' : 'token exchange failed');
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.text()).slice(0, 300);
      } catch {
        detail = '<unreadable>';
      }
      // GitHub's error body is safe to log (it names the problem, never a secret).
      console.error(`token exchange: GitHub returned ${res.status} for ${repo} — ${detail}`);
      throw new Error(`token exchange returned ${res.status}`);
    }

    const data = await res.json();
    const expiresAt = Date.parse(data?.expires_at);
    if (typeof data?.token !== 'string' || !data.token || Number.isNaN(expiresAt)) {
      throw new Error('token exchange returned no usable token');
    }
    // The installation belongs to one account. Asking it for "textbook" when the book
    // lives under a different owner would hand back a token for the wrong repository.
    const granted = (data.repositories ?? []).map((r) => String(r?.full_name).toLowerCase());
    if (granted.length !== 1 || granted[0] !== repo.toLowerCase()) {
      throw new Error(`token exchange granted ${granted.join(', ') || 'no repositories'}, not ${repo}`);
    }
    return { token: data.token, expiresAt };
  }

  return {
    /** @returns {Promise<{ token: string, cached: boolean }>} */
    async get(repo) {
      const key = repo.toLowerCase();
      const hit = cache.get(key);
      if (hit && hit.expiresAt - now() > REFRESH_MARGIN_MS) return { token: hit.token, cached: true };

      cache.delete(key);
      const fresh = await exchange(repo);
      cache.set(key, fresh);
      return { token: fresh.token, cached: false };
    },

    /** Drop a cached token GitHub has refused, so the next request mints a new one. */
    invalidate(repo) {
      cache.delete(repo.toLowerCase());
    },
  };
}
