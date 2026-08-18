# Abuse testing — `POST /api/suggest-edit`

Adversarial test pass against the **live** deployment
`https://suggest-edit-function.vercel.app/api/suggest-edit`, plus the patches the
findings justified.

**Rules of engagement.** Real issue creation was minimised: every test below is a
variant that files *nothing* (validation rejection, honeypot, oversized, wrong
content-type, traversal), and the rate-limit run was deliberately driven with
**invalid** payloads so it filed zero issues. Exactly **one** live issue was
permitted and created — the fence-escape rendering check (see
[Live issues created](#live-issues-created)).

Baseline before testing: repo `textbookproject2026-alt/textbook` held **1** issue
(`#1`). Creation is verified by polling the public issues API and counting, not by
trusting the endpoint's own response.

```sh
U=https://suggest-edit-function.vercel.app/api/suggest-edit
count() { curl -sS "https://api.github.com/repos/textbookproject2026-alt/textbook/issues?state=all&per_page=100" \
  | grep -c '"number":'; }
```

---

## Testing constraints that shaped the plan

Two properties of the handler dictate how these tests had to be sequenced.

**1. The limiter is metered per request, and it runs before validation.** Any
request that reaches `isRateLimited` spends one of five hourly tokens *even if it is
about to be rejected as invalid*. Only 5 metered probes per IP per instance per hour
are available, which is fewer than the number of metered tests. Checks that
short-circuit **before** the limiter are unmetered and unlimited:

| Short-circuits before the limiter (free) | Reaches the limiter (metered) |
| --- | --- |
| `OPTIONS` preflight, `Origin` mismatch (403), method guard (405), JSON parse failure (400), **honeypot (201)** | every field-validation path, and issue creation |

**2. Per-instance routing is a real confound.** The counter is an in-memory `Map` on
one serverless instance. Two consecutive requests can land on different instances
and see different counts, and *every new deployment starts every counter at zero*.
Results below record this explicitly rather than assuming a single global counter.

Because of (1) and (2), the metered "before" probes were run against a **freshly
deployed but still unpatched** build, so they started from a clean 5-token budget.

---

## Test plan and results

Legend — **Before**: behaviour of the deployed code prior to the patch.
**After**: same probe re-run against the patched deployment.

### 1. Honeypot filled

```sh
curl -sS -X POST "$U" -H 'Content-Type: application/json' -d '{
 "name":"Bot McBot","email":"bot@example.com","suggestion":"buy cheap things",
 "reasoning":"spam","path":"chapters/chapter-03.md","website":"http://spam.example"}'
```

**Expected.** `201` carrying the issues-index URL, and **no issue filed**. A caught
bot must never learn it was caught, or it fixes its input and comes back.

| | Result |
| --- | --- |
| **Before** | `201 {"issueUrl":"https://github.com/textbookproject2026-alt/textbook/issues"}`; issue count **1 → 1**. ✅ |
| **After** | Unchanged. ✅ |

Verified by count, not by trusting the response: `count()` returned `1` immediately
before and after. Note the response carries no `error` key, so the shape is
indistinguishable from a real success.

*Incidental finding:* the honeypot check sits **before** the limiter, so honeypot
submissions are unmetered and a bot can send unlimited ones. Not patched — see
[Observed but not patched](#observed-but-not-patched).

---

### 2. Rate limit — 6 rapid invalid posts

Driven with `{"bogus":1}`, which can never validate, so this run files **zero**
issues no matter how far it gets.

```sh
for i in $(seq 1 6); do
  curl -sS -X POST "$U" -H 'Content-Type: application/json' -d '{"bogus":1}' \
       -w '\nHTTP:%{http_code}\n'
done
```

**Expected.** Five `400`s (the payload is invalid) then a `429` — which only happens
if **the limiter runs before validation**. If invalid payloads did *not* consume
budget, an attacker could probe the endpoint indefinitely for free and the limiter
would only ever throttle well-formed traffic.

| | Result |
| --- | --- |
| **Before** | `400, 400, 429, 429, 429, 429`. The limiter **already precedes validation** — a `{"bogus":1}` body returned `429`, not a validation `400`. ✅ *no patch needed* |
| **After** | `400 ×5` then `429`, on a clean instance — the canonical shape. The `429` now reads `{"error":"rate limit exceeded"}`, no longer replaying the caller's IP. ✅ |

The before-run shows `429` from the third request, not the sixth, because two
earlier probes in the same hour had already spent two of the five tokens — the
budget reconciles exactly. The after-run was executed against a freshly deployed
instance with an untouched counter, which reproduces the textbook `400 ×5 → 429`
shape.

**Per-instance routing is a genuine confound and is not hand-waved here.** The
counter is an in-memory `Map` on one instance, so this test only means anything when
you know which instance answered. Two controls were run:

- **Spoofing.** `X-Forwarded-For: 203.0.113.55` (and a two-hop
  `203.0.113.7, 46.231.20.253`) changed nothing — every reply still named the real
  edge-observed IP. Vercel overwrites the header, so `clientIp()` cannot be forged
  and the limiter's identity source is sound. ✅
- **Concurrency.** 10 simultaneous requests all returned `429`, so at this volume a
  single warm instance served everything and the counter behaved as one global
  budget. That is *not* a guarantee — it is what happened at this scale.

The limiter remains a speed bump, exactly as the source comment claims: a new
deployment resets every counter to zero (repeatedly exploited during this pass to
regain test budget), and enough concurrency would eventually spread load across
instances that each carry their own five-token allowance.

---

### 3. Oversized body — 1MB `name`, 1MB `reasoning`

```sh
python3 -c "import json;print(json.dumps({'name':'A'*1048576,'email':'t@example.com',
  'suggestion':'x','reasoning':'B'*1048576,'path':'chapters/chapter-03.md'}))" > big.json
curl -sS -X POST "$U" -H 'Content-Type: application/json' --data-binary @big.json
```

**Expected.** A clean `400` from the length caps — not a crash, a timeout, or a
platform error page — and nothing filed.

| | Result |
| --- | --- |
| **Before** | 2 MB combined body → `400 validation: name too long`. ✅ |
| **After** | 1 MB `name` → `400 validation: name too long`; 1 MB `reasoning` → `400 validation: reasoning too long`. ✅ |

Caps were already present and correct (`name ≤ 200`, `suggestion`/`reasoning ≤ 5000`).
See [Length caps](#length-caps-verified-not-changed) for why `email` was left at 254.

---

### 4. Missing fields

```sh
curl -sS -X POST "$U" -H 'Content-Type: application/json' -d '{}'
```

**Expected.** `400` naming the first missing field, with a safe `userMessage`, and
nothing filed.

| | Result |
| --- | --- |
| **Before** | `400 {"error":"validation: name missing","userMessage":"Please include your name."}` ✅ |
| **After** | Unchanged. ✅ Assertion suite covers `name`, `email`, `suggestion`, `path` individually, plus non-string types (`123`, `null`, `{}`, `[]`, `true`) collapsing to *missing* rather than throwing. |

---

### 5. Malformed email

```sh
curl -sS -X POST "$U" -H 'Content-Type: application/json' \
 -d '{"name":"Abuse Tester","email":"not-an-email","suggestion":"x","path":"chapters/chapter-03.md"}'
```

**Expected.** `400`, nothing filed.

| | Result |
| --- | --- |
| **Before** | `400 validation: email malformed` ✅ |
| **After** | Unchanged ✅ |

The regex is deliberately loose, and that turned out to matter — see
[test 8](#8-markdown-injection).

---

### 6. Wrong `Content-Type` — the one that mattered

`text/plain`, `application/x-www-form-urlencoded` and `multipart/form-data` are CORS
**simple requests**: a browser will POST them cross-origin with **no preflight at
all**. Probes used a deliberately invalid payload so a permissive handler would still
file nothing.

```sh
curl -sS -X POST "$U" -H 'Content-Type: text/plain' \
 -d '{"name":"CT Probe","email":"bad-email","suggestion":"x","path":"chapters/chapter-03.md"}'

curl -sS -X POST "$U" -H 'Content-Type: application/x-www-form-urlencoded' \
 --data-urlencode 'name=CT Probe' --data-urlencode 'email=bad-email' \
 --data-urlencode 'suggestion=x' --data-urlencode 'path=chapters/chapter-03.md'
```

**Expected.** `415 { error, userMessage }`. Anything that is not
`application/json` must be refused **before the body is parsed**.

| | Result |
| --- | --- |
| **Before** | ❌ **GAP.** Both returned `400 validation: email malformed` — i.e. the body was fully parsed and reached field validation. Vercel decodes form encodings into an object, so a form-shaped POST was a first-class request. No content-type gate existed. |
| **After** | ✅ `415 {"error":"unsupported content-type","userMessage":"Something went wrong sending your suggestion. Please try again."}` for `text/plain`, `application/x-www-form-urlencoded`, `multipart/form-data`, **and** a request with no `Content-Type` at all. `application/json; charset=utf-8` still accepted. |

**Honest scoping of the risk.** This is defence in depth, not a live account
takeover: browsers do send `Origin` on cross-origin form POSTs, so the existing
origin check already refused the browser-driven version of this attack, and a
non-browser client could always send `application/json` anyway. What the gate buys is
that the *only* way to reach the handler is now a request a browser must preflight —
so the origin allowlist is enforced by the browser before the request is ever sent,
instead of resting solely on a header the handler chooses to trust.

---

### 7. Path traversal

```sh
curl -sS -X POST "$U" -H 'Content-Type: application/json' \
 -d '{"name":"Trav","email":"t@example.com","suggestion":"x","path":"../../../../etc/passwd.md"}'
```

**Expected.** `400`, nothing filed, and no traversal reflected into the file link.

| | Result |
| --- | --- |
| **Before** | `400 validation: path rejected` ✅ |
| **After** | Unchanged ✅ |

The suite additionally asserts rejection of `..%2F..%2Fsecret.md`, `/etc/passwd.md`,
`chapters//../secret.md`, `https://evil.example/x.md`, a non-`.md` extension,
`chapters/<script>.md`, and an embedded newline. `path` is the one field that is
allow-listed by regex rather than escaped, and it holds.

---

### 8. Markdown injection

The important one. Payload carrying fence-closers, `@mentions`, headings and an
image link in **every** user-controlled field.

**Expected.** No user content can escape its fence, become a heading, become a link
or an image, or ping a GitHub user.

| Vector | Before | After |
| --- | --- | --- |
| ` ``` ` closers in `suggestion` | ✅ contained — fence already grows to 4 backticks | ✅ contained |
| ```` ```` ```` closers in `reasoning` | ✅ contained — independent 5-backtick fence | ✅ contained |
| `@mention` inside a fence | ✅ not linkified | ✅ not linkified |
| **`@mention` in `name`** | ❌ **rendered `<a class="user-mention" href="…/octocat">` — a real ping** | ✅ inert inside a code span |
| **newline + `# heading` in `name`** | ❌ **rendered `<h1>INJECTED HEADING</h1>`** | ✅ folded to one line, inert |
| **`![img](…)` in `name`** | ❌ **rendered `<img src="camo.githubusercontent.com/…">`** — a live fetch of the attacker's URL through GitHub's proxy | ✅ inert |
| **markdown link in the masked email** | ❌ **rendered `<a href="https://evil.example">click-me</a>`** | ✅ inert |
| unbalanced `)` in `path` | ⚠️ truncated the file link destination early (cosmetic only — `PATH_RE` blocks `[`, `!` and `@`, so no markup could be injected) | ✅ parens percent-encoded |

**How "before" was proven without filing issues.** The real handler was run
in-process with `fetch` stubbed, capturing the exact issue body it would have sent;
that body was then rendered by **GitHub's own renderer** via
`POST https://api.github.com/markdown` (`mode: gfm`, repo context), which creates
nothing. That is what produced the `user-mention`, `camo` and `<h1>` evidence above.

The root cause was that the fenced blocks were handled correctly all along, while
the attribution line interpolated `name` and the masked email straight into live
markdown:

```js
`**Submitted by:** ${name} (${maskEmail(email)})`
```

`asString()` trims but does not strip *interior* newlines, so `name` could open new
markdown block context entirely.

The email vector is the subtler half: `EMAIL_RE`'s domain class is `[^\s@.]`, which
permits `[`, `]`, `(` and `)`. So `a@[click-me](https://evil.example)x.com` is a
"valid" address whose *masked* form is a working link — masking the local part does
nothing when the domain is the payload.

**Live confirmation** — the one permitted issue, [#2](https://github.com/textbookproject2026-alt/textbook/issues/2),
fetched back through the API with `Accept: application/vnd.github.html+json`:

| Check on rendered `body_html` | Count | Expected |
| --- | --- | --- |
| `user-mention` links | 0 | 0 |
| `<img>` tags | 0 | 0 |
| `camo.githubusercontent` loads | 0 | 0 |
| `<h1>`/`<h2>` from user content | 0 | 0 |
| `href` targets | 1 — only the legitimate `File:` link | 1 |

The mention target was `@textbookproject2026-alt`, a real account (so it genuinely
linkifies, giving the test teeth) that belongs to the project itself — a regression
could therefore only ever notify the project, never a third party.

---

## Patches applied

All in `api/suggest-edit.js`; the request/response contract is unchanged except for
the added `415`.

1. **`inlineCode()` neutralises the attribution line.** `name` and the masked email
   are wrapped in a code span whose backtick delimiter outgrows the longest run
   inside the content, space-padded when the content would otherwise sit flush
   against a delimiter. Interior whitespace is folded to single spaces first,
   because a code span cannot cross a line break — without that, a newline in `name`
   closes the span and drops the remainder back into live markdown, which is exactly
   the original bug. GitHub does not linkify mentions, links or images inside a code
   span, so an `@mention` is displayed to the editor but notifies nobody.
2. **`Content-Type` gate → `415`** with `{ error, userMessage }`, placed after the
   method guard and **before** body parsing.
3. **Parens percent-encoded in `fileUrl()`**, so an unbalanced `)` cannot truncate
   the markdown link destination.
4. **Stopped replaying caller input in `error`** — the `403`, `405` and `429`
   responses echoed the supplied `Origin`, the method, and the caller's IP. Those
   now go to the log and the response carries a fixed string.

### Length caps (verified, not changed)

`name ≤ 200` and `suggestion`/`reasoning ≤ 5000` were already enforced and correct.
`email` is capped at **254**, not 320: 254 is the largest address that fits RFC 5321's
256-octet reverse-path including the angle brackets, so it is the stricter and more
defensible bound while still satisfying "≤ 320". Raising it to 320 would have
*loosened* validation for no benefit, so it was left alone.

### Not the limiter

The limiter already ran before validation. This was verified live rather than
assumed — an invalid payload returned `429` — so no reordering was needed.

---

## Assertion suite

`npm test` → `node --test test/assertions.test.mjs`. There was no suite before this
pass; there are now **27 cases, all green**. They drive the real exported handler
through `test/harness.mjs`, which stubs `globalThis.fetch`, so the suite exercises
the shipped code path (content-type gate → honeypot → limiter → validation → issue
body) and **never contacts GitHub**. Each case asserts `issue === null` wherever
nothing should be filed, and every case gets a unique client IP so the module-global
limiter cannot bleed between tests.

```
✔ rejects CORS "simple request" content types with 415 and files nothing
✔ rejects a missing Content-Type with 415
✔ accepts application/json with parameters and odd casing
✔ the content-type gate does not break the OPTIONS preflight
✔ honeypot returns a 201-shaped success but files nothing
✔ limiter runs before validation: invalid payloads still consume budget
✔ a limited caller is refused before any issue can be filed
✔ the 429 does not echo the caller IP back
✔ an @mention in the name cannot ping: it is confined to a code span
✔ newlines in the name cannot inject headings or extra markdown lines
✔ markdown in the email domain cannot become a link
✔ a name made only of backticks still produces a well-formed code span
✔ suggestion fence outgrows any backtick run in the content
✔ reasoning gets its own independently sized fence
✔ an unbalanced paren in the path cannot truncate the file link
✔ missing required fields are rejected and file nothing
✔ reasoning is genuinely optional
✔ malformed emails are rejected
✔ length caps hold for every free-text field
✔ a 1MB field is rejected by the caps, not by crashing
✔ path traversal and URL-ish paths are refused
✔ non-string field types are coerced to missing, not crashed on
✔ a mismatched Origin is refused without echoing it back
✔ the allowed origin still gets through
✔ non-POST methods are refused without echoing the verb
✔ unparseable JSON is a 400, not a stack trace
✔ no response ever leaks the bot token or a stack trace
ℹ tests 27  ℹ pass 27  ℹ fail 0
```

---

## Live issues created

**One**, as permitted.

| Issue | Purpose | State |
| --- | --- | --- |
| [#2 — Suggested edit: chapters/chapter-03.md](https://github.com/textbookproject2026-alt/textbook/issues/2) | Fence-escape / markdown-injection rendering check against the patched deployment | **Open — safe to close.** Its suggestion block opens with `ABUSE-TEST — please close`. |

Repo went from 1 issue to 2. Every other test in this document filed nothing, verified
by polling the public issues API rather than by trusting the endpoint's own response.

⚠️ One deviation worth stating plainly: the brief asked that the issue **body** start
with `ABUSE-TEST — please close`. The body's first line is generated by the server
(`**File:** …`) and is not reachable from any input, so the marker leads the
`suggestion` field instead — the first user-controlled content in the issue. Making
the literal first line match would have required changing the handler for the benefit
of a test.

---

## Observed but not patched

**Honeypot submissions are unmetered.** The honeypot returns `201` *before* the
limiter, so a bot that fills `website` can send unlimited requests. Left as-is: it
files nothing, and the ordering is deliberate — moving the check after the limiter
would let a bot distinguish "caught" from "throttled" and tune its way out of the
trap. The cost is wasted compute, not data.

**`website` only trips on a string.** `{"website": 123}` does not trigger the
honeypot, because `asString()` returns `''` for non-strings. Such a bot simply falls
through to normal validation, so there is no bypass — but the honeypot is narrower
than it looks. Not worth a behaviour change.

**The limiter is still per-instance and still resets on deploy.** This pass exploited
that repeatedly (every push handed back a fresh five-token budget) and confirmed via
`X-Forwarded-For` probes that the *identity* is sound while the *store* is not.
Out of scope to fix here — it needs the shared KV/Redis store the source comment
already flags as Day 28 work. Recording it as measured fact rather than a hypothetical.

**No total request-size guard.** A 2 MB body is parsed into memory before the length
caps reject it. Vercel caps request bodies at 4.5 MB, so the blast radius is bounded
by the platform; adding a second limit in the handler would duplicate that for little
gain.

**A missing `Origin` is still allowed.** Unchanged deliberately — it is documented
behaviour that server-to-server callers are permitted, and CORS is not a security
boundary. The `415` gate above is what meaningfully narrows this.

**`maskEmail` reveals the domain in full.** By design (editors need to judge
plausibility), and now inert as markup. Worth noting it is not anonymisation.
