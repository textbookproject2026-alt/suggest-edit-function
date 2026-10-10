# Working in this repository

Notes for Claude Code (and anyone automating work here).

## Background processes

- **Every polling loop has a deadline.** Never an open-ended `until …; do sleep N; done` against a live service: cap it (a fixed number of tries, or a `$SECONDS` deadline) and say what happened when it runs out.
- **Wait for "this version or newer", never one exact value.** A loop that waits for one exact sha, tag or header can wait forever once something newer has replaced it. Compare against "at least", or wait for any change.
- **Stop what you started.** Any background process a task starts (a poll, a watcher, a dev or static server, a test runner, a browser) is stopped before that task is reported done.
- **At the end of a session, look for leftovers and stop them**: `ps -axo pid,lstart,command | grep -E "until |sleep [0-9]|serve|wrangler|vitest|playwright|node "`, and stop anything this or an earlier session left running.

Why: on 9–10 October 2026 a forgotten loop asked the suggest-edit function for one exact registry version every 20 seconds for 23 hours (about 4,600 requests). The registry had moved on, so it never matched, and the host's firewall started challenging the maintainer's IP.
