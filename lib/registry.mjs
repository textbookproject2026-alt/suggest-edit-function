/**
 * The textbook registry, as this function sees it.
 *
 * The full schema is enforced by the registry repo's CI. This module re-checks only
 * what the function relies on to route a credential, and refuses to load anything
 * ambiguous (DESIGN §1a: "every consumer checks again when it loads the registry").
 *
 * Used twice: by scripts/bundle-registry.mjs before it writes the snapshot, and by
 * the handler at module load. Zero dependencies.
 */

export const SUPPORTED_SCHEMA_VERSION = 1;

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const HOSTNAME_RE = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const REPO_RE = /^[A-Za-z0-9](-?[A-Za-z0-9]){0,38}\/[A-Za-z0-9._-]{1,100}$/;
const BRANCH_RE = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*\.lock$)[A-Za-z0-9._/-]+(?<![./])$/;
const STATUSES = new Set(['preview', 'live', 'retired']);

function duplicates(values) {
  const seen = new Set();
  const dups = new Set();
  for (const v of values) (seen.has(v) ? dups : seen).add(v);
  return [...dups];
}

/**
 * @param {unknown} registry parsed registry.json
 * @returns {object} the same registry, if it is usable
 * @throws {Error} listing every problem found
 */
export function validateRegistry(registry) {
  const errors = [];
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

  if (!isObj(registry)) throw new Error('registry: not a JSON object');
  if (registry.schema_version !== SUPPORTED_SCHEMA_VERSION) {
    throw new Error(`registry: schema_version ${registry.schema_version} is not supported (expected ${SUPPORTED_SCHEMA_VERSION})`);
  }
  if (!Array.isArray(registry.books)) throw new Error('registry: books must be an array');

  registry.books.forEach((b, i) => {
    const at = `books[${i}]${isObj(b) && typeof b.slug === 'string' ? ` (${b.slug})` : ''}`;
    if (!isObj(b)) return errors.push(`${at}: not an object`);
    if (typeof b.slug !== 'string' || !SLUG_RE.test(b.slug)) errors.push(`${at}: bad slug`);
    if (!STATUSES.has(b.status)) errors.push(`${at}: bad status ${JSON.stringify(b.status)}`);

    const domain = b.site?.domain;
    if (domain === null) {
      if (b.status !== 'preview') errors.push(`${at}: site.domain may be null only for a preview book`);
    } else if (typeof domain !== 'string' || !HOSTNAME_RE.test(domain)) {
      errors.push(`${at}: bad site.domain ${JSON.stringify(domain)}`);
    }
    if (!Array.isArray(b.site?.legacy_origins)) errors.push(`${at}: site.legacy_origins must be an array`);

    if (typeof b.content?.repo !== 'string' || !REPO_RE.test(b.content.repo)) errors.push(`${at}: bad content.repo`);
    if (typeof b.content?.live_branch !== 'string' || !BRANCH_RE.test(b.content.live_branch)) {
      errors.push(`${at}: bad content.live_branch`);
    }
    if (typeof b.suggest_edit?.enabled !== 'boolean') errors.push(`${at}: suggest_edit.enabled must be a boolean`);
  });

  if (errors.length === 0) {
    const books = registry.books;
    for (const s of duplicates(books.map((b) => b.slug))) errors.push(`duplicate slug: ${s}`);
    for (const r of duplicates(books.map((b) => b.content.repo.toLowerCase()))) errors.push(`duplicate content.repo: ${r}`);
    const domains = books.map((b) => b.site.domain).filter(Boolean);
    for (const d of duplicates(domains)) errors.push(`duplicate site.domain: ${d}`);
    for (const p of duplicates(books.map(previewProject).filter(Boolean))) {
      errors.push(`duplicate Cloudflare Pages project: ${p}`);
    }
    for (const b of books) {
      for (const o of b.site.legacy_origins) {
        let host = '';
        try { host = new URL(o).hostname; } catch { errors.push(`${b.slug}: bad legacy origin ${JSON.stringify(o)}`); }
        if (host && domains.includes(host)) errors.push(`site.domain ${host} is also a legacy origin of ${b.slug}`);
      }
    }
  }

  if (errors.length) throw new Error(`registry: ${errors.join('; ')}`);
  return registry;
}

/** A book's public address. Derived, never stored (DESIGN §0b). */
export function canonicalOrigin(book) {
  return `https://${book.site.domain}`;
}

const PAGES_PROJECT_RE = /^[a-z0-9](?:[a-z0-9-]{0,56}[a-z0-9])?$/;

/**
 * The Cloudflare Pages project the platform deploys this book to, or null. Every
 * book built by the shared builder has one (`site.host.builder: "quartz-book"`,
 * `site.host.project`), and so does any static book on Cloudflare Pages, whatever
 * serves its public domain today (book one's is still Obsidian Publish).
 */
export function previewProject(book) {
  const host = book.site?.host;
  const project = host?.project;
  if (typeof project !== 'string' || !PAGES_PROJECT_RE.test(project)) return null;
  return host.builder === 'quartz-book' || host.provider === 'cloudflare-pages' ? project : null;
}

// `https://<project>.pages.dev`, or a branch/deployment alias of it:
// `https://<label>.<project>.pages.dev` (the builder's drafts preview is one).
const PAGES_ORIGIN_RE = /^https:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)?([a-z0-9](?:[a-z0-9-]{0,56}[a-z0-9])?)\.pages\.dev$/;

/**
 * Build the Origin -> book lookup (DESIGN §3a).
 *
 * A book is reached from its public domain, `https://<site.domain>`, and from the
 * platform's own Cloudflare Pages deployments of it: `https://<project>.pages.dev`
 * and its branch previews `https://<branch>.<project>.pages.dev`. Those are this
 * book's builds on the platform's Pages account, so nobody else can serve a page
 * there; accepting them lets every book's previews use suggest-edit and the editor
 * before (and after) its domain points at them. Matching is otherwise exact: no
 * suffix or wildcard match beyond that one label, no case folding, no ports, no
 * www. folding. Legacy origins are never candidates, and retired books resolve
 * nowhere.
 */
export function createResolver(registry) {
  const byOrigin = new Map();
  const byProject = new Map();
  for (const book of registry.books) {
    if (book.status === 'retired') continue;
    if (book.site.domain) byOrigin.set(canonicalOrigin(book), book);
    const project = previewProject(book);
    if (project) byProject.set(project, book);
  }

  return {
    /**
     * @param {string} origin the raw Origin header
     * @returns {{ ok: true, book: object, origin: string } | { ok: false, reason: string }}
     *   `origin` is the request's origin, safe to echo: it matched exactly or matched
     *   one of this book's own Pages addresses.
     */
    resolve(origin) {
      // Map.get on Maps built from our own keys: no prototype lookups to worry about.
      let book = byOrigin.get(origin);
      if (!book && typeof origin === 'string') {
        const m = PAGES_ORIGIN_RE.exec(origin);
        if (m) book = byProject.get(m[1]);
      }
      if (!book) return { ok: false, reason: 'unregistered' };
      if (!book.suggest_edit.enabled) return { ok: false, reason: `suggest_edit disabled for ${book.slug}` };
      return { ok: true, book, origin };
    },
  };
}
