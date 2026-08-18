/**
 * Abuse-test assertion suite for POST /api/suggest-edit.
 *
 * Every case here corresponds to a row in TESTING.md. Run with `npm test`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { call, VALID, freshIp } from './harness.mjs';

// ---------------------------------------------------------------------------
// Content-Type gate (415)
// ---------------------------------------------------------------------------

test('rejects CORS "simple request" content types with 415 and files nothing', async (t) => {
  // These three are exactly the types a browser will POST cross-origin with no
  // preflight, so they must never reach the body parser.
  for (const ct of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
    const r = await call({ contentType: ct, body: { ...VALID } });
    assert.equal(r.status, 415, `${ct} should be 415`);
    assert.equal(r.payload.error, 'unsupported content-type');
    assert.ok(r.payload.userMessage, `${ct} should carry a userMessage`);
    assert.equal(r.issue, null, `${ct} must not create an issue`);
  }
});

test('rejects a missing Content-Type with 415', async () => {
  const r = await call({ contentType: null, body: { ...VALID } });
  assert.equal(r.status, 415);
  assert.equal(r.issue, null);
});

test('accepts application/json with parameters and odd casing', async () => {
  for (const ct of ['application/json', 'application/json; charset=utf-8', 'Application/JSON', ' application/json ']) {
    const r = await call({ contentType: ct, body: { ...VALID } });
    assert.equal(r.status, 201, `${ct} should be accepted`);
    assert.ok(r.issue, `${ct} should create an issue`);
  }
});

test('the content-type gate does not break the OPTIONS preflight', async () => {
  const r = await call({ method: 'OPTIONS', contentType: null });
  assert.equal(r.status, 204);
  assert.equal(r.headers['access-control-allow-origin'], 'https://bptext2026.xyz');
});

// ---------------------------------------------------------------------------
// Honeypot
// ---------------------------------------------------------------------------

test('honeypot returns a 201-shaped success but files nothing', async () => {
  const r = await call({ body: { ...VALID, website: 'http://spam.example' } });
  assert.equal(r.status, 201);
  assert.equal(r.payload.issueUrl, 'https://github.com/textbookproject2026-alt/textbook/issues');
  assert.equal(r.issue, null, 'honeypot must not create an issue');
  // A caught bot must not be told it was caught.
  assert.equal(r.payload.error, undefined);
});

// ---------------------------------------------------------------------------
// Rate limiting — must run BEFORE validation
// ---------------------------------------------------------------------------

test('limiter runs before validation: invalid payloads still consume budget', async () => {
  const ip = freshIp();
  const statuses = [];
  for (let i = 0; i < 6; i++) {
    const r = await call({ ip, body: { bogus: 1 } }); // never valid
    statuses.push(r.status);
  }
  assert.deepEqual(statuses, [400, 400, 400, 400, 400, 429],
    'five rejections then a 429 — proves the limiter precedes validation');
});

test('a limited caller is refused before any issue can be filed', async () => {
  const ip = freshIp();
  for (let i = 0; i < 5; i++) await call({ ip, body: { ...VALID } });
  const r = await call({ ip, body: { ...VALID } });
  assert.equal(r.status, 429);
  assert.equal(r.issue, null);
});

test('the 429 does not echo the caller IP back', async () => {
  const ip = freshIp();
  for (let i = 0; i < 5; i++) await call({ ip, body: { bogus: 1 } });
  const r = await call({ ip, body: { bogus: 1 } });
  assert.equal(r.status, 429);
  assert.equal(r.payload.error, 'rate limit exceeded');
  assert.ok(!JSON.stringify(r.payload).includes(ip), 'response must not replay the IP');
});

// ---------------------------------------------------------------------------
// Markdown injection — user content must never escape into live markup
// ---------------------------------------------------------------------------

/** The trailing attribution block, i.e. everything after the `---` rule. */
function attribution(body) {
  const i = body.lastIndexOf('\n---\n');
  assert.ok(i !== -1, 'issue body must contain the attribution rule');
  return body.slice(i + 5);
}

/** The single "**Submitted by:** ..." line, which is where user text meets live markdown. */
function submittedBy(body) {
  const line = attribution(body).split('\n').find((l) => l.startsWith('**Submitted by:**'));
  assert.ok(line, 'attribution must contain a Submitted by line');
  return line;
}

test('an @mention in the name cannot ping: it is confined to a code span', async () => {
  const r = await call({ body: { ...VALID, name: '@octocat' } });
  assert.equal(r.status, 201);
  const line = submittedBy(r.issue.body);
  assert.match(line, /\*\*Submitted by:\*\* `@octocat`/);
  // No bare @mention anywhere outside a code span.
  assert.ok(!/(^|[^`])@octocat/.test(line), 'mention must not sit outside backticks');
});

test('newlines in the name cannot inject headings or extra markdown lines', async () => {
  const r = await call({
    body: { ...VALID, name: 'Ada\n# INJECTED HEADING\n@octocat\n![x](https://evil.example/t.png)' },
  });
  const block = attribution(r.issue.body);
  const lines = block.split('\n').filter((l) => l.length);
  assert.equal(lines.length, 2, 'attribution must stay exactly two rendered lines');
  assert.ok(!block.includes('\n# '), 'no injected heading');
  assert.ok(!/!\[/.test(block.replace(/`[^`]*`/g, '')), 'no image outside a code span');
  assert.match(lines[0], /^\*\*Submitted by:\*\* `[^`]*` \(`[^`]*`\)$/);
});

test('markdown in the email domain cannot become a link', async () => {
  // EMAIL_RE permits [ ] ( ) in the domain, so the masked address must be neutralised too.
  const r = await call({ body: { ...VALID, email: 'a@[click](https:)x.com' } });
  assert.equal(r.status, 201);
  const line = submittedBy(r.issue.body);
  assert.ok(line.includes('[click](https:)'), 'the masked address is still shown to the editor');
  const outsideCode = line.replace(/`[^`]*`/g, '');
  assert.ok(!outsideCode.includes(']('), 'no markdown link may survive outside a code span');
  assert.ok(!outsideCode.includes('['), 'no bracket may survive outside a code span');
});

test('a name made only of backticks still produces a well-formed code span', async () => {
  const r = await call({ body: { ...VALID, name: '``` `` `' } });
  assert.equal(r.status, 201);
  const line = submittedBy(r.issue.body);
  // Delimiter must outgrow the longest internal run (3 -> 4) and be space padded.
  assert.ok(line.startsWith('**Submitted by:** ```` ``` `` ` ````'), `got: ${line}`);
});

test('suggestion fence outgrows any backtick run in the content', async () => {
  const r = await call({ body: { ...VALID, suggestion: 'a\n```\nb\n```\nc' } });
  const body = r.issue.body;
  assert.ok(body.includes('````text\n'), 'four-backtick fence expected');
  // The content survives verbatim inside the fence.
  assert.ok(body.includes('\n```\nb\n```\n'));
});

test('reasoning gets its own independently sized fence', async () => {
  const r = await call({ body: { ...VALID, suggestion: 'plain', reasoning: '````\nnested\n````' } });
  const body = r.issue.body;
  assert.ok(body.includes('```text\nplain\n```'), 'short fence for plain suggestion');
  assert.ok(body.includes('`````text\n'), 'five-backtick fence for the reasoning');
});

test('an unbalanced paren in the path cannot truncate the file link', async () => {
  const r = await call({ body: { ...VALID, path: 'chapters/ch(3).md' } });
  assert.equal(r.status, 201);
  const first = r.issue.body.split('\n')[0];
  const dest = first.slice(first.indexOf('](') + 2, first.lastIndexOf(')'));
  assert.ok(first.includes('%28') && first.includes('%29'), 'parens must be percent-encoded');
  assert.ok(!dest.includes('(') && !dest.includes(')'),
    `link destination must hold no raw parens, got: ${dest}`);
  // The human-readable link text still shows the real filename.
  assert.ok(first.includes('[`chapters/ch(3).md`]'));
});

// ---------------------------------------------------------------------------
// Field validation
// ---------------------------------------------------------------------------

test('missing required fields are rejected and file nothing', async () => {
  for (const field of ['name', 'email', 'suggestion', 'path']) {
    const body = { ...VALID };
    delete body[field];
    const r = await call({ body });
    assert.equal(r.status, 400, `missing ${field}`);
    assert.match(r.payload.error, new RegExp(`^validation: ${field} `));
    assert.ok(r.payload.userMessage);
    assert.equal(r.issue, null);
  }
});

test('reasoning is genuinely optional', async () => {
  const body = { ...VALID };
  delete body.reasoning;
  const r = await call({ body });
  assert.equal(r.status, 201);
  assert.ok(!r.issue.body.includes('### Reasoning'));
});

test('malformed emails are rejected', async () => {
  for (const email of ['not-an-email', 'a@b', 'a b@example.com', '@example.com', 'a@.com', 'a@example.']) {
    const r = await call({ body: { ...VALID, email } });
    assert.equal(r.status, 400, `${email} should be rejected`);
    assert.equal(r.payload.error, 'validation: email malformed');
    assert.equal(r.issue, null);
  }
});

test('length caps hold for every free-text field', async () => {
  const cases = [
    ['name', 201, 'validation: name too long'],
    ['email', 255, 'validation: email malformed'],
    ['suggestion', 5001, 'validation: suggestion too long'],
    ['reasoning', 5001, 'validation: reasoning too long'],
  ];
  for (const [field, len, expected] of cases) {
    const filler = field === 'email' ? `${'a'.repeat(len - 12)}@example.com` : 'a'.repeat(len);
    const r = await call({ body: { ...VALID, [field]: filler } });
    assert.equal(r.status, 400, `oversized ${field}`);
    assert.equal(r.payload.error, expected);
    assert.equal(r.issue, null);
  }
});

test('a 1MB field is rejected by the caps, not by crashing', async () => {
  const r = await call({ body: { ...VALID, name: 'A'.repeat(1024 * 1024) } });
  assert.equal(r.status, 400);
  assert.equal(r.payload.error, 'validation: name too long');
  assert.equal(r.issue, null);

  const r2 = await call({ body: { ...VALID, reasoning: 'B'.repeat(1024 * 1024) } });
  assert.equal(r2.status, 400);
  assert.equal(r2.payload.error, 'validation: reasoning too long');
  assert.equal(r2.issue, null);
});

test('path traversal and URL-ish paths are refused', async () => {
  const paths = [
    '../../../../etc/passwd.md', '..%2F..%2Fsecret.md', '/etc/passwd.md',
    'chapters//../secret.md', 'https://evil.example/x.md', 'chapters/../../x.md',
    'chapters/chapter-03.txt', 'chapters/<script>.md', 'chapters/ch\n03.md',
  ];
  for (const path of paths) {
    const r = await call({ body: { ...VALID, path } });
    assert.equal(r.status, 400, `${path} should be rejected`);
    assert.equal(r.payload.error, 'validation: path rejected');
    assert.equal(r.issue, null);
  }
});

test('non-string field types are coerced to missing, not crashed on', async () => {
  for (const name of [123, null, {}, [], true]) {
    const r = await call({ body: { ...VALID, name } });
    assert.equal(r.status, 400);
    assert.equal(r.payload.error, 'validation: name missing');
  }
});

// ---------------------------------------------------------------------------
// Transport-level guards
// ---------------------------------------------------------------------------

test('a mismatched Origin is refused without echoing it back', async () => {
  const r = await call({ origin: 'https://evil.example', body: { ...VALID } });
  assert.equal(r.status, 403);
  assert.equal(r.payload.error, 'origin not allowed');
  assert.ok(!JSON.stringify(r.payload).includes('evil.example'), 'must not reflect the origin');
  assert.equal(r.issue, null);
});

test('the allowed origin still gets through', async () => {
  const r = await call({ origin: 'https://bptext2026.xyz', body: { ...VALID } });
  assert.equal(r.status, 201);
});

test('non-POST methods are refused without echoing the verb', async () => {
  for (const method of ['GET', 'PUT', 'DELETE', 'TRACE']) {
    const r = await call({ method, contentType: null });
    assert.equal(r.status, 405, method);
    assert.equal(r.payload.error, 'method not allowed');
    assert.equal(r.headers.allow, 'POST, OPTIONS');
  }
});

test('unparseable JSON is a 400, not a stack trace', async () => {
  const r = await call({ raw: '{not json' });
  assert.equal(r.status, 400);
  assert.equal(r.payload.error, 'body was not valid json');
  assert.ok(r.payload.userMessage);
});

test('no response ever leaks the bot token or a stack trace', async () => {
  const probes = [
    { body: { bogus: 1 } },
    { body: { ...VALID, path: '../x.md' } },
    { contentType: 'text/plain', body: { ...VALID } },
    { origin: 'https://evil.example', body: { ...VALID } },
    { raw: '{oops' },
  ];
  for (const p of probes) {
    const r = await call(p);
    const s = JSON.stringify(r.payload ?? {});
    assert.ok(!s.includes(process.env.BOT_TOKEN), 'token must never appear');
    assert.ok(!/\bat \w+.*:\d+:\d+/.test(s), 'no stack frames');
    assert.ok(!s.includes('api.github.com'), 'no upstream internals');
  }
});
