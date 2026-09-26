# suggest-edit-function

Vercel serverless function behind the textbooks' **suggest an edit** form. It takes a
reader's suggestion, works out which book it is for from the request's `Origin`, and
files it as a GitHub issue on that book's content repo, authenticated as a GitHub App.
Which books exist, and where each one's issues go, comes from the
[textbook registry](https://github.com/textbookproject2026-alt/textbook-registry), baked
in at build time. No book is hardcoded here.

Zero dependencies — Node 22 with built-in `fetch` and `node:crypto`, plain ES modules.

```
api/suggest-edit.js            suggest an edit: reader text -> issue
api/propose-edit.js            the in-site editor: reader edit -> PR into drafts
api/github-auth.js             "Sign in with GitHub" popup for the editor
lib/common.mjs                 what the endpoints share (fetch, credential, limiter, helpers)
lib/identity.mjs               signed identity tokens (sign-in without keeping GitHub tokens)
lib/registry.mjs               registry validation and Origin -> book resolution
lib/github-app.mjs             App JWT (RS256 via node:crypto) and installation tokens
registry/bundled.mjs           GENERATED registry snapshot, pinned to a registry commit
scripts/bundle-registry.mjs    writes registry/bundled.mjs (the Vercel build step)
test/assertions.test.mjs       abuse-test assertion suite
test/registry.test.mjs         book resolution
test/github-app.test.mjs       App credential path, token exchange stubbed
test/harness.mjs               drives the real handler with fetch stubbed
test/propose-edit.test.mjs     propose-edit and github-auth against an in-memory GitHub
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
snapshot this deployment was built with. It also carries `X-Function-Version: <this repo's commit SHA>`
(`VERCEL_GIT_COMMIT_SHA` at build time, `local` elsewhere). A merge here changes only the second.
`.github/workflows/deployed.yml` runs on every push to `main` and waits up to ten minutes
for production to send this commit (or a later one) in `X-Function-Version`. It goes red on the
merge commit if production doesn't. Vercel builds `main` on push by itself. If production is still
behind after four minutes and the optional secret `SUGGEST_EDIT_DEPLOY_HOOK` is set here, the
job fires the hook once. The registry's `deploy.yml` still polls `X-Registry-Version` for
registry changes.

---

## The in-site editor (`/api/propose-edit`, `/api/github-auth`)

The edit-on-github plugin's **Edit this page** button and the per-paragraph pencil open a
GitHub-style editor on the book's own page. This is its back end.

- `GET /api/propose-edit?path=<repo path>` returns `{ path, branch, sha, content, signIn }`:
  the page's source on the book's `content.drafts_branch` (falling back to `live_branch`
  when the registry names none), LF line endings, and the blob sha the edit is based on.
- `POST /api/propose-edit` with `mode: "page"` (`content`) or `mode: "paragraph"`
  (`startLine`, `original`, `replacement`, optional `paragraph`), plus `path`, `baseSha`,
  `title`, `description`, and either `identity` or `name` + `email` (+ `website`, the
  honeypot). It branches `proposed-edits/<page>-<time>-<rand>` from the drafts head,
  commits the one file, opens a PR into drafts labelled `proposed-edit` + `needs-triage`,
  and answers `201 { prUrl }`.
- **If drafts moved under the reader** (page mode: the blob sha differs; paragraph mode:
  the paragraph no longer occurs exactly once), nothing is committed. Their change is
  filed as an issue with a diff and the answer is `201 { issueUrl, fallback: true }`.
  Nothing a reader types is lost.
- **Attribution.** Anonymous: the App authors the commit; the reader's name and masked
  email appear in the PR body only, never in git history. Signed in: the commit's author
  is the reader's `<id>+<login>@users.noreply.github.com`, so it counts on their GitHub
  profile and the contributors page, and the PR body @-mentions them so they follow it.
- **Sign-in** (`/api/github-auth`) is an OAuth App with **no scopes**. The popup comes back
  to this function, which asks GitHub who the reader is, **revokes the GitHub token
  immediately**, and posts a signed identity token (8 hours, bound to the book's origin)
  to the opener at the registry origin only. A nonce cookie ties the callback to the
  browser that started it.
- Limits: 5 proposals and 60 source reads per hour per IP (per instance, as suggest-edit);
  400,000 characters per page, 20,000 per paragraph; one shared 20s GitHub budget per
  request (`maxDuration` 25s).

---

## Book requests (`/api/request-book`)

The portal's *Publish your textbook here* form. Accepted only from the portal
(`https://<platform.portal.domain>`, and `<portal project>.pages.dev` with its
previews). It commits any manuscript files (.docx/.md, at most 5, 3 MB in total)
to `requests/<reference>/` on the **private** requests repo and files an issue
there labelled `book-request` + `needs-review`, ending in a JSON block that
book-requests' `provision` workflow reads when the issue is labelled `approved`.
Files first, then the issue; a failed upload still files the request and tells
the requester. Honeypot `website`; 3 requests per IP per hour (best-effort, as
below).

- `REQUESTS_REPO` (optional): `owner/name` of the requests repo. Default
  `textbookproject2026-alt/book-requests`.
- The App must be installed on that repo. Tokens are downscoped to it, with
  `issues` + `contents` write.

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
header is looked up in the bundled registry, for books whose `status` is `preview` or
`live`. It resolves when it is **exactly** one of:

- `https://` + the book's `site.domain` (its public address), or
- one of the platform's own Cloudflare Pages deployments of the book:
  `https://<project>.pages.dev`, or `https://<label>.<project>.pages.dev` for a branch
  preview such as `drafts` or a single deployment, where `<project>` is the book's
  `site.host.project` and the book is built by the shared builder
  (`site.host.builder: "quartz-book"`) or hosted on Cloudflare Pages
  (`site.host.provider: "cloudflare-pages"`).

The Pages rule is what makes every book's previews work without per-book setup. Book
one's builder deploy, for example, lives at `social-research-methods.pages.dev` while
its domain is still on Obsidian Publish. Only the platform's Pages account can serve
pages under a project's `pages.dev` name, so they're as trustworthy as the domain; two
books claiming one project is refused at load. Otherwise there is no suffix, prefix or
wildcard match, no case folding, no ports and no `www.` folding: the `http://` form,
the `www.` form, `https://social-research-methods.confused4now.org.evil.example`,
`https://evil-social-research-methods.pages.dev` and `a.b.<project>.pages.dev` all
fail, as does the platform portal at `https://confused4now.org`, which is nobody's
`site.domain`. A book's `legacy_origins` are never accepted. Once resolved, everything
book-specific comes from that registry entry: the issue goes to `content.repo`, the
file link uses `content.live_branch`, the honeypot's `issueUrl` is that repo's issues
index, `Access-Control-Allow-Origin` is the request's origin *as matched* above (never an
unmatched header), and log lines end in `book=<slug>`.
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
| `GITHUB_OAUTH_CLIENT_ID`     | for sign-in | The **OAuth App** (not the GitHub App) used only for "Sign in with GitHub" in the editor. |
| `GITHUB_OAUTH_CLIENT_SECRET` | for sign-in | Its client secret. Mark **Sensitive**. |
| `IDENTITY_SECRET`            | for sign-in | 32+ random characters; signs the identity tokens. Rotating it signs everyone out. |
| `GITHUB_OAUTH_REDIRECT_URI`  | no | Defaults to `https://<request host>/api/github-auth`. Set it if the OAuth App's callback URL differs. |
| `BOT_TOKEN`                  | temporary | The old personal access token. **A fallback for the App rollout only**, to be deleted along with its code once `credential=app` is proven in production. |

**The App.** Permissions **Issues: Read and write**, **Contents: Read and write**,
**Pull requests: Read and write** and **Metadata: Read-only**, nothing else. (Contents and
Pull requests arrived with the in-site editor. Each installation must accept the new
permissions before propose-edit works on that repo; suggest-edit's tokens stay
downscoped to `issues: write` regardless.) No webhook. Install it on **only selected repositories**: each registered book's
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
  `deploy.yml` calls this project's Vercel deploy hook after every merge to its `main`,
  then polls `X-Registry-Version` and fails the registry's run if production hasn't
  caught up within ten minutes. It also checks every six hours. The hook lives in the
  registry repo's `SUGGEST_EDIT_DEPLOY_HOOK` secret (see its README, "Delivery to
  services").
- **Pin a registry commit** by setting `REGISTRY_REF=<40-char sha>` (or a branch name) as
  a build env var. While a pin is set, registry merges still trigger rebuilds but can't
  change what is served, so the registry's deploy check goes red until the pin is removed.
- **Refresh the committed snapshot** locally with `npm run registry:bundle`. The
  committed copy is what `npm test` runs against. Production always rebuilds it.
- The handler validates the snapshot again at load and refuses to start on anything
  ambiguous: duplicate slugs, repos, domains or Pages projects, or a domain that is
  also a legacy origin.

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
curl -i -X OPTIONS "$URL" -H "Origin: https://social-research-methods.confused4now.org"

# happy path -> 201 { issueUrl }
curl -i -X POST "$URL" \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://social-research-methods.confused4now.org' \
  -d '{"name":"Ada","email":"ada@example.com","path":"chapters/01-intro.md",
       "suggestion":"Typo in paragraph two: \"recieve\" -> \"receive\".",
       "reasoning":"Spelling.","website":""}'

# honeypot -> 201, no issue filed
curl -i -X POST "$URL" \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://social-research-methods.confused4now.org' \
  -d '{"name":"Bot","email":"b@b.com","path":"a.md","suggestion":"buy","website":"http://spam"}'

# wrong method -> 405
curl -i "$URL" -H "Origin: https://social-research-methods.confused4now.org"

# wrong origin -> 403
curl -i -X POST "$URL" -H 'Content-Type: application/json' \
  -H 'Origin: https://evil.example' -d '{}'

# no Origin -> 403 origin required
curl -i -X POST "$URL" -H 'Content-Type: application/json' -d '{}'

# unregistered or look-alike origin -> 403, no CORS headers
curl -i -X OPTIONS "$URL" -H 'Origin: https://www.social-research-methods.confused4now.org'

# which registry this deployment was built with
curl -sI -X OPTIONS "$URL" -H 'Origin: https://social-research-methods.confused4now.org' | grep -i x-registry-version
```

Watch the logs with `vercel logs <deployment-url>` — validation rejections, honeypot
hits, rate-limit trips, the credential path (`credential=app` / `credential=bot_token`),
and GitHub failures all land there with the detail the response withholds.
