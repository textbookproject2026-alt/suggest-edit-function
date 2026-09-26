/**
 * Registry-driven resolution (DESIGN §3a): an Origin resolves to exactly one book or
 * is refused. Run with `npm test`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { call, VALID, requests, loadHandler, stubTokenExchange, stubInstallationLookup } from './harness.mjs';
import BUNDLE from '../registry/bundled.mjs';
import { validateRegistry, createResolver } from '../lib/registry.mjs';

const REGISTRY = BUNDLE.registry;
const ROUTABLE = REGISTRY.books.filter((b) => b.status !== 'retired' && b.site.domain && b.suggest_edit.enabled);

function captureLogs() {
  const lines = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  for (const level of Object.keys(saved)) console[level] = (...args) => lines.push(`${level}: ${args.join(' ')}`);
  return { lines, restore: () => Object.assign(console, saved) };
}

/** A minimal valid book, for synthetic registries. */
function book(slug, domain, overrides = {}) {
  return {
    slug, status: 'live',
    content: { repo: `org/${slug}`, live_branch: 'main', drafts_branch: 'drafts' },
    site: { domain, legacy_origins: [] },
    suggest_edit: { enabled: true },
    ...overrides,
  };
}
const registryOf = (...books) => ({ schema_version: 1, books });

// ---------------------------------------------------------------------------
// The bundled registry, through the real handler
// ---------------------------------------------------------------------------

test('the bundled registry is valid and has at least one routable book', () => {
  validateRegistry(REGISTRY);
  assert.match(BUNDLE.sha, /^[0-9a-f]{40}$/);
  assert.ok(ROUTABLE.length >= 1);
});

test('the no-Origin fallback is gone for good', () => {
  // DESIGN step 2b. With more than one book there is no book to default to, so a
  // request with no Origin must never be filed. Keep the flag from coming back.
  const source = readFileSync(new URL('../api/suggest-edit.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /ALLOW_ORIGINLESS|soleBook/);
  assert.equal('soleBook' in createResolver(registryOf(book('a', 'a.example'))), false);
});

test('no Origin, or an empty one, gets 403 origin required, no CORS headers, and no GitHub call', async () => {
  // Deliberate (DESIGN step 2b): curl and server-to-server callers must send the
  // book's Origin. Holds even while the registry has a single book.
  for (const origin of [null, '']) {
    for (const method of ['OPTIONS', 'POST', 'GET']) {
      for (const body of [{ ...VALID }, { ...VALID, website: 'x' }]) {
        requests.length = 0;
        const logs = captureLogs();
        let r;
        try {
          r = await call({ method, origin, body });
        } finally {
          logs.restore();
        }
        const what = `${method} origin=${JSON.stringify(origin)} honeypot=${Boolean(body.website)}`;
        assert.equal(r.status, 403, what);
        assert.deepEqual(r.payload, { error: 'origin required' }, what);
        assert.equal(r.headers['access-control-allow-origin'], undefined, `${what} must get no CORS`);
        assert.equal(r.headers['x-registry-version'], BUNDLE.sha, what);
        assert.equal(r.issue, null, what);
        assert.equal(requests.length, 0, `${what} must not reach GitHub`);
        assert.deepEqual(logs.lines, ['warn: origin missing'], what);
      }
    }
  }
});

test('no Origin is refused on the App credential path too, before anything is minted', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' } });
  const h = await loadHandler({
    GITHUB_APP_ID: '123456', GITHUB_APP_INSTALLATION_ID: undefined,
    GITHUB_APP_PRIVATE_KEY: Buffer.from(privateKey).toString('base64'), BOT_TOKEN: undefined,
  });
  stubInstallationLookup(null);
  stubTokenExchange(null); // either call would throw
  requests.length = 0;
  const logs = captureLogs();
  let r;
  try {
    r = await call({ using: h, origin: null, body: { ...VALID } });
  } finally {
    logs.restore();
  }
  assert.equal(r.status, 403);
  assert.deepEqual(r.payload, { error: 'origin required' });
  assert.equal(requests.length, 0);
});

test('table: every registered book\'s origin files on that book\'s repo', async () => {
  for (const b of ROUTABLE) {
    const origin = `https://${b.site.domain}`;

    const pre = await call({ method: 'OPTIONS', contentType: null, origin });
    assert.equal(pre.status, 204, `${b.slug} preflight`);
    assert.equal(pre.headers['access-control-allow-origin'], origin);
    assert.equal(pre.headers.vary, 'Origin');

    requests.length = 0;
    const r = await call({ origin, body: { ...VALID } });
    assert.equal(r.status, 201, b.slug);
    assert.equal(r.headers['access-control-allow-origin'], origin);
    const issuePosts = requests.filter((q) => q.method === 'POST' && q.url.endsWith('/issues'));
    assert.deepEqual(issuePosts.map((q) => q.url), [`https://api.github.com/repos/${b.content.repo}/issues`]);
    assert.ok(requests.every((q) => q.url.startsWith(`https://api.github.com/repos/${b.content.repo}/`)),
      `${b.slug}: every GitHub call must target ${b.content.repo}`);
    assert.ok(r.issue.body.startsWith(
      `**File:** [\`${VALID.path}\`](https://github.com/${b.content.repo}/blob/${b.content.live_branch}/`));

    const honey = await call({ origin, body: { ...VALID, website: 'x' } });
    assert.equal(honey.payload.issueUrl, `https://github.com/${b.content.repo}/issues`);
  }
});

test('table: with App credentials, each book\'s installation is looked up, the token minted for its repo, and every other call targets it', async () => {
  // The lookup is GET /repos/<repo>/installation, authenticated as the App. The mint
  // call is POST /app/installations/:id/access_tokens: it is not under /repos/, and
  // names the repository in its body. Check both, don't exclude them.
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' } });
  const h = await loadHandler({
    GITHUB_APP_ID: '123456', GITHUB_APP_INSTALLATION_ID: undefined,
    GITHUB_APP_PRIVATE_KEY: Buffer.from(privateKey).toString('base64'), BOT_TOKEN: undefined,
  });

  try {
    for (const [i, b] of ROUTABLE.entries()) {
      const [owner] = b.content.repo.split('/');
      // A different installation per book, as when each maintainer owns their repo.
      const installation = 9000 + i;
      stubInstallationLookup((repo) => ({ ok: true, status: 200, json: async () => ({ id: repo === b.content.repo ? installation : -1 }) }));
      stubTokenExchange((url, opts) => ({
        ok: true, status: 201,
        json: async () => ({
          token: `ghs_${b.slug}`, expires_at: new Date(Date.now() + 3600e3).toISOString(),
          repositories: JSON.parse(opts.body).repositories.map((name) => ({ full_name: `${owner}/${name}` })),
        }),
      }));

      requests.length = 0;
      const r = await call({ using: h, origin: `https://${b.site.domain}`, body: { ...VALID } });
      assert.equal(r.status, 201, b.slug);

      const [lookup, mint, ...rest] = requests;
      assert.equal(lookup.url, `https://api.github.com/repos/${b.content.repo}/installation`, `${b.slug}: lookup first`);
      assert.equal(mint.url, `https://api.github.com/app/installations/${installation}/access_tokens`, `${b.slug}: then mint`);
      assert.deepEqual(mint.body.repositories, [b.content.repo.split('/')[1]], `${b.slug}: token scoped to its repo`);
      assert.ok(rest.length >= 1);
      for (const q of rest) {
        assert.ok(q.url.startsWith(`https://api.github.com/repos/${b.content.repo}/`), `${b.slug}: ${q.method} ${q.url}`);
        assert.equal(q.headers.Authorization, `Bearer ghs_${b.slug}`, `${b.slug}: must use the minted token, not a fallback`);
      }
    }
  } finally {
    stubTokenExchange(null);
    stubInstallationLookup(null);
  }
});

test('look-alike, legacy and malformed origins get 403, no CORS headers, and no GitHub call', async () => {
  const b = ROUTABLE[0];
  const d = b.site.domain;
  const origins = [
    ...b.site.legacy_origins,
    `http://${d}`,
    `https://${d}.evil.example`,
    `https://evil${d}`,
    `https://www.${d}`,
    `https://${d}:443`,
    `https://${d}/`,
    `https://${d.toUpperCase()}`,
    'null',
    'https://evil.example',
  ];
  for (const origin of origins) {
    for (const method of ['OPTIONS', 'POST']) {
      requests.length = 0;
      const r = await call({ method, origin, body: { ...VALID } });
      assert.equal(r.status, 403, `${method} ${origin}`);
      assert.deepEqual(r.payload, { error: 'origin not allowed' }, `${method} ${origin}`);
      assert.equal(r.headers['access-control-allow-origin'], undefined, `${method} ${origin} must get no CORS`);
      assert.equal(r.issue, null);
      assert.equal(requests.length, 0, `${method} ${origin} must not reach GitHub`);
    }
  }
});

test('an unknown origin is logged as unregistered and never falls through to a book', async () => {
  const logs = captureLogs();
  try {
    await call({ origin: 'https://someone-else.example', body: { ...VALID, website: 'x' } });
  } finally {
    logs.restore();
  }
  assert.deepEqual(logs.lines, ['warn: origin rejected: https://someone-else.example (unregistered)']);
});

test('every response carries X-Registry-Version and X-Function-Version, refusals included', async () => {
  const ok = await call({ origin: `https://${ROUTABLE[0].site.domain}`, body: { ...VALID } });
  const refused = await call({ origin: 'https://evil.example', body: {} });
  assert.equal(ok.headers['x-registry-version'], BUNDLE.sha);
  assert.equal(refused.headers['x-registry-version'], BUNDLE.sha);
  // This repo's commit on Vercel, `local` for a bundle made anywhere else.
  const fn = BUNDLE.function_sha ?? 'local';
  assert.equal(ok.headers['x-function-version'], fn);
  assert.equal(refused.headers['x-function-version'], fn);
});

test('log lines after resolution carry book=<slug>', async () => {
  const b = ROUTABLE[0];
  const logs = captureLogs();
  try {
    await call({ origin: `https://${b.site.domain}`, body: { ...VALID } });
    await call({ origin: `https://${b.site.domain}`, body: { bogus: 1 } });
  } finally {
    logs.restore();
  }
  assert.ok(logs.lines.length >= 3, logs.lines.join('\n'));
  for (const line of logs.lines) assert.ok(line.endsWith(`book=${b.slug}`), `missing tag: ${line}`);
});

test('the post-condition logs a routing error when GitHub reports a different repo, but still returns 201', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const res = await realFetch(url, opts);
    if (opts?.method === 'POST' && String(url).endsWith('/issues')) {
      return { ...res, json: async () => ({ html_url: 'https://example.invalid/issues/9',
                                             repository_url: 'https://api.github.com/repos/other/repo' }) };
    }
    return res;
  };
  const logs = captureLogs();
  let r;
  try {
    r = await call({ origin: `https://${ROUTABLE[0].site.domain}`, body: { ...VALID } });
  } finally {
    logs.restore();
    globalThis.fetch = realFetch;
  }
  assert.equal(r.status, 201);
  assert.ok(logs.lines.some((l) => l.startsWith('error: ROUTING:') && l.includes('other/repo')), logs.lines.join('\n'));
});

test('a correctly routed issue logs no routing error', async () => {
  const logs = captureLogs();
  try {
    await call({ origin: `https://${ROUTABLE[0].site.domain}`, body: { ...VALID } });
  } finally {
    logs.restore();
  }
  assert.ok(!logs.lines.some((l) => l.includes('ROUTING')), logs.lines.join('\n'));
});

// ---------------------------------------------------------------------------
// Resolver and loader, against synthetic registries
// ---------------------------------------------------------------------------

test('two books: each origin maps to its own repo, and a missing Origin maps to neither', () => {
  const r = createResolver(validateRegistry(registryOf(book('alpha', 'alpha.example'), book('beta', 'beta.example'))));
  assert.equal(r.resolve('https://alpha.example').book.content.repo, 'org/alpha');
  assert.equal(r.resolve('https://beta.example').book.content.repo, 'org/beta');
  assert.deepEqual(r.resolve(''), { ok: false, reason: 'unregistered' });
  assert.deepEqual(r.resolve('https://gamma.example'), { ok: false, reason: 'unregistered' });
  assert.deepEqual(r.resolve(undefined), { ok: false, reason: 'unregistered' });
  assert.deepEqual(r.resolve('__proto__'), { ok: false, reason: 'unregistered' });
});

test('statuses: retired resolves nowhere, preview with a domain resolves, disabled is refused with a reason', () => {
  const r = createResolver(validateRegistry(registryOf(
    book('old', 'old.example', { status: 'retired' }),
    book('new', 'new.example', { status: 'preview' }),
    book('soon', null, { status: 'preview' }),
    book('off', 'off.example', { suggest_edit: { enabled: false } }),
  )));
  assert.deepEqual(r.resolve('https://old.example'), { ok: false, reason: 'unregistered' });
  assert.equal(r.resolve('https://new.example').book.slug, 'new');
  assert.deepEqual(r.resolve('https://off.example'), { ok: false, reason: 'suggest_edit disabled for off' });
});

test('the loader refuses registries it cannot route unambiguously', () => {
  const cases = [
    [{ ...registryOf(book('a', 'a.example')), schema_version: 2 }, /schema_version 2/],
    [registryOf(book('a', 'a.example'), book('b', 'a.example')), /duplicate site.domain: a.example/],
    [registryOf(book('a', 'a.example'), book('a', 'b.example')), /duplicate slug: a/],
    [registryOf(book('a', 'a.example'), book('b', 'b.example', { content: { repo: 'ORG/a', live_branch: 'main' } })),
      /duplicate content.repo/],
    [registryOf(book('a', 'a.example'), book('b', 'b.example', { site: { domain: 'b.example', legacy_origins: ['https://a.example'] } })),
      /also a legacy origin/],
    [registryOf(book('a', 'https://a.example')), /bad site.domain/],
    [registryOf(book('a', 'A.example')), /bad site.domain/],
    [registryOf(book('a', null)), /may be null only for a preview/],
    [registryOf(book('a', 'a.example', { status: 'draft' })), /bad status/],
    [registryOf(book('a', 'a.example', { content: { repo: 'no-slash', live_branch: 'main' } })), /bad content.repo/],
    [registryOf(book('a', 'a.example', { suggest_edit: {} })), /suggest_edit.enabled/],
    [{ schema_version: 1, books: {} }, /books must be an array/],
  ];
  for (const [registry, pattern] of cases) assert.throws(() => validateRegistry(registry), pattern);
});

// ---------------------------------------------------------------------------
// Pages previews: every book's own Cloudflare Pages deployments resolve to it
// ---------------------------------------------------------------------------

const onPages = (slug, domain, project, extra = {}) =>
  book(slug, domain, { site: { domain, legacy_origins: [], host: { kind: 'static', provider: 'cloudflare-pages', project, ...extra } } });

test('previews: <project>.pages.dev and <branch>.<project>.pages.dev resolve to the book, echoing that origin', () => {
  const r = createResolver(validateRegistry(registryOf(
    onPages('alpha', 'alpha.example', 'alpha-book'),
    // Its domain still served elsewhere (book one on Publish), but the builder deploys it.
    book('beta', 'beta.example', { site: { domain: 'beta.example', legacy_origins: [], host: { kind: 'obsidian-publish', builder: 'quartz-book', project: 'beta-book' } } }),
    // No domain yet: reachable only from its Pages address.
    { ...onPages('gamma', null, 'gamma-book'), status: 'preview' },
  )));
  for (const [origin, slug] of [
    ['https://alpha.example', 'alpha'],
    ['https://alpha-book.pages.dev', 'alpha'],
    ['https://drafts.alpha-book.pages.dev', 'alpha'],
    ['https://3f2a91c0.alpha-book.pages.dev', 'alpha'],
    ['https://beta-book.pages.dev', 'beta'],
    ['https://drafts.beta-book.pages.dev', 'beta'],
    ['https://gamma-book.pages.dev', 'gamma'],
  ]) {
    const res = r.resolve(origin);
    assert.equal(res.ok && res.book.slug, slug, origin);
    assert.equal(res.origin, origin, `${origin} is echoed as itself`);
  }
});

test('previews: look-alikes, other projects, deeper labels, http and ports are refused', () => {
  const r = createResolver(validateRegistry(registryOf(onPages('alpha', 'alpha.example', 'alpha-book'))));
  for (const origin of [
    'https://alpha-book.pages.dev.evil.example',
    'https://evil-alpha-book.pages.dev',
    'https://other-book.pages.dev',
    'https://a.b.alpha-book.pages.dev',
    'http://alpha-book.pages.dev',
    'https://alpha-book.pages.dev:443',
    'https://ALPHA-BOOK.pages.dev',
    'https://alpha-book.pages.dev/',
    'https://-x.alpha-book.pages.dev',
  ]) {
    assert.deepEqual(r.resolve(origin), { ok: false, reason: 'unregistered' }, origin);
  }
});

test('previews: a book without a Pages project, a retired book, and suggest-edit off get nothing', () => {
  const r = createResolver(validateRegistry(registryOf(
    book('plain', 'plain.example', { site: { domain: 'plain.example', legacy_origins: [], host: { kind: 'obsidian-publish' } } }),
    { ...onPages('old', 'old.example', 'old-book'), status: 'retired' },
    { ...onPages('off', 'off.example', 'off-book'), suggest_edit: { enabled: false } },
  )));
  assert.deepEqual(r.resolve('https://plain.pages.dev'), { ok: false, reason: 'unregistered' });
  assert.deepEqual(r.resolve('https://old-book.pages.dev'), { ok: false, reason: 'unregistered' });
  assert.deepEqual(r.resolve('https://off-book.pages.dev'), { ok: false, reason: 'suggest_edit disabled for off' });
});

test('previews: two books claiming one Pages project are refused at load', () => {
  assert.throws(
    () => validateRegistry(registryOf(onPages('a', 'a.example', 'shared'), onPages('b', 'b.example', 'shared'))),
    /duplicate Cloudflare Pages project: shared/,
  );
});

test('previews through the real handler: CORS echoes the preview origin, and the issue goes to its book', async () => {
  const b = REGISTRY.books.find((x) => x.status !== 'retired' && x.suggest_edit.enabled && x.site.host?.project);
  if (!b) return; // the bundled registry has no Pages-hosted book
  const origin = `https://drafts.${b.site.host.project}.pages.dev`;
  const pre = await call({ method: 'OPTIONS', origin });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers['access-control-allow-origin'], origin);
  const r = await call({ origin, body: { ...VALID } });
  assert.equal(r.status, 201);
  assert.equal(r.headers['access-control-allow-origin'], origin);
  assert.ok(requests.some((q) => q.url.startsWith(`https://api.github.com/repos/${b.content.repo}/issues`)));
});
