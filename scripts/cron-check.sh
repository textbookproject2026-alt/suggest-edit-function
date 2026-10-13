#!/usr/bin/env bash
# Is the Worker's cron firing? For cron-check.yml: every script's cron triggers (the
# account's count), the deployed c4n-api's handlers and cron strings, and the last
# hours of scheduled invocations from Workers Observability, queried by trigger type.
# Needs CLOUDFLARE_API_TOKEN. HOURS (default 3) is how far back to look.
set -uo pipefail
api() { curl -sS --max-time 30 -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'Content-Type: application/json' "$@"; }
CF=https://api.cloudflare.com/client/v4
account="$(api "$CF/zones?name=confused4now.org" | jq -er '.result[0].account.id')" || { echo "no account"; exit 1; }
A="$CF/accounts/$account"

echo "== cron triggers, every script"
for s in $(api "$A/workers/scripts" | jq -r '.result[].id'); do
  echo "$s: $(api "$A/workers/scripts/$s/schedules" | jq -c '.result.schedules // .errors')"
done

echo "== c4n-api deployments (newest first)"
api "$A/workers/scripts/c4n-api/deployments" | jq -c '.result.deployments[:3][] | {created_on, source, versions, annotations}'

echo "== c4n-api deployed code: handlers and cron strings"
api "$A/workers/scripts/c4n-api/settings" | jq -c '{handlers: .result.handlers, usage_model: .result.usage_model}' 2>/dev/null
api "$A/workers/scripts/c4n-api/content/v2" -o /tmp/c4n-content
grep -aoE "scheduled\(event, env[^)]*\)|event\.cron === '[^']*'" /tmp/c4n-content | sort | uniq -c

since=$(( ($(date +%s) - ${HOURS:-3} * 3600) * 1000 )); now=$(( $(date +%s) * 1000 ))
q() { # q <script> <filters json> [view]
  api -X POST "$A/workers/observability/telemetry/query" --data "$(jq -nc --arg s "$1" --argjson f "$2" --argjson from "$since" --argjson to "$now" --arg v "${3:-events}" '{
    queryId: "cron-check", view: $v, limit: 100, timeframe: {from: $from, to: $to},
    parameters: {datasets: ["cloudflare-workers"], filterCombination: "and",
      filters: ([{key: "$metadata.service", type: "string", operation: "eq", value: $s}] + $f)}}')"
}
for s in c4n-api build-nudge; do
  echo "== $s: invocations whose trigger is a cron (last ${HOURS:-3} h)"
  q "$s" '[{"key":"$workers.eventType","type":"string","operation":"eq","value":"scheduled"}]' |
    jq -r '(.errors // [] | .[] | "error: \(.message)"), (.result.events.events // [] | .[] | [(.timestamp/1000|todate), .["$workers"].eventType, (.["$workers"].event.cron // .["$workers"].scheduledTime // "-"), .["$workers"].outcome, ("cpu=" + ((.["$workers"].cpuTimeMs // "-")|tostring)), (.["$metadata"].message // "")] | @tsv)'
done
echo "== c4n-api: every event at 18:28–18:30 UTC today"
day=$(date -u +%F); from=$(( $(date -ud "$day 18:28:00" +%s) * 1000 )); to=$(( $(date -ud "$day 18:30:00" +%s) * 1000 ))
api -X POST "$A/workers/observability/telemetry/query" --data "$(jq -nc --argjson from "$from" --argjson to "$to" '{
  queryId: "cron-check-1828", view: "events", limit: 50, timeframe: {from: $from, to: $to},
  parameters: {datasets: ["cloudflare-workers"], filters: [{key: "$metadata.service", type: "string", operation: "eq", value: "c4n-api"}]}}')" |
  jq -c '(.errors // [] | .[]), (.result.events.events // [] | .[] | {t: (.timestamp/1000|todate), w: .["$workers"] | {eventType, event, outcome, scriptVersion, entrypoint}, m: .["$metadata"] | {message, level, trigger, error}})'
