-- Rate-limit keys hold no IP address (lib/common.mjs hashKey): HMAC-SHA256 of the IP with
-- a random salt per UTC day. One row per day; the five-minute jobs delete older days, so
-- once a day is over its keys can't be linked to an address.
CREATE TABLE IF NOT EXISTS salts (
  day INTEGER PRIMARY KEY, -- floor(ms / 86400000), UTC
  salt TEXT NOT NULL       -- 32 random bytes, hex
);

-- IPs stored before hashed keys (14 Oct 2026): every rate-limit row (only counts; the
-- windows are an hour), and the IP inside any queued request.
DELETE FROM hits;
UPDATE writes SET request = json_remove(request, '$.headers."cf-connecting-ip"') WHERE request IS NOT NULL;
