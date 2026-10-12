#!/usr/bin/env bash
# c4n-api's Cloudflare account, KV namespaces and D1 database, for worker.yml and
# measure.yml: finds (or, the first time, creates) each by name, writes their ids into
# wrangler.toml, and appends CLOUDFLARE_ACCOUNT_ID to $GITHUB_ENV (the account is read
# from the zone). Needs CLOUDFLARE_API_TOKEN and WRANGLER (the pinned wrangler@x.y.z).
set -euo pipefail

account="$(curl -fsS --max-time 20 -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  'https://api.cloudflare.com/client/v4/zones?name=confused4now.org' | jq -er '.result[0].account.id')"
echo "CLOUDFLARE_ACCOUNT_ID=$account" >> "$GITHUB_ENV"
export CLOUDFLARE_ACCOUNT_ID="$account"

kv() { npx -y "$WRANGLER" kv namespace list | jq -r --arg t "$1" '.[] | select(.title == $t) | .id'; }
kv_id="$(kv c4n-api-tokens)"
if [ -z "$kv_id" ]; then npx -y "$WRANGLER" kv namespace create c4n-api-tokens > /dev/null; kv_id="$(kv c4n-api-tokens)"; fi
cache_id="$(kv c4n-api-cache)"
if [ -z "$cache_id" ]; then npx -y "$WRANGLER" kv namespace create c4n-api-cache > /dev/null; cache_id="$(kv c4n-api-cache)"; fi
d1() { npx -y "$WRANGLER" d1 list --json | jq -r '.[] | select(.name == "c4n-api") | .uuid'; }
db_id="$(d1)"
if [ -z "$db_id" ]; then npx -y "$WRANGLER" d1 create c4n-api > /dev/null; db_id="$(d1)"; fi
[ -n "$kv_id" ] && [ -n "$cache_id" ] && [ -n "$db_id" ] || { echo "::error::Could not find or create the KV namespaces or the D1 database."; exit 1; }
sed -i "s/\"TOKENS_ID\"/\"$kv_id\"/; s/\"CACHE_ID\"/\"$cache_id\"/; s/\"DB_ID\"/\"$db_id\"/" wrangler.toml
echo "CACHE_ID=$cache_id" >> "$GITHUB_ENV"
echo "KV c4n-api-tokens $kv_id, KV c4n-api-cache $cache_id, D1 c4n-api $db_id"
