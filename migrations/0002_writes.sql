-- Writes (worker/writes.mjs): one row per key, so a write sent twice runs once, and the
-- request a page queued for the fallback (scripts/fallback.mjs) until it has run.
CREATE TABLE IF NOT EXISTS writes (
  key TEXT PRIMARY KEY,   -- the page's write_key
  route TEXT NOT NULL,    -- "/api/propose-edit", …
  state TEXT NOT NULL,    -- running | queued | fallback | done | failed
  at INTEGER NOT NULL,    -- ms of the last change of state
  request TEXT,           -- the queued request (JSON), until the fallback has run it
  status INTEGER,         -- the answer: HTTP status
  type TEXT,              -- the answer: content type
  result TEXT             -- the answer: body
);
CREATE INDEX IF NOT EXISTS writes_state ON writes (state, at);

-- Every write that failed on the Worker and every fallback, for /api/health.
CREATE TABLE IF NOT EXISTS write_events (
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,     -- inline-failed | queued | dispatch-failed | fallback-done | fallback-failed
  route TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS write_events_at ON write_events (at);
