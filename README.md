# suggest-edit-function

Vercel serverless function behind the textbook's **suggest an edit** form. It takes a
reader's suggestion and files it as a GitHub issue on
[`textbookproject2026-alt/textbook`](https://github.com/textbookproject2026-alt/textbook/issues)
as the bot account.

Zero dependencies — Node 22 with built-in `fetch`, plain ES modules.

```
api/suggest-edit.js   the whole function
vercel.json           maxDuration only
package.json          pins Node 22 via engines
```

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
{ "issueUrl": "https://github.com/textbookproject2026-alt/textbook/issues/42" }
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
| 403    | `Origin` present and not the allowed origin | no             |
| 405    | any method other than `POST` / `OPTIONS`    | no             |
| 429    | rate limit exceeded                         | yes            |
| 500    | `BOT_TOKEN` missing, or an escaped throw    | no             |
| 502    | GitHub call failed or timed out             | no             |

---

## Behaviour notes

**CORS.** Exactly one origin is allowed: `https://bptext2026.xyz`, as
`ALLOWED_ORIGIN` at the top of `api/suggest-edit.js`. Add the production domain there
at cutover. `OPTIONS` gets 204 plus the CORS headers; a POST carrying a different
`Origin` gets 403. A request with **no** `Origin` header (curl, server-to-server) is
allowed through — CORS is a browser mechanism, not a security boundary, and it is the
rate limit and honeypot that do the real work here.

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
via the API if missing (the bot has Write). A label failure is non-fatal — a missing
label is cosmetic next to a lost suggestion.

**Timeouts and leaks.** The issue call is aborted at 8s via `AbortController`; the two
label checks share a separate 3s budget, so a hung GitHub costs at most ~11s and the
function returns its own 502 rather than tripping the platform's `maxDuration` (15s).
The whole handler is wrapped so nothing can put a stack trace — or the token — into a
response. `BOT_TOKEN` is only ever read into an `Authorization` header; it is never
logged or echoed.

---

## Environment

| Variable    | Required | Description                                                                                             |
| ----------- | -------- | ------------------------------------------------------------------------------------------------------- |
| `BOT_TOKEN` | yes      | GitHub token for the bot account, with **Write** access to issues and labels on `textbook`. Never logged. |

A fine-grained personal access token needs, on `textbookproject2026-alt/textbook`:

- **Issues:** Read and write
- **Metadata:** Read-only (required alongside Issues)

Set it in Vercel:

```bash
vercel env add BOT_TOKEN production
vercel env add BOT_TOKEN preview
```

Locally, put it in `.env` (git-ignored — `.env*` never gets committed):

```
BOT_TOKEN=github_pat_...
```

Rotate the token by replacing the Vercel env var and redeploying; no code change.

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
branches get preview deploys. There is no build step and nothing to install.

Run it locally:

```bash
vercel dev          # http://localhost:3000/api/suggest-edit
```

---

## Smoke tests

Against a preview or local URL. Note the `Origin` header — a real browser always
sends one.

```bash
URL=http://localhost:3000/api/suggest-edit

# preflight -> 204
curl -i -X OPTIONS "$URL" -H "Origin: https://bptext2026.xyz"

# happy path -> 201 { issueUrl }
curl -i -X POST "$URL" \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://bptext2026.xyz' \
  -d '{"name":"Ada","email":"ada@example.com","path":"chapters/01-intro.md",
       "suggestion":"Typo in paragraph two: \"recieve\" -> \"receive\".",
       "reasoning":"Spelling.","website":""}'

# honeypot -> 201, no issue filed
curl -i -X POST "$URL" \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://bptext2026.xyz' \
  -d '{"name":"Bot","email":"b@b.com","path":"a.md","suggestion":"buy","website":"http://spam"}'

# wrong method -> 405
curl -i "$URL" -H "Origin: https://bptext2026.xyz"

# wrong origin -> 403
curl -i -X POST "$URL" -H 'Content-Type: application/json' \
  -H 'Origin: https://evil.example' -d '{}'
```

Watch the logs with `vercel logs <deployment-url>` — validation rejections, honeypot
hits, rate-limit trips, and GitHub failures all land there with the detail the
response withholds.
