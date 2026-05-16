## Run-id extraction (added v0.7.91)

When fetching the CI run-id after `git push origin <tag>`, DO NOT use `gh run list | awk '{print $7}'`. The columns are space-separated and the commit title can contain spaces; awk picked up "QA" from "chore: bump (QA waterfall)" on 2026-05-16 and caused `gh run view` to 404 on the bogus id. Use the JSON form:

```bash
RUN_ID=$(gh run list --limit 1 --json databaseId --jq '.[0].databaseId')
```

## Live-exercise gate (mandatory before declaring done, added v0.7.91)

CI green is "shipped to GitHub". It is NOT "the running daemon is fixed". Required after `gh run view --json conclusion` returns `"success"`:

1. `cat ~/.kongcode/cache/daemon.pid` — confirm `daemonVersion` equals the version just shipped. If it does not, the running daemon is still on old code.
2. Kill the running daemon: `kill <pid>`. Poll until `ps -p <pid>` returns no row.
3. Trigger respawn via daemon-socket handshake (the next MCP call from any attached mcp-client triggers `ensureDaemon` to spawn a fresh daemon from updated `dist/`). Confirm the new `daemon.pid` `daemonVersion` matches the release.
4. Wait 2 minutes wall clock for natural hook traffic.
5. `tail -n +<baseline+1> ~/.kongcode/cache/daemon.log` and grep for the EXACT bug signature the release was supposed to fix. The count MUST be 0 in the post-respawn window.

Only after step 5 returns 0 may you say "shipped + verified". CI green alone is "shipped but the running daemon may still be on old code".

## Pre-push lint coverage (as of v0.7.91)

Before `git push`, `npm test` MUST be green locally. The lint suite that runs in the test gate:

- `test/lint-auto-seal-invariant.test.ts` — graph-write hygiene (no hand-wired `store.relate()` outside the canonical write path).
- `test/lint-mcp-tool-wiring-invariant.test.ts` — 5-surface tool wiring (mcp-server.ts, tool-defs.ts twice, ipc-types.ts, daemon/index.ts all match).
- `test/lint-cross-platform-paths.test.ts` — no POSIX-only `startsWith("/")` or LF-only `.split("\n")` on file content.
- `test/lint-init-order.test.ts` — `startDrainScheduler` called before `await store.initialize()` in `daemon/index.ts`.
- `test/lint-spawn-env-completeness.test.ts` — every `spawn(claudeBin, ...)` passes `--plugin-dir`; `buildDrainEnv` sets `CLAUDE_PLUGIN_ROOT` explicitly.

If a new bug class costs the project a same-day follow-up commit, the response is "add a lint test that would have caught it" — not "be more careful next time."
