-- Rate limits (lib/common.mjs createRateLimiter): one row per limiter, key and window.
CREATE TABLE IF NOT EXISTS hits (
  k TEXT NOT NULL,        -- "<limiter name>:<ip or login>"
  w INTEGER NOT NULL,     -- window number: floor(now / windowMs)
  n INTEGER NOT NULL,     -- hits counted in that window
  until INTEGER NOT NULL, -- ms when the window closes; the daily cron deletes closed ones
  PRIMARY KEY (k, w)
);
CREATE INDEX IF NOT EXISTS hits_until ON hits (until);
