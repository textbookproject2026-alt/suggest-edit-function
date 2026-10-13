-- The Worker's cron (worker/index.mjs scheduled()): its last run per schedule, for
-- /api/health. In D1, not KV: every five minutes is 288 writes a day, and free-plan KV
-- allows 1,000 a day for the whole account.
CREATE TABLE IF NOT EXISTS cron_runs (
  cron TEXT PRIMARY KEY,  -- the schedule, as in wrangler.toml
  started INTEGER NOT NULL,
  finished INTEGER NOT NULL,
  detail TEXT             -- "waiting=0 refresh=no", or the error
);
