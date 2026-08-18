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

