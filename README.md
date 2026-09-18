# suggest-edit-function

Vercel serverless function behind the textbooks' **suggest an edit** form. It takes a
reader's suggestion, works out which book it is for from the request's `Origin`, and
files it as a GitHub issue on that book's content repo, authenticated as a GitHub App.
Which books exist, and where each one's issues go, comes from the
[textbook registry](https://github.com/textbookproject2026-alt/textbook-registry), baked
in at build time. No book is hardcoded here.

Zero dependencies — Node 22 with built-in `fetch` and `node:crypto`, plain ES modules.

```
api/suggest-edit.js            the handler
lib/registry.mjs               registry validation and Origin -> book resolution
lib/github-app.mjs             App JWT (RS256 via node:crypto) and installation tokens
registry/bundled.mjs           GENERATED registry snapshot, pinned to a registry commit
scripts/bundle-registry.mjs    writes registry/bundled.mjs (the Vercel build step)
test/assertions.test.mjs       abuse-test assertion suite
test/registry.test.mjs         book resolution
test/github-app.test.mjs       App credential path, token exchange stubbed
test/harness.mjs               drives the real handler with fetch stubbed
vercel.json                    maxDuration only
package.json                   pins Node 22 via engines; test and build scripts
```

Run the suite with `npm test` (Node's built-in runner, no dependencies). It never
contacts GitHub. `TESTING.md` records the abuse-test pass the original assertions came from.

The Node version comes from `engines.node` in `package.json` (plus the project's
Node setting in the Vercel dashboard). Do **not** add a `runtime` key to
`vercel.json` — that field is only for versioned community-runtime packages
(`now-php@1.0.0`), and setting it on a first-party Node function fails the build
with "Function Runtimes must have a valid version".

---

## The contract

Fixed by the live front-end. Do not change either side alone.

### Request

`POST /api/suggest-edit`, `Content-Type: application/json`

| Field        | Required | Notes                                                           |
| ------------ | -------- | --------------------------------------------------------------- |
| `name`       | yes      | ≤ 200 chars                                                     |
| `email`      | yes      | shape-checked; **masked** in the issue (`a***@example.com`)      |
| `suggestion` | yes      | ≤ 5000 chars                                                    |
| `reasoning`  | no       | ≤ 5000 chars                                                    |
| `path`       | yes      | repo-relative `.md` path, e.g. `chapters/03-methods.md`          |
| `website`    | no       | **honeypot** — hidden field; humans leave it empty               |

### Responses

**201** — issue filed:

```json
{ "issueUrl": "https://github.com/<book content repo>/issues/42" }
```

**4xx / 5xx** — failure:

```json
{ "error": "validation: email malformed", "userMessage": "That email address does not look right." }
```

- `error` is **log material**. It is deliberately free of internals — no stack traces,
  no upstream response bodies, never the token — because the reader can read it.
- `userMessage` is optional safe plain text (≤ 200 chars) the client may show verbatim.
  It is omitted when the client already has fixed copy for that case (e.g. 502).

| Status | When                                        | `userMessage`? |
| ------ | ------------------------------------------- | -------------- |
| 201    | issue created, **or** honeypot tripped      | —              |
| 204    | `OPTIONS` preflight                         | —              |
| 400    | bad JSON or a failed field check            | yes            |
| 403    | `Origin` missing, or not a registered book (see below) | no  |
| 415    | `Content-Type` is not `application/json`    | yes            |
| 405    | any method other than `POST` / `OPTIONS`    | no             |
| 429    | rate limit exceeded                         | yes            |
| 500    | no GitHub credential configured, or an escaped throw | no    |
| 502    | GitHub call failed or timed out, no App token could be minted, or the App isn't installed on the book's repo | no |

Every response carries `X-Registry-Version: <registry commit SHA>`, the registry
snapshot this deployment was built with.

---

## Behaviour notes

**Content-Type.** Only `application/json` is accepted (parameters such as
`; charset=utf-8` are fine); anything else gets a `415`. This is deliberate:
`text/plain`, `multipart/form-data` and `application/x-www-form-urlencoded` are CORS
*simple requests*, which a browser will send cross-origin with no preflight at all.
Requiring JSON forces a preflight, so the origin allowlist is enforced by the browser
before the request is ever sent.

**User content in the issue.** `suggestion` and `reasoning` go inside a fence whose
backtick run is longer than any run in the content, and `name` plus the masked email
go inside a code span (`inlineCode`). Nothing a reader types can become a heading, a
link, an image, or an `@mention` that notifies someone. See `TESTING.md`.

**How a book is resolved.** Before anything else, preflight included, the `Origin`
header is looked up in the bundled registry. It resolves only if it is **exactly**
`https://` + a book's `site.domain`, for a book whose `status` is `preview` or `live`.
There is no suffix, prefix or wildcard match, no case folding and no `www.` folding, so
`http://confused4now.org`, `https://www.confused4now.org` and
`https://confused4now.org.evil.example` all fail. A book's `legacy_origins` are never
accepted. Once resolved, everything book-specific comes from that registry entry: the
issue goes to `content.repo`, the file link uses `content.live_branch`, the honeypot's
`issueUrl` is that repo's issues index, `Access-Control-Allow-Origin` is the
registry-derived origin (never the raw header), and log lines end in `book=<slug>`.
After filing, the function checks that GitHub's `repository_url` matches the book's
repo and logs `ROUTING:` at error level if it doesn't (the reader still gets 201).

**Unknown origin.** An `Origin` that resolves to no book gets **403
`{ "error": "origin not allowed" }` with no CORS headers**, for `OPTIONS` as well as
`POST`, so a browser never sends the real request. It is never mapped to another book
or to a default. The same 403 applies to a registered book with
`suggest_edit.enabled: false`. The origin is logged
(`origin rejected: <origin> (unregistered)`), never echoed.

**No `Origin`: refused (behaviour change, migration step 2b).** A request with no
`Origin` header, or an empty one, gets **403 `{ "error": "origin required" }`** with no
CORS headers, for every method, and nothing is filed. The log line is `origin missing`.
Until this change such a request was filed against the registry's only book (the
`ALLOW_ORIGINLESS_SOLE_BOOK` flag). With more than one book there is no book to
default to, so the flag is gone. **curl and server-to-server callers stop working
unless they send a registered book's `Origin`**, as the smoke tests below do. The change
is a commit of its own, so it can be reverted alone; a revert is only safe while the
registry holds a single book. This is not a security boundary (a non-browser client can
send any `Origin`); the rate limit and honeypot still do that work.

**Everything is re-validated server-side.** The front-end validates too, but that is
advisory only: anyone can POST here directly. `path` must match
`^[\w\-/().,'&%+ —]+\.md$` and is additionally refused if it contains `..`, `//`, or
`://`, or starts with `/`.

**Honeypot.** If `website` is non-empty the submission is discarded and the response
is still `201`, with `issueUrl` pointing at the repo's issues index. A bot is never
told it was caught — otherwise it learns to fix its input. The hit is logged.

**Rate limit — best-effort only.** 5 submissions per hour per IP (first hop of
`x-forwarded-for`), held in an in-memory `Map` with a periodic sweep. Be honest about
what this is: the Map lives in **one serverless instance**. Vercel runs many instances
and recycles them freely, so the counter is per-instance and **resets on every cold
start**. Someone hitting different instances gets more than 5/hour. It is a speed bump
against casual form-mashing, not a control. Real hardening (shared KV/Redis counter
plus edge-level limits) is **Day 28**.

**Labels.** `suggested-edit` and `needs-triage` are checked with a `GET` and created
via the API if missing (Issues: write covers labels). A label failure is non-fatal — a missing
label is cosmetic next to a lost suggestion.

**Timeouts and leaks.** The issue call is aborted at 8s via `AbortController`; the two
label checks share a separate 3s budget, and minting an App token (installation lookup
plus exchange) has its own 3s, so a
hung GitHub costs at most ~14s and the function returns its own 502 rather than
tripping the platform's `maxDuration` (15s). The whole handler is wrapped so nothing
can put a stack trace — or a credential — into a response. The private key, the App
JWT, installation tokens and `BOT_TOKEN` only ever go into an `Authorization` header;
they are never logged or echoed.

---

## Environment

| Variable                     | Required | Description |
| ---------------------------- | -------- | ----------- |
| `GITHUB_APP_ID`              | yes      | The GitHub App's numeric **App ID** (App settings → General → About). Not the Client ID. |
| `GITHUB_APP_INSTALLATION_ID` | **no longer read** | The installation is now looked up per repository. If it is still set, startup logs a warning asking for it to be deleted. |
| `GITHUB_APP_PRIVATE_KEY`     | yes      | The App's private key, **base64-encoded** (see below). |
| `BOT_TOKEN`                  | temporary | The old personal access token. **A fallback for the App rollout only**, to be deleted along with its code once `credential=app` is proven in production. |

**The App.** Permissions **Issues: Read and write** and **Metadata: Read-only**, nothing
else. No webhook. Install it on **only selected repositories**: each registered book's
content repo, never "All repositories". A book's repo may belong to any GitHub account,
so each maintainer installs the App on their own repo; the App must be **public** (App
settings → Advanced → "Make public") for accounts other than its owner to install it.

**The installation is found per repository.** For a book's `content.repo`, the function
calls `GET /repos/{owner}/{repo}/installation` as the App (JWT), then mints a token from
that installation downscoped to the one repository and `issues: write`, and refuses the
token unless GitHub granted exactly that repository. A repo the App isn't installed on
(GitHub answers 404) gets 502 `{ "error": "github: the app isn't installed on that
repository" }`, and the log names the repo:
`credential: app token unavailable for <repo> — the app isn't installed on <repo>`.

**The private key must be base64-encoded.** GitHub gives you a multi-line `.pem` file,
and Vercel env vars mangle the newlines in a raw PEM. Encode the whole file on one line:

```bash
base64 -i textbook-suggestions.2026-09-15.private-key.pem | tr -d '\n' | pbcopy   # macOS
base64 -w0 textbook-suggestions.2026-09-15.private-key.pem                         # Linux
```

and paste that as `GITHUB_APP_PRIVATE_KEY`. It is decoded at runtime. A raw PEM, invalid
base64, or something that does not decode to an RSA private key is rejected with a
message naming the problem (never the key).

**Startup checks.** All credential variables are checked once per cold start, and the
result is logged loudly:

| Config | Log at startup | Each submission |
| ------ | -------------- | --------------- |
| App vars valid | `config: credential=app (app <id>, installation looked up per repository)` | App token. Logs `credential=app (minted … for <repo>, installation <id>)` or `(cached …)` |
| App vars missing, partial or malformed, `BOT_TOKEN` set | `config: GitHub App NOT usable — <what is wrong>` (error level) | `BOT_TOKEN`. Logs `credential=bot_token (fallback; …)` (warn) |
| No usable App and no `BOT_TOKEN` | `config: FATAL no GitHub credential — …` (error level) | 500 `bot credentials not configured` |

If the App is configured but minting a token fails at request time (the App isn't
installed on that repo, the key was revoked, GitHub is down), the function falls back to
`BOT_TOKEN` when it is set, logging the reason. Without `BOT_TOKEN` it returns 502 and
files nothing: `github: the app isn't installed on that repository` when that is the
cause, `github: credential unavailable` otherwise. **To prove the App is live, look
for `credential=app` and no `credential=bot_token` in `vercel logs`.**

**Caching.** Installation tokens last an hour. Each warm instance caches the
installation ID and the token per repository, and reuses the token until it has less
than 5 minutes left. A 401 from GitHub drops both, and so does a failed exchange (the
App may have been reinstalled under a new ID). "Not installed" is never cached, so
installing the App works from the next request. A cold start begins empty.

Set them in Vercel (production; a preview deployment should get a separate test App
installed only on a scratch repo):

```bash
vercel env add GITHUB_APP_ID production
vercel env add GITHUB_APP_PRIVATE_KEY production
```

Mark `GITHUB_APP_PRIVATE_KEY` as **Sensitive** in the Vercel dashboard (Settings →
Environment Variables).

Locally, put them in `.env` (git-ignored — `.env*` never gets committed).

Rotate the key by generating a new one in the App settings, replacing
`GITHUB_APP_PRIVATE_KEY`, redeploying, then deleting the old key in GitHub; no code change.

---

## The registry

`registry/bundled.mjs` is a snapshot of `registry.json` from
`textbookproject2026-alt/textbook-registry`, pinned to a commit SHA. The function never
fetches the registry at runtime, so a cold start costs nothing extra and cannot fail on
it. The build step (`vercel-build`) resolves the registry's `main` to a SHA, fetches
`registry.json` at that SHA, validates it, rewrites the snapshot, and then runs
`npm test`. If any step fails, the deploy fails and the previous deployment stays live.
Vercel instant rollback restores code and registry together.

- **A registry change takes effect on the next deploy** of this project. The registry's
  CI should call a Vercel deploy hook after each merge.
- **Pin a registry commit** by setting `REGISTRY_REF=<40-char sha>` (or a branch name) as
  a build env var.
- **Refresh the committed snapshot** locally with `npm run registry:bundle`. The
  committed copy is what `npm test` runs against. Production always rebuilds it.
- The handler validates the snapshot again at load and refuses to start on anything
  ambiguous: duplicate slugs, repos or domains, or a domain that is also a legacy origin.

---

## Deploy

```bash
npm i -g vercel     # once
vercel login
vercel link         # once, to bind this directory to the project

vercel              # preview deploy
vercel --prod       # production
```

Pushing to `main` on a Vercel-connected repo deploys production automatically; other
branches get preview deploys. The build step is `npm run vercel-build` (bundle the
registry, then run the tests). There is nothing to install.

Run it locally:

```bash
vercel dev          # http://localhost:3000/api/suggest-edit
```

---

## Smoke tests

Against a preview or local URL. Note the `Origin` header — a real browser always
sends one, and a request without it gets 403 `origin required`.

```bash
URL=http://localhost:3000/api/suggest-edit

# preflight -> 204
curl -i -X OPTIONS "$URL" -H "Origin: https://confused4now.org"

# happy path -> 201 { issueUrl }
curl -i -X POST "$URL" \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://confused4now.org' \
  -d '{"name":"Ada","email":"ada@example.com","path":"chapters/01-intro.md",
       "suggestion":"Typo in paragraph two: \"recieve\" -> \"receive\".",
       "reasoning":"Spelling.","website":""}'

# honeypot -> 201, no issue filed
curl -i -X POST "$URL" \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://confused4now.org' \
  -d '{"name":"Bot","email":"b@b.com","path":"a.md","suggestion":"buy","website":"http://spam"}'

# wrong method -> 405
curl -i "$URL" -H "Origin: https://confused4now.org"

# wrong origin -> 403
curl -i -X POST "$URL" -H 'Content-Type: application/json' \
  -H 'Origin: https://evil.example' -d '{}'

# no Origin -> 403 origin required
curl -i -X POST "$URL" -H 'Content-Type: application/json' -d '{}'

# unregistered or look-alike origin -> 403, no CORS headers
curl -i -X OPTIONS "$URL" -H 'Origin: https://www.confused4now.org'

# which registry this deployment was built with
curl -sI -X OPTIONS "$URL" -H 'Origin: https://confused4now.org' | grep -i x-registry-version
```

Watch the logs with `vercel logs <deployment-url>` — validation rejections, honeypot
hits, rate-limit trips, the credential path (`credential=app` / `credential=bot_token`),
and GitHub failures all land there with the detail the response withholds.
