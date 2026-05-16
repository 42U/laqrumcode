# pre-flight-done-check

Procedural checklist invoked BEFORE saying "shipped", "done", "verified", "fixed", or any equivalent. Catches the recurring "I declared done after tests passed but the bug was still firing in production" failure mode that produced 6 same-day follow-up commits on 2026-05-16.

## When to invoke

- Any time you are about to use the words "shipped", "verified done", "fixed", "verified", or "complete" in a user-facing reply.
- Especially when the work was a bug fix.
- Especially when an agent you spawned reports VERIFIED_FIXED — agents report intent, you verify facts.

## Checklist (every step is gating, in order)

1. **Code change applied + dist rebuilt.** Run `npm run build`; confirm the build line printed clean. `dist/` mtime should be newer than the source file mtime.

2. **Tests green locally.** `npm test` returns 0 with no failure markers. Quote the final `Tests N passed (N)` line.

3. **Lint coverage exists for this regression.** If the fix is in `src/daemon/`, ask: would `lint-init-order` / `lint-spawn-env-completeness` / `lint-cross-platform-paths` catch this exact bug class if it came back? If not, add a lint test BEFORE shipping. "Be more careful next time" is not a gate.

4. **CI green via JSON.** Push, then `gh run watch <id> --exit-status` AND `gh run view <id> --json conclusion,status,name`. The JSON must show `"conclusion":"success"`. Quote it verbatim. Do NOT use `gh run watch | tail` — that captures tail's exit code, not gh's.

5. **Daemon restarted with new code.** `cat ~/.kongcode/cache/daemon.pid` — its `daemonVersion` field must equal the version just shipped. If not, kill the daemon to force respawn from new `dist/`.

6. **Live grep on the original bug signature returns 0.** Tail the daemon log post-respawn for at least 2 minutes of real traffic, grep for the EXACT log line the fix targeted. Count MUST be 0.

7. **Quote all receipts in the user-facing reply.** Build line, test count, JSON conclusion, `daemon.pid` contents, grep counts. Real strings from this turn's tool output, not paraphrased.

## Anti-patterns

- "Tests passed locally, shipping." — that is step 2 of 7. Six more steps remain.
- "Agent reported VERIFIED_FIXED." — verify the diff and the live log yourself. The agent's summary describes intent.
- "CI green, declaring done." — without daemon restart + live grep, you do not know if the running daemon is still on old code.
- "Documented as Wave N+1 follow-up." — if the verifier reported any remaining instance of the original symptom, the loop is not done. See memory:lqp5svv2bzzjqupzd2tj (importance 10).

## What this skill does NOT do

- Does not ship the work for you. Follow `kongcode-release` for the bump / commit / push / verify chain.
- Does not catch bugs the fix did not address. If the live grep returns 0 but a different symptom appears, that is a different bug, not a verification failure for the current one.
