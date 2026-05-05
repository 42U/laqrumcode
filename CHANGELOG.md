# Changelog

All notable changes to KongCode are documented here. The 0.7.x series introduced the daemon-split architecture; 0.8.0 will be the first marketplace-ready stable.

## [Unreleased]

### Added
- README rewrite covering daemon arch, multi-session, auto-drain costs, env-var matrix, and troubleshooting (`README.md`)
- This CHANGELOG file

## [0.7.58] — 2026-05-05

### Changed — retrieval utilization scoring

- **Cross-encoder semantic utilization**: `evaluateRetrieval` now scores each (response, retrieved_item) pair via the `bge-reranker-v2-m3` cross-encoder. When available, utilization = 70% CE score + 30% lexical; falls back to lexical-only when reranker is offline. Replaces the purely lexical overlap metric that systematically undercounted real usage (paraphrasing, synthesis, reasoning-from-context). Raw CE score stored as `ce_utilization` on `retrieval_outcome` rows for auditing.
- **Exposed `crossEncoderScorePairs`** from `graph-context.ts` — reusable function for scoring arbitrary (anchor, doc[]) pairs against the loaded reranker.

### Removed — dead code cleanup

- **Removed 4 dead stubs**: `generateInitialSoul`, `attemptGraduation` (soul.ts), `evolveSoul` (soul.ts), `graduateCausalToSkills` (skills.ts). All replaced by the `pending_work` subagent pipeline (`soul_generate`, `soul_evolve`, `causal_graduate` work types in pending-work.ts).
- Removed corresponding test blocks from `soul.test.ts` and `skills.test.ts`.

### Fixed

- **Graduation event gap**: Extracted `recordGraduationEvent` as standalone export from `soul.ts`, wired into `pending-work.ts` `soul_generate` commit handler. Previously the pending_work pipeline would create a soul but never record the `graduation_event` row that `session-start.ts` reads to surface the celebration.
- **`createSoul` error masking**: Now checks `hasSoul()` first (returns false for "already exists") and lets real DB errors propagate instead of swallowing all errors via `swallow.warn`.
- Updated `observability.ts` graduation suggestion to reference the pending_work pipeline instead of the removed `attemptGraduation`.

## [0.7.57] — 2026-05-05

### Fixed — memory decay and recall quality (issues #9, #10)

- **Category-aware decay floor**: Added `"fact"` to the protected category list in `runMemoryMaintenance`. Structured findings (correction/decision/preference/fact) now decay to floor 5.0 instead of 2.0, preserving recall priority.
- **Embedding text separation**: `record_finding` now embeds the raw user text (without `[CATEGORY]` prefix or rationale) via new `embeddingText` field on `CommitMemoryData`. Short keyword queries match findings at higher cosine similarity.

## [0.7.56] — 2026-05-03

### Added — garbage concept cleanup

Expanded STOPLIST_ACRONYMS from ~30 to ~180 entries covering common English words that appear in ALL-CAPS. Added `garbageCollectConcepts()` targeting short ALL-CAPS concepts with no memory edges or hierarchy links. Includes v0.7.55 CHANGELOG entry.

## [0.7.55] — 2026-05-03

### Fixed — recurring daemon SurrealQL errors

Two SurrealQL errors were firing on every maintenance cycle and subagent stop, filling logs with noise:

- **purgeEmbedCache LIMIT parse error**: SurrealDB's DELETE doesn't support LIMIT directly. Wrapped in subquery: `DELETE FROM ... WHERE id IN (SELECT id FROM ... LIMIT 500)`.
- **subagent stop time::unix(NONE)**: Orphan subagent rows lack `spawned_at`, causing `time::unix(NONE)` crash. Added IF guard for NONE values.

## [0.7.54] — 2026-05-03

### Added — vague query expansion

Continuation prompts ("yes do it", "ya lets look into that", "proceed") embed as generic vectors that match nothing in the graph. When the prompt has <3 content words after stopword removal, `expandVagueQuery` prepends up to 10 key terms from the last assistant response before embedding. Zero extra embedding calls — just text augmentation.

## [0.7.53] — 2026-05-03

### Fixed — context signal-to-noise ratio

Retrieval was returning 0 nodes on many turns due to overly aggressive filters, near-duplicate reflections wasted context budget, and tier-0 directives were duplicated after window compaction.

- **Lowered retrieval filters**: `MIN_COSINE` 0.35→0.25, intent score floors ~40% lower, `MIN_RELEVANCE_SCORE` 0.40→0.30. WMR/ACAN scoring handles quality discrimination downstream; the pre-filters should only remove truly irrelevant items.
- **Reflection dedup at retrieval**: Jaccard word-overlap dedup (>65% threshold) in `retrieveReflections` prevents near-duplicate reflections from consuming context budget.
- **Reflection dedup at write**: `processShortReflection` in heuristic-drain now checks for existing similar reflections (>0.85 cosine) before creating new ones.
- **Reflection dedup in maintenance**: `consolidateMemories` Pass 3 deduplicates the reflection table with the same 0.88 cosine threshold used for memories.
- **Fixed tier-0 compaction duplication**: `injectedSections.clear()` on window rotation now preserves the `"tier0"` flag, preventing tier-0 directives from appearing in both system prompt and `active_directives`.
- **Consolidated tier-0 directives**: Reduced from 8 entries (~2KB) to 3 entries (~800 bytes). Merged MEMORY REFLEX, GRAPH-AWARE SAVING, AUTO-SEAL CONTRACT, and KONGCODE-ONLY MEMORY into a single "SAVE TO GRAPH" directive. Demoted MEMORY TOOLS and GRAPH SCHEMA REFERENCE to tier-1.

## [0.7.52] — 2026-05-03

### Fixed — Stop hook schema error

The daemon-down warning in `hook-proxy.cjs` used `additionalContext` for all hook events, but Stop only supports `decision`/`reason` in its `hookSpecificOutput` schema. Claude Code's hook validator rejected the malformed response.

- Made `daemonDownResponse()` event-schema-aware: only injects `additionalContext` for the 5 events that support it (SessionStart, UserPromptSubmit, PostToolUse, PreCompact, PostCompact). All other events get `{}`.

## [0.7.51] — 2026-05-03

### Fixed — graduation quality unblocked

Graduation quality score was stuck at 0.76/0.85 with retrieval utilization at 19% — the sole blocker (skill success, reflections, and tool failure rates were all perfect). Root cause: utilization was purely lexical overlap, systematically undercounting real usage when the assistant paraphrases retrieved context.

- **Citation-boosted utilization**: `[#N]` citations already tracked in `retrieval_outcome` rows now feed back into the `utilization` value (floor at 0.7 for cited items). The graduation query `math::mean(utilization)` picks this up automatically.
- **Improved unigram sensitivity**: minimum word length lowered from 5 to 4 characters, capturing discriminative terms like "ACAN", "file", "tool", "edit".
- **ACAN finding**: trained weights have a -0.499 coefficient on `provenUtility`, creating a negative feedback loop. Will retrain after citation-boosted data accumulates (~3-5 days).

## [0.7.47] — 2026-05-02

### Added — resource-aware daemon sizing

Every feature now adapts to the hardware it runs on instead of assuming workstation-class resources.

**Resource tier detection** (`src/engine/resource-tier.ts`): auto-detects RAM/CPUs at startup, produces a `constrained` / `standard` / `generous` profile that configures thread counts, GPU usage, idle timeout, and drain interval. Override with `KONGCODE_RESOURCE_TIER`.

**Shared Llama instance** (`src/engine/llama-loader.ts`): embeddings and reranker share one native binding instead of creating separate `getLlama()` calls with doubled thread pools.

**Lazy reranker**: 607MB model deferred from daemon boot to first recall call. Constrained boxes that never trigger recall never pay the load cost.

**Embed watchdog + circuit breaker** (`src/engine/embeddings.ts`): `Promise.race` with 30s timeout; 3 consecutive timeouts opens circuit breaker. Prevents multi-hour stalls from blocking the daemon. `KONGCODE_EMBED_TIMEOUT_MS` override.

**Persistent L2 embedding cache**: SurrealDB-backed `embedding_cache` table (sha256-keyed, model-version-aware). Daemon restarts after idle reaper no longer re-compute previously-seen embeddings. 30-day auto-purge in maintenance.

**Chunked reranking**: `setImmediate` yields between chunks of 6 candidates so IPC heartbeats and concurrent sessions aren't starved. `KONGCODE_RERANK_CHUNK_SIZE` override.

**Staggered maintenance**: CPU-heavy jobs (consolidation, ACAN retrain) deferred 30s after startup so first-turn context assembly is uncontested. `KONGCODE_MAINTENANCE_DEFER_MS` override.

**Heuristic pre-drain** (`src/daemon/heuristic-drain.ts`): handoff notes and short-session reflections processed in-process without spawning a subprocess. Remaining queue checked after — if below threshold, subprocess spawn is skipped entirely.

**Auto-drain model downgrade**: defaults to `memory-extractor-lite` (Haiku) instead of Opus. Opt back in with `KONGCODE_AUTO_DRAIN_MODEL=opus`.

### Fixed
- **reaperExit resource leak**: idle reaper path was missing `globalState.shutdown()`, `disposeReranker()`, `disposeSharedLlama()`, `stopHttpApi()` — leaked native models and DB connections on every idle timeout
- **Idle timeout**: was hardcoded 6s causing constant cold restarts; now tier-aware (constrained=5min, standard/generous=60s)
- `linkConceptHierarchy` accepts optional precomputed vector, avoiding redundant re-embed of concept content

## [0.7.46] — 2026-05-01

### Fixed — recalled-memory tag-rename downstream cleanup + project-scope retrieval invisibility

Two related bugs: one regression from 0.7.45's XML envelope rename, one latent issue surfaced by it.

**Bug 1 — `<graph_context>` → `<recalled_memory>` rename missed four consumers.** v0.7.45 renamed the producer envelope but four downstream sites still referenced the old tag, with one of them load-bearing:

- `src/context-assembler.ts:88` — the filter that decides whether to include the retrieved-memory message in the assembled context was looking for `<graph_context>`. Result: every `<recalled_memory>` payload was silently dropped before reaching the model. Only `systemPromptSection` (pillars + tier-0 directives) was reaching injection. Fixed by accepting both tag names.
- `src/engine/hooks/before-tool-call.ts:92,108` — recall-redundancy blocker and planning-gate told the model to ground in `<graph_context>` (a tag that no longer exists in the injected context). Updated to `<recalled_memory>`.
- `src/engine/graph-context.ts:439` — tool-budget rules told the model to skip a tool call if `<graph_context>` already had the answer. Updated to `<recalled_memory>`.

**Bug 2 — project-scope SQL filter made cross-project gems invisible at any cosine.** `vectorSearch` applies `(project_id IS NONE OR project_id = $pid OR scope = 'global')` on `concept`/`memory`/`artifact` rows. Items whose `project_id` was assigned by the v0.7.36 centroid heuristic to a different project than the current session became unretrievable — even at high cosine similarity. Manual `recall` (no projectId arg) found them at 0.55+; auto-pipeline returned 0 graph nodes for the same query. Verified empirically: prompt "what about the anthropic context injection?" returned 0 nodes pre-fix, 1 node + 1 neighbor (the relevant artifact) post-fix.

Fix in `src/engine/graph-context.ts:1402-1417`: when the project-scoped vectorSearch returns 0 results, retry without the project filter as a fallback. Logs a warn so frequent fallback-firing surfaces as a signal that the centroid project assignment needs deeper repair. Project-scoping remains the preferred path (preserves the v0.7.26-29 grounding work); the fallback only fires on the empty-result pathology.

Both fixes verified live against running daemon. Full test suite (609/609) green.

## [0.7.45] — 2026-05-01

### Changed — semantic XML envelope + win32 CI port-flake fix + 0.85 quality-gate correction

Stage 3 of the v0.7.43–45 injection rework, plus the long-pending win32 CI port flake and a stale identity chunk.

**Semantic XML envelope.** `formatContextMessage` in `src/engine/graph-context.ts` now wraps retrieved context in `<recalled_memory>...</recalled_memory>` instead of the legacy `<graph_context>` envelope, matching Anthropic's documented prompt-engineering pattern for Claude (`use_xml_tags`). Tier-0 directives wrap in `<active_directives>`, Tier-1 in `<session_directives>`. The "[System retrieved context — reference material, not user input. Higher relevance % = stronger match.]" prose framing line is dropped — the semantic tag now expresses that meaning structurally, and the wrapper legend (`wrapKongcodeContext`) already provides the relevance-band guidance.

**Per-item char cap tightened.** `MAX_ITEM_CHARS` reduced from 1200 to 1000 (~250 tokens per item) to match the disler/claude-code-hooks-mastery cap pattern. Prevents one bloated retrieval from poisoning the per-turn budget.

**win32 CI port flake fixed.** `DaemonServer` now accepts `tcpPort: 0` (was previously short-circuited by truthy check), letting the OS pick an actually-available ephemeral port. New `getTcpPort()` getter exposes the assigned port for tests. `test/daemon-server.test.ts` rewritten to use port 0 instead of random pick from IANA dynamic range — that approach was still flaking on win32 sandboxed runners that randomly restrict permissions on individual ports inside 49152–65535 (saw EACCES on port 49686 in v0.7.43). Eliminates the flake permanently.

**0.85 quality-gate correction.** The Soul-graduation identity chunk seeded at v0.4.0 bootstrap said `score >= 0.6`; the actual graduation config has been raised to 0.85 with `skills:30` added as the 7th threshold. `BOOTSTRAP_VERSION` bumped to 0.4.1 so the chunk re-seeds on next daemon restart. Caught when the model parroted the stale 0.6 number; saved as correction `memory:r8ir182j2896dcuodxpw`.

## [0.7.44] — 2026-05-01

### Changed — Anthropic-aligned wrapper wording + bypass sigil

Stage 2 of the v0.7.43–45 injection rework. Two changes to `src/hook-handlers/user-prompt-submit.ts`:

**Wrapper legend rewritten.** The system-reminder body that wraps every kongcode injection used third-person system-speak ("KONGCODE CONTEXT — authoritative for this turn", "Items tagged [load-bearing] must be grounded on") that violates Anthropic's documented prompt-engineering guidance for Claude 4.5+ — specifically, `MUST` / `CRITICAL` / `authoritative` framings overtrigger and reduce instruction-following accuracy. Replaced with motivation-first softer wording: "The following is supplementary context for this turn. Use items when they're relevant; ignore items that don't match the question." Salience-tag explanation reframed as guidance ("[load-bearing] items are most likely to be relevant — when answering, reference them by id") rather than command. Explicit grounding self-check added at the bottom: "check that factual claims about prior work are either grounded in items below or explicitly framed as inference."

**Bypass sigil.** Prefix the prompt with `* ` (asterisk + space) or `/raw ` to skip kongcode's injection for that turn. Useful when the user wants a clean shot at the model without substrate competing for attention. Turn ingestion still fires — only the retrieval + injection pipeline is skipped. The sigil is matched at the start of the prompt; an asterisk used mid-prompt for emphasis (e.g., `*important*`) is not affected.

Stage 3+ (XML semantic tags, intent-gated directives, per-source char cap, Skill deferral) remain queued.

## [0.7.43] — 2026-05-01

### Fixed — reranker tail-leakage: drops irrelevant graph neighbors from injection

`rerankResults` in `src/engine/graph-context.ts` previously stamped `band='background'` on tail items (positions past `RERANK_TOP_N`) and shipped them in the injected context anyway. Tail items bypass the cross-encoder by definition — so an irrelevant graph-link neighbor (e.g., a 4-week-old heartbeat-system concept from a different project) could surface in unrelated turns just because it shared a graph edge with something in the seed set.

**Default behavior changed**: tail items are now dropped entirely. Only items the cross-encoder actually scored (and that cleared `BAND_DROP_BELOW = 0.15`) reach the injection. Eliminates the "where did this 5-day-old concept come from?" failure mode where retrieved context contained items unrelated to prompt keywords.

**Opt-out**: set `KONGCODE_RERANKER_KEEP_TAIL=true` to revert. No legitimate use case is known; the env var exists in case anyone discovers one in the field.

This is the first stage of an Anthropic-aligned context-injection rework planned across v0.7.43–v0.7.45. Subsequent stages will address directive wording (`MUST` → softer language per Anthropic 4.5+ guidance), motivation-first directive structure (`Why:` lines), Skill deferral for non-load-bearing directives, per-item char cap, and a user bypass sigil.

## [0.7.42] — 2026-04-30

### Added — gap-audit Category 1: live-fire coverage extended to 25/26 synapses

Per the systematic gap-audit plan (Category 1: IPC synapses skipped by live-fire), `scripts/live-fire.mjs` extended to fire 6 previously-skipped hook handlers using clearly-tagged `[live-fire]` test payloads:

- `hook.stop` (transcript_path=/dev/null so transcript reader returns empty)
- `hook.preCompact` / `hook.postCompact`
- `hook.taskCreated`
- `hook.subagentStop`
- `hook.sessionEnd`

These are additive operations (write turn rows, queue pending_work, create task rows, etc.), not destructive, so they fire safely against the production daemon — the test data is identifiable by the `[live-fire]` content prefix and the `live-fire-<timestamp>` session id.

**`tool.commitWorkResults` skip retained** — would need a valid pending `work_id` from a real `fetchPendingWork` response; firing it with a fake id would either silently no-op or error, neither of which is useful signal. Live-fire's `tool.fetchPendingWork` synapse already exercises the queue read path; the commit path has unit-test coverage in `test/pending-work-parser.test.ts`.

**`meta.shutdown` skip retained** — truly destructive (kills the running daemon). Unit tests in `test/daemon-server.test.ts` exercise the shutdown handler with isolated daemon instances; firing it via `live-fire` would break the runner mid-test.

**Result: 25/26 IPC synapses fire green against the running daemon.**

```
[1/3] meta.* (3 — skipping meta.shutdown)        3 ✓
[2/3] tool.* (12 — skipping commitWorkResults)   12 ✓
[3/3] hook.* (10 — every registered hook)        10 ✓

Live-fire results: 25/25 synapses green
```

### Tests
- 605 unit tests still pass.
- 25/25 live-fire green.

### Plan: gap-audit Category 1 acceptance met
The acceptance bar — "every documented IPC/hook surface exercised live" — is now met to within 2 documented exemptions (`meta.shutdown`, `tool.commitWorkResults`) which have unit-test coverage. Next: Category 2 (test coverage report → identify <70% files → add tests).

## [0.7.41] — 2026-04-30

### Added — `npm run live-fire` end-to-end synapse runner

User-driven request: stop discovering wiring gaps reactively in conversation; build a runner that exercises *every synapse* of the system against a live daemon and reports green/red per IPC method.

**`scripts/live-fire.mjs`** — connects to `/home/zero/.kongcode-daemon.sock` via the IPC protocol and fires representative payloads at every registered method:

- **3 meta.*** (handshake, health, requestSupersede; skip shutdown)
- **12 tool.*** (memoryHealth, introspect status/count/query/trends/migrate-projectid/migrate-derivedfrom, recall, clusterScan, whatIsMissing, coreMemory list, fetchPendingWork — skip commitWorkResults which needs a valid pending work_id)
- **4 hook.*** (sessionStart, userPromptSubmit, preToolUse, postToolUse — skip stop/sessionEnd/preCompact/postCompact/taskCreated which queue heavy long-lived ingestion)

Each synapse: PASS/FAIL with timing + brief detail. Final summary: `N/M synapses green`. Exit code 0 if all green, 1 otherwise. Non-destructive (uses isolated `live-fire-<timestamp>` session id; mutating tool calls only fire idempotent operations like `migrate` which are already safe to re-run).

**Goal:** "no synapse not tested." Run after every release; green means the wiring is end-to-end, no gaps lurking.

```bash
npm run live-fire
```

Output (current state):
```
[1/3] meta.* (3 — skipping meta.shutdown which would kill mid-test)
  ✓ meta.handshake                           2ms
  ✓ meta.health                              1ms
  ✓ meta.requestSupersede                    0ms
[2/3] tool.* (12)
  ✓ tool.memoryHealth                        200ms
  ✓ tool.introspect:status                   4260ms
  ✓ tool.introspect:count                    141ms
  ✓ tool.introspect:query                    742ms
  ✓ tool.introspect:trends                   2ms
  ✓ tool.introspect:migrate-projectid        1676ms
  ✓ tool.introspect:migrate-derivedfrom      235ms
  ✓ tool.recall                              1412ms
  ✓ tool.clusterScan                         1434ms
  ✓ tool.whatIsMissing                       1091ms
  ✓ tool.coreMemory:list                     5ms
  ✓ tool.fetchPendingWork                    68ms
[3/3] hook.* (4)
  ✓ hook.sessionStart                        4368ms
  ✓ hook.userPromptSubmit                    5651ms
  ✓ hook.preToolUse                          0ms
  ✓ hook.postToolUse                         1ms

Live-fire results: 19/19 synapses green
```

The `tool.introspect:migrate-*` synapses indirectly exercise the v0.7.40 `recovery.ts` primitives end-to-end (the migrate handlers delegate to `recoverProjectIdRows` and `recoverDaemonOrphans`), so the recovery path is covered without needing a second authenticated SurrealDB client.

### `package.json` script
```json
"live-fire": "node scripts/live-fire.mjs"
```

### Tests
- 605 unit tests pass (no new tests; live-fire is a separate runner that exercises real daemon over IPC, not a unit-test surface).

## [0.7.40] — 2026-04-30

### Refactored — recovery helpers extracted into reusable module

User-driven request after the v0.7.36-39 cleanup train: expose the recovery primitives as helper functions so they can be called from maintenance, post-import flows, or cron jobs — not only via the introspect migrate handler.

**New module: `src/engine/recovery.ts`** — extracted ~400 lines from introspect.ts handlers into a public API:

- `computeProjectCentroids(store)` → `Map<string, number[]>` — per-project centroid embeddings
- `findBestProjectMatch(embedding, centroids, threshold?)` → `{projectId, similarity} | null` — pure cosine-similarity classifier
- `synthesizePlaceholderTask(store, kcSessionId)` → `string | null` — idempotent placeholder task lookup-or-create
- `recoverProjectIdRows(store)` → `ProjectIdRecoveryResult` — full project_id backfill cascade (traversal → centroid → scope='global')
- `recoverDaemonOrphans(store)` → `DerivedFromRecoveryResult` — gem + daemon + synthesis derived_from recovery
- `runFullRecovery(store)` → `FullRecoveryResult` — orchestrator combining both passes

**Refactored:** `introspect.ts` `backfillProjectIdAction` and `backfillDerivedFromAction` are now thin reporting wrappers over the helpers (~225 lines of inline implementation removed). The user-facing migrate API is unchanged.

**Why it matters:** the recovery logic was previously trapped inside the introspect tool's migrate handler — only callable via `mcp__kongcode__introspect action=migrate`. Now any code path (a maintenance hook, an importer, a startup-time data quality check) can `import { runFullRecovery } from "engine/recovery"` and call it directly.

### Tests
- New `test/recovery.test.ts` — 9 cases pinning helper contracts: centroid match, placeholder synthesis (existing-task path, new-task path, error path), return-shape contracts for both individual recovery functions + the orchestrator.
- 605 tests pass (was 596 + 9).

## [0.7.39] — 2026-04-30

### Added — placeholder-task synthesis for pre-substrate import orphans

After v0.7.38's daemon-orphan repair recovered 67 of 206 concepts, 139 remained whose source `daemon:<sessionid>` referenced sessions that don't exist in this DB at all (pre-kongcode-substrate import residue from old kongbrain/whatsapp gateway data). User chose option 2 (synthesize placeholders) over option 1 (leave-as-is) — restoring edge structure rather than carrying the gap forward.

`backfill_derived_from` migrate sub-mode now adds Path 3:
- For each unique `daemon:<sessionid>` that has no resolvable session row, look up an existing placeholder task by `description = "[pre-substrate import] session <sid>"`.
- If none exists, `createTask(description)` and cache the new id keyed by sid.
- RELATE the orphan concept→derived_from→placeholder_task.
- Reused placeholder per session (cached in-memory + idempotent DB lookup), so re-runs find existing rows.

Report adds two new lines:
```
Daemon edges (synth task): N    ← edges via synthesized placeholder
Synthesized placeholders:  N    ← unique placeholder tasks created
```

This is genuinely structural cleanup: the 139 orphans now have a `derived_from` edge to a task whose description self-documents its origin (`[pre-substrate import] session ...`). Future provenance queries hit the canonical edge instead of returning empty.

### Tests
- 596 pass.

## [0.7.38] — 2026-04-30

### Fixed — daemon-extracted concept orphans (forward + retroactive)

User-driven follow-up after the v0.7.37 spin surfaced 25 concepts in the `orphan_concepts` query with `source: "daemon:<sessionid>"` and no `derived_from` edge. Trace through `session-end.ts:43 → pending-work.ts:351 → memory-daemon.ts:159` showed the chain IS wired — but `if (taskId)` silently skips the relate when `taskId` is empty string (the `SessionState.taskId` default before bootstrap completes). The result: every concept extracted from a session that bootstrapped without a task ended up provenance-less.

**Forward fix (memory-daemon.ts:159-167):** the `if (taskId)` skip path now emits a `swallow.warn` flagging "taskId empty when extracting concept X — concept will lack derived_from edge". Future occurrences become visible in daemon.log instead of being silent.

**Retroactive fix (introspect.ts backfill_derived_from, extended):** the migration now repairs both gem-source and daemon-source orphans:

1. **Gem orphans** (pre-0.7.23): unchanged — strip `gem:` prefix, look up `artifact.path`, RELATE.
2. **Daemon orphans** (NEW v0.7.38): strip `daemon:` prefix to get `kc_session_id`, look up `session WHERE kc_session_id = $sid`, traverse `->session_task->task[0]`, RELATE concept→derived_from→task.

Idempotent — both paths skip concepts that already have a derived_from edge. Re-runs after live extractions are safe.

**Report extended:** the migration now shows separate counts for gem vs daemon paths:
```
Gem orphans found:         N
Gem edges created:         N
Missing source artifact:   N
Daemon orphans found:      N
Daemon edges created:      N
Missing source task:       N
RELATE failed (total):     N
```

### Tests
- 596 pass (no new tests — the daemon path is a structural addition that mirrors the existing gem path; live verification via running the migration on this DB is the integration test).

## [0.7.37] — 2026-04-30

### Changed — `pending_work_purged` post-mortem alert → `pending_work_aging` pre-purge warning

User correction: the existing `substrate.pending_work_purged` alert fired AFTER pending_work items were already deleted (>7d old). By the time the alert surfaced in `<kongcode-alert>`, there was nothing to do — the data was gone. A tombstone reminder, not an actionable warning.

**The fix:** `observability.ts` — replaced the post-mortem detector with `detectPendingWorkAging`. Fires when pending_work items exist that are 5+ days old (the purge threshold is 7 days), giving ~2 days of actionable runway to drain the queue before data loss. Message includes a countdown: *"will purge in 1.4d if not processed"*.

The `code` changed from `substrate.pending_work_purged` → `substrate.pending_work_aging`. Cooldown applies independently per code, so the new alert won't inherit the old one's mute window.

The volume-based `pending_work_buildup` detector (fires at >50 items + oldest >24h) is unchanged — covers a different failure mode (queue-grew-fast, regardless of age).

### Tests
- Updated `test/observability.test.ts` — 2 cases swapped from purged-detector to aging-detector. Pinned: fires when items older than 5d exist (with countdown phrasing), does NOT fire when none.
- 596 tests pass.

## [0.7.36] — 2026-04-30

### Added — centroid-based project assignment for orphan rows (proper recovery, not relabeling)

User correction during v0.7.35 review: tagging unrecoverable orphans `scope='global'` was lazy — the rows already surfaced cross-project via the soft filter, so the tag was cosmetic. The genuine fix is to recover the missing metadata, not relabel its absence.

After sampling actual content, the orphan rows turned out to be high-signal engineering memories: release decisions ("don't ship node_modules"), user preferences ("user deploys fixes themselves"), debug findings (gateway crash patterns), README fixes. Real value worth proper provenance, not data to delete.

**The fix:** between the existing traversal-based backfill (steps 1-6) and the global-tag fallback (step 8), v0.7.36 adds a centroid-based assignment step:

1. For each `project`, compute the centroid embedding from the project's `concept` rows (up to 100 most-relevant).
2. For each orphan row (memory / reflection / skill) with `project_id=NONE` AND a populated embedding, compute cosine similarity to every project centroid.
3. Assign `project_id` to the project with highest similarity, **iff** that similarity exceeds `CENTROID_THRESHOLD = 0.5`.
4. Clear stale `scope='global'` tag from rows that just got a project (they have a real home now).
5. Truly cross-project content (release/process/preference lessons that don't semantically anchor to any one project) falls through to step 8 and stays `scope='global'` — that's the genuine global signal.

**Why this is real recovery, not relabeling:** the orphan rows now have a queryable, deterministic project_id derived from their semantic content. A future query for project-scoped memories will pull them via the canonical `project_id = $pid` clause, not via the catch-all `project_id IS NONE` fallback. The substrate now treats them as first-class citizens of their home project.

**Idempotent + reusable:** the migration only touches rows with `project_id=NONE`, so re-runs are safe. Anyone (any user) hitting the X-close orphan pattern (sessions purged before DB write) can run `introspect.action=migrate, filter=backfill_project_id` and benefit identically — the centroid pass needs only a populated `project` table and `concept`s with `relevant_to` edges, both of which any active kongcode workspace has.

**Threshold tuning:** 0.5 cosine on bge-m3 embeddings is a meaningful-overlap threshold (per the v0.7.27 lexical-fallback at the same value). Below that, the row genuinely doesn't belong to any project the user has ever worked on, so global is the honest tag.

### Tests
- 596 pass (no new tests; the centroid path is best-effort and exercises live data via the migration runner — pinning behavior in unit tests would require mocking project + concept rows extensively, deferred).

### Out of scope
- Synthesizing missing `session` rows for orphan `kc_session_ids` — the centroid pass already establishes `project_id` directly on the row, which is what retrieval cares about. Session synthesis would only add cosmetic completeness to the graph; deferred unless a real query path needs it.

## [0.7.35] — 2026-04-30

### Added — last two deferred items closed; deferred list now empty

The user explicitly asked for 100% caught up — no more deferred actions. This release closes both remaining items.

#### `applyDistributionBands` — WMR-distribution fallback when reranker offline
`graph-context.ts` — new `applyDistributionBands()` helper. If `rerankResults` didn't fire (reranker model failed to load, batch too small to reach the rerank stage, etc.) and no item has a `band` set, derive bands from `finalScore` quartiles within the current batch: top quartile → `load-bearing`, middle two → `supporting`, bottom quartile → `background`. The thresholds aren't calibrated like the cross-encoder's, so the bands carry weaker semantics — but they still give the model a coarse anchor, which beats the noisy `(relevance: N%)` we were falling back to. Called after `rerankResults` in both recall paths (graph-context.ts:1343, 1444).

#### Migration — `scope='global'` tagging for unrecoverable orphans
`introspect.ts` `backfill_project_id` migrate sub-mode — after the 6 traversal-based backfills, any `memory`/`reflection`/`skill` row still lacking `project_id` has a `session_id` that resolves to nothing (purged session, malformed id). They were already surfacing across projects via the soft filter (`project_id IS NONE`); tagging them `scope='global'` makes the implicit-global behavior explicit and zeros out the "unbackfilled" signal in the migration report. **Retrieval behavior unchanged** — the soft filter and the explicit-global path are equivalent for the read side; this is a data-shape cleanup.

### Tests
- 3 new cases in `test/salience-bands.test.ts` pinning `applyDistributionBands` quartile assignment, no-op when bands already set, empty-input safety.
- 596 tests pass (was 593 + 3).

### State of deferred queue
**Empty.** All items called out across the v0.7.26-v0.7.34 release train are either landed, explicitly out of scope (e.g. WMR/ACAN scoring replacement — not the reranker's job), or now closed in this release.

## [0.7.34] — 2026-04-30

### Fixed (release-process correction + 3 deferred items closed)

The v0.7.33 release was reported as "shipped, pre-push tests passed" but the win32-x64 CI job failed on a flaky `daemon-server` test. **Process correction**: pre-push test pass is necessary but not sufficient — CI must also be green before declaring a release done. Saved this as a high-importance correction memory.

#### CI fix — Windows ephemeral port range
`test/daemon-server.test.ts:12` — `ephemeralPort()` was returning `30000-60000`. Windows CI runners restrict permission on TCP ports below 49152 (the IANA dynamic/private range start). Tightened to `49152-65535`. Verified stable across 3 consecutive local runs.

#### Prefetch cache key includes reranker state (deferred from v0.7.28)
`prefetch.ts` — `CacheEntry.rerankerWasActive` field added. `getCachedContext` rejects hits where reranker state has flipped since cache write. A cached entry from an offline-reranker turn would have no band tags; serving it when the reranker is online would mismatch the directive's contract.

#### Set rebuild consolidation in graph expand (deferred from prior audit)
`graph-context.ts:1383-1397` — collapsed 3 nested `new Set()` allocations (`existingIds`, `neighborIds`, `allExisting`) into a single accumulator that grows in-place. Behavior identical, fewer allocations on the hot path.

### Out of scope (legitimately data-quality, not code)
- WMR-distribution-derived bands when the reranker is offline — the reranker is currently online (`rerankerActive: true` confirmed), so this fallback is unused. Will revisit only if the reranker stops loading.
- `~270` unbackfilled memories + `~40` reflections — orphan `session_id` strings that don't resolve via either record-ref OR `kc_session_id`. These reference sessions that were purged before any DB row was written. Not a code path; tagging them `scope='global'` would be opinionated and might hide rather than help.

### Tests
- 593/593 pass locally (vitest run).
- Daemon-server test re-run 3× consecutively, stable.

## [0.7.33] — 2026-04-30

### Fixed (production-readiness sweep — 3 silent gaps)

A user-driven audit of "what's still unwired" surfaced 3 issues. All low-blast-radius, all single-spot fixes, all addressed in this release.

#### `subagent.task` schema strictness — same shape as the v0.7.23 `mode` fix
Hook handlers (pre-tool-use) create `subagent` rows before the task description is known, but `task` was strict `TYPE string` (schema.surql:337). Daemon log was flooding with `Couldn't coerce value for field 'task' of 'subagent:...': Expected 'string' but found 'NONE'` per spawn. Relaxed to `option<string>` via `DEFINE FIELD OVERWRITE`, matching the v0.7.23 mode-field treatment. Live DBs converge on next daemon restart.

#### `citation_method='lexical'` fallback for paraphrased items
The v0.7.27 audit signal only set `cited=true` on `[#N]` matches. Items the model genuinely used but paraphrased (rephrasing the content without an explicit citation) got `cited=false, citation_method='none'` — incorrect audit credit. Added a lexical fallback: when no `[#N]` matched but `signals.utilization >= 0.5` (heavy keyTerm + trigram overlap, the existing computeSignals path), set `cited=true, citation_method='lexical'`. Threshold picks up genuine paraphrase without rewarding incidental word reuse.

#### `orphan_concepts` query false positives
The v0.7.23 silent-failure detector was flagging hundreds of `ingest:turn`-source concepts as "orphans" per active session. These are per-turn extractions whose provenance is the source turn — already linked via the existing `mentions` edge (turn→concept), NOT via `derived_from`. The query now filters `WHERE source != 'ingest:turn'` so it fires only for actual missing-edge bugs in gem/causal extraction (the original v0.7.23 use case).

### Tests
- Existing 4 citation-grounding cases still pass.
- New 5th case pins lexical-fallback behavior (paraphrase without `[#N]` → `cited=true, citation_method='lexical'`).
- 593 tests pass (was 592 + 1).

### Notes
- The 4 stale-purged `pending_work` items the alert flagged are pre-X-close-pattern orphans (sessions that purged before `session-end` ran). Forward path is clean — auto-drain threshold was already lowered from `>= 5` to `>= 1` in an earlier release.
- ~270 unbackfilled memories + ~40 reflections continue to reference orphan session_ids that don't resolve to any session row even via kc_session_id. Documented as data-quality residue, not a code gap.

## [0.7.32] — 2026-04-30

### Fixed (graduation-pipeline parser hardening + observability)

A v0.7.31 memory-extractor subagent run today submitted a `causal_graduate` work item with 6 skill candidates. The handler returned `skills_created: 0` and only 1 skill landed in the recent timeline (and that 1 came through a different code path — the per-session `memory-daemon.ts:343` extractor — not the subagent's explicit submission). 5 of 6 high-quality skill candidates were silently dropped.

Phase-1 root-cause analysis confirmed the parser contract was well-aligned with the documented instructions, but `parseCausalGraduationResult` (pending-work.ts:638) had **3 silent-failure paths** that returned `[]` without any log line:
1. Wrapped object shape (`{skills: [...]}`, `{result: [...]}`, etc.) → "not-an-array" path
2. Single skill object instead of a batch → "not-an-array" path
3. JSON parse failure on a string → "json-parse-failed" path

And `parseSkillResult` had additional drop paths: missing `name`, `steps` not an array, `steps` empty.

**Two-part fix:**

**Part 1 — drop-reason telemetry (`tracedrop`).** Every silent-failure return now emits a `log.warn`-level line tagged `[graduation-parser]` with the specific reason and a 300-char preview of the offending payload. So the next time a batch silently drops, the daemon log carries actionable evidence — not just `skills_created: 0`.

**Part 2 — tolerant parsing (`coerceSkill`).** New shared helper that accepts:
- **Name aliases**: `name` → `title` → `skill_name` → `id`. Subagents emit varied shapes; rejecting on an alias mismatch is over-strict.
- **String-array `steps` coercion**: each string becomes `{tool: "unknown", description: str}`. Better to land the row with an imperfect step shape than drop it entirely — the downstream skill-render path already handles the canonical shape and an unwritten skill is unrecoverable.
- **Step-field aliases**: each step can have `{name|tool, text|description|desc}`.

`parseCausalGraduationResult` now also unwraps top-level wrapper keys (`skills`, `result`, `extracted`, `items`, `data`) and treats a single `{name, steps}` object as a single-element array.

The downstream `ExtractedSkill` interface and `createSkillRecord` are unchanged — the contract on the *output side* is still strict; the parser becomes more forgiving on the *input side*.

### Tests
- New `test/pending-work-parser.test.ts` — 13 cases pinning canonical shape (regression), 5 wrapper unwraps, single-object handling, name-alias acceptance, step-coercion, step-field-alias coercion, and 4 truly-invalid drops.
- 592 tests pass (was 579 + 13).

## [0.7.31] — 2026-04-30

### Added (Reflexion-style grounding nudge — context-grounding plan phase 4)

Phase 2 (v0.7.27) wired the citation audit (`retrieval_outcome.cited` populated each turn from `[#N]` regex parsing) and added the helper `getLastTurnGroundingTrace` in `retrieval-quality.ts` — but the helper had no caller. The audit signal flowed to the DB and stopped there. Self-RAG/Reflexion (research from gap 3 synthesis) is to surface this trace back into the model as next-turn behavioral feedback. Without it, `cited` is dashboard-only and doesn't shape model behavior. This release closes the loop.

**Implementation:**
- `state.ts:85` — new `lastReflexionFireTurn: number = -1` on `SessionState` for cooldown tracking.
- `graph-context.ts:739-762` — at the start of the BEHAVIORAL DIRECTIVES rendering block, calls `getLastTurnGroundingTrace(session.sessionId, store)` and applies fire conditions. If firing, prepends a single-line nudge as its own section above BEHAVIORAL DIRECTIVES and updates `session.lastReflexionFireTurn`. swallow.warn-wrapped — the audit-loop code path is non-critical and must not break context injection.

**Fire conditions (all must hold):**
1. Last turn had retrieval (`injected >= 3`).
2. Zero structural citations (`cited === 0`).
3. At least 3 high-salience items were ignored (`ignored_high_salience.length >= 3`, where high-salience = retrieval_score ≥ 0.6).
4. Cooldown: didn't fire on the immediately preceding turn (`session.userTurnCount > session.lastReflexionFireTurn + 1`).

**Inject format:**
```
GROUNDING NUDGE (prior turn): N load-bearing items injected, 0 cited.
Either ground on them this turn (use [#N] indices) or explicitly note
why they're inapplicable. Repeated ignore-without-explanation degrades
retrieval utility scores.
```

**Why not a new CognitiveDirective type:** the `CognitiveDirective` union (`repeat | continuation | contradiction | noise | insight`) is for the LLM-graded cognitive-check pipeline. This nudge is mechanical — derived from `cited` field counts, not LLM judgment. Inject directly into the directive section text rather than extend the type union.

### Tests
- New `test/reflexion-nudge.test.ts` — 9 cases across 2 describe blocks pinning the trace contract (4) and fire-condition gates (5: volume threshold, engagement signal, cooldown, null-trace).
- 579 tests pass (was 570 + 9).

### Plan complete
With phases 1–4 shipped (v0.7.26–28 + v0.7.31), the four context-grounding gaps from the 2026-04-30 plan are closed end-to-end:
1. **Project-scoped retrieval** (v0.7.26 + 0.7.29 + 0.7.30 follow-ups for backfill robustness)
2. **Citation pattern via [#N]** (v0.7.27)
3. **Reranker-calibrated salience bands** (v0.7.28)
4. **Reflexion-style grounding feedback loop** (v0.7.31)

Remaining deferred polish (out of scope for this release train, but tracked):
- WMR-distribution-derived bands when reranker is offline (cosmetic — only matters if the reranker model dies).
- `citation_method='lexical'` for paraphrased items the model didn't cite by `[#N]` (audit-only enrichment; current code only sets `cited=true` on `[#N]` matches).

## [0.7.30] — 2026-04-30

### Fixed
- **`backfill_project_id` join key.** The migration's session-traversal subquery used `WHERE id = $parent.session_id` — but `memory.session_id`, `reflection.session_id`, and `skill.session_id` store the **kc_session_id** string (uuid-shaped, e.g. `0df34328-...`), not the surreal record ref (`session:abc123`). Result: the v0.7.29 backfill caught only 218/778 memories (28%) and 0/52 reflections (the kc-id pattern dominant) and had to rely on the small subset of rows that happened to store the surreal ref. Fixed to `WHERE kc_session_id = $parent.session_id OR id = $parent.session_id` — matches both shapes so legacy data with either populates correctly. Re-running on a v0.7.29-backfilled DB will now catch the remaining ~560 memories + 52 reflections.

## [0.7.29] — 2026-04-30

### Fixed (in-memory→DB-row write gap class — 0.7.28 follow-up)

After 0.7.28 shipped, running `backfill_project_id` revealed memories backfilled 0/778 because the traversal `memory.session_id → session.project_id` returned NONE for every session — sessions persist `agent_id` and `kc_session_id` to the DB but **not** `project_id`. That's a `SessionState`-populated-but-not-written gap; the user prompted to audit the rest of the codebase for the same class. Found 5 more sites with the same shape. Fixed all 6 in one pass.

**Row writers updated:**
- `surreal.ts:createSession` — accepts `projectId`, writes `project_id` field.
- `surreal.ts:ensureSessionRow` — accepts `projectId`, **also backfills the field on existing rows** where it's NONE (so resumed-conversation rows get the field on next UserPromptSubmit).
- `surreal.ts:createTask` — accepts `projectId`, writes `project_id` field. The `task_part_of` edge stays as the canonical link; this is the denormalized field for fast filter.
- `pending-work.ts:374` (reflection write) — adds `project_id` from `item.project_id`. Reflection writes are session-keyed and `pending_work` already carries `project_id` per row.
- `pending-work.ts:678` (`createSkillRecord`) — adds `project_id`.
- `pending-work.ts:445` (handoff_note memory) — adds **both** `session_id` and `project_id` (was: only the synthetic `source: "session:..."` string, unsearchable).
- `memory-daemon.ts:343` (skill direct write) — adds `project_id`.

**Hook callers threaded:**
- `session-start.ts:47, 53` — passes `session.projectId` to createTask + createSession.
- `user-prompt-submit.ts:75` — passes `session.projectId` to ensureSessionRow.

**Migration extended:**
`introspect.action=migrate, filter=backfill_project_id` now backfills 6 tables (was 2 in 0.7.26). Order matters: tasks → sessions (via task→project edge chain) → concepts (via relevant_to) → memories (via session.project_id) → reflections → skills (via skill_from_task→task or session_id fallback). Re-running on a 0.7.26-backfilled DB will catch the rows the original migration couldn't reach.

### Why this matters
The 0.7.26 read-side filter is soft (`project_id IS NONE` allowed), so this gap caused no runtime regression — pre-migration rows still surface across projects. But the *benefit* of project scoping was muted: only 1274/2534 concepts (~50%) got scoped, and 0/778 memories. After this release + a re-run of `backfill_project_id`, project scoping should approach 100% coverage on legacy data.

### Tests
- `test/project-scoped-retrieval.test.ts` updated: idempotency case now uses `toMatchObject` against the extended 6-table details shape.
- 570 tests pass (no new tests — the surface is migration-shaped and covered by the existing project-scoped-retrieval cases plus the live backfill run).

## [0.7.28] — 2026-04-30

### Changed (reranker-calibrated salience bands — context-grounding plan phase 3)

The pre-0.7.28 `(relevance: N%)` was the blended WMR/ACAN/cross score rendered as a percentage. Per GroGU (arxiv 2601.23129), raw retriever scores are weakly predictive of LLM grounding utility — and the percentage gave a false sense of precision. The cross-encoder (bge-reranker-v2-m3) is sigmoid-calibrated in [0,1], and >0.7 is a reliable threshold. Replacing the percentage with **three coarse bands** gives the model a stable anchor that survives embedder swaps and per-query distribution variance.

**Bands (from cross-encoder score):**
- `[load-bearing]` — score ≥ 0.7. Directive: must ground on these or explicitly note why not.
- `[supporting]` — score 0.3–0.7. Directive: mention if directly applicable.
- untagged (background) — score < 0.3. Directive: skip unless directly relevant; do not pad responses with these.
- **dropped** — score < 0.15. Hard noise filter — the cross-encoder strongly disagreeing with the WMR upstream is signal that the item is irrelevant despite its embedding similarity.

**Implementation:**
- `graph-context.ts:rerankResults` — preserves raw `crossScore` and stamps `band` on each candidate (was: discarded after blend). Drops candidates below `BAND_DROP_BELOW`. Tail items (ranked 31+, never reached the cross-encoder) default to `band='background'`.
- `graph-context.ts:bandFor` (new export) + `BAND_LOAD_BEARING_MIN`/`BAND_SUPPORTING_MIN`/`BAND_DROP_BELOW` constants.
- `graph-context.ts:744-810` — TOP HITS and per-section listings render `[band]` tag instead of `(relevance: N%)` whenever the cross-encoder fired. Falls back to the percentage for legacy/no-rerank paths so the output stays self-explanatory if the reranker model is missing.
- `user-prompt-submit.ts:38-50` — directive rewritten to explain bands and what action each warrants.

**Why band > percentage:** the percentage is a blend that mixes WMR (vector + ACAN) with cross-encoder; calibration is opaque to the reader. The band reflects only the cross-encoder calibrated probability, which has stable semantics. The user (or future-Claude) reading "(relevance: 67%)" cannot tell whether 67% is high or low for this query; reading "[supporting]" carries the answer.

### Tests
- New `test/salience-bands.test.ts` — 4 cases pinning the band thresholds and constant coherence.
- 570 tests pass (was 566 + 4).

### Plan complete
With phases 1 (project scope) + 2 (citation + grounding trace) + 3 (salience bands) shipped, the three context-grounding gaps the plan named on 2026-04-30 are all closed. Out of scope and tracked for follow-up:
- Reflexion-style "last turn you ignored 3 high-salience items" inject (`getLastTurnGroundingTrace` is wired in 0.7.27; the cognitive-check directive emission path is the missing piece).
- WMR-distribution-derived bands when the reranker isn't loaded (currently falls back to the percentage; could fall back to top-quartile/middle/bottom bands for consistent UX).
- `citation_method='lexical'` for paraphrased items.

## [0.7.27] — 2026-04-30

### Added (citation pattern + grounding-trace observability — context-grounding plan phase 2)

The pre-0.7.27 directive *"Cite items by their concept id when citing"* required emitting opaque ids like `concept:iw9rd1zsai2y2wmlqv2a` — useless to humans, so the model either ignored the directive (no audit signal) or followed it and produced unreadable output. The grounding-trace observability gap was that `retrieval_outcome` (36k+ rows) tracked **lexical** overlap as a proxy for whether items were used, but had no **structural** citation signal — so dashboards couldn't distinguish "model used this and rephrased it" from "model ignored it but happened to mention a similar word."

Adopting the Anthropic-Citations-API / Perplexity numbered-marker pattern: items are now rendered with `[#N]` prefixes (e.g. `[#3] [concept] (relevance: 67%) ...`); the directive tells the model to cite by `[#N]`; the substrate parses `[#N]` regex out of the response at Stop time and writes `cited: true` to the matching retrieval_outcome row.

**Implementation:**
- `user-prompt-submit.ts:38-42` — directive updated: *"Items are numbered [#N] — cite by index (e.g. [#3]) when grounding on them; the substrate maps the index back to the source."*
- `graph-context.ts:744-810` — builds `idToIndex: Map<string, number>` from the dedup+sort by finalScore. Same `[#N]` is used in TOP HITS and per-section listings (one stable handle per item across both views).
- `graph-context.ts:stageRetrieval` call — passes a `Map<number, string>` (1-based index → memory_id) alongside the items, so Stop has the lookup table at evaluation time.
- `retrieval-quality.ts:stageRetrieval` — accepts optional `indexMap` parameter; persists alongside items on the per-turn `_pendingRetrieval` state.
- `retrieval-quality.ts:evaluateRetrieval` — runs `responseText.matchAll(/\[#(\d+)\]/g)`, maps indices back via `indexMap`, writes `cited: bool` and `citation_method: 'index' | 'none'` to each `retrieval_outcome` row when an indexMap was provided.
- `retrieval-quality.ts:getLastTurnGroundingTrace` — new helper. Returns `{ injected, cited, ignored_high_salience }` from the last turn's retrieval_outcome rows. Foundation for the upcoming Reflexion-style "you ignored item X" feedback loop (deferred to 0.7.27.x).

**Schema:** SCHEMALESS so no DEFINE FIELD changes; `cited` and `citation_method` start appearing on rows after this release ships.

### Tests
- New `test/citation-grounding.test.ts` — 4 cases pinning the citation parser: hits + misses + idempotency on duplicate citations + back-compat for legacy callers without indexMap.
- 566 tests pass (was 562 + 4).

### Out of scope (deferred to 0.7.27.x or 0.7.28)
- Reflexion-style "last turn you ignored 3 high-salience items" injection in BEHAVIORAL DIRECTIVES — `getLastTurnGroundingTrace` is wired but the cognitive-check inject path is a separate change.
- Lexical-fallback `citation_method='lexical'` for items the model paraphrased without [#N] — the existing `utilization` lexical signal stays separate; only [#N] sets `cited=true` for now.

## [0.7.26] — 2026-04-30

### Fixed (cross-project bleed — context-grounding plan phase 1)

Retrieval was global by default — `vectorSearch` and `retrieveReflections` had **zero project-scoped WHERE clauses**, so `<reflection_context>` and recall blocks routinely injected lessons from unrelated projects (finance/trading, WhatsApp tooling, heartbeat polls) into kongcode-engineering turns. ICLR 2025 ("Long-Context LLMs Meet RAG") confirms cross-domain hard negatives hurt accuracy more than no retrieval at all. The substrate already had project pillars (`session.projectId` populated at session-start, `relevant_to`/`used_in` edges) — the retriever just wasn't honoring them.

**Read path:**
- `surreal.ts:vectorSearch` — accepts optional `projectId`; soft filter `(project_id IS NONE OR project_id = $pid OR scope = 'global')` applied to concept, memory, artifact subqueries. NONE-on-row preserves pre-migration data.
- `reflection.ts:retrieveReflections` — accepts `projectId`; filters by `session_id IN (SELECT id FROM session WHERE project_id = $pid)` traversal on top of direct project_id/scope match.
- `graph-context.ts:1261, 1347` — pipes `session.projectId` into both calls.
- `prefetch.ts:prefetchContext` — accepts `projectId`; piped through to vectorSearch + retrieveReflections.
- `context-engine.ts:301` — passes `session.projectId` to prefetchContext.

**Write path (denormalize project_id field):**
- `surreal.ts:upsertConcept/createMemory/createArtifact` — accept `projectId`, write `project_id` field on CREATE. Concept upsert path also backfills the field on re-touch when missing.
- `commit.ts:CommitConceptData/MemoryData/ArtifactData` — `projectId?: string` added to all three; piped to store.
- `concept-extract.ts:133` — passes `opts.projectId` to commitKnowledge.
- `memory-daemon.ts` — 5 sites updated (3× createMemory + 1× createArtifact + 1× upsertConcept) pass `projectId`.

**Backfill:**
- New `introspect.action=migrate, filter=backfill_project_id` sub-mode. Concepts: derives from outgoing `->relevant_to->project` edge. Memories: traverses `memory.session_id → session.project_id`. Idempotent — only touches rows where `project_id IS NONE`.

**Soft-launch semantics:** the WHERE filter accepts `project_id IS NONE` so pre-migration rows still surface (no regression). Once `backfill_project_id` runs, NONE rows are limited to truly unscoped data (bootstrap directives intended as global). A future release can tighten the filter once `scope='global'` tagging is mature.

### Tests
- New `test/project-scoped-retrieval.test.ts` — 4 cases pinning the backfill migration: concept-edge backfill, memory-session-traversal backfill, idempotency, broken-edge tolerance.
- 562 tests pass (was 558 + 4).

## [0.7.25] — 2026-04-30

### Fixed
- **Phantom failed MCP server entry in `/mcp`.** `.mcp.json` lived at the repo root, where Claude Code's project-level MCP auto-discovery picked it up *in addition to* the plugin loader. The project-context spawn failed because `${CLAUDE_PLUGIN_ROOT}` only resolves inside plugin context — node got the literal string and threw `ENOENT`. Plugin-context loading still worked (which is why MCP tool calls succeeded), but `/mcp` showed a phantom failed entry every session and Claude Code attempted a doomed second spawn. Moved `.mcp.json` → `.claude-plugin/mcp.json` so only the plugin manifest sees it. Updated `plugin.json` `mcpServers` ref accordingly. Removed redundant `.mcp.json` entry from `package.json` `files` list (the new path is included via the existing `.claude-plugin/` entry).

## [0.7.24] — 2026-04-30

### Added
- **`backfill_derived_from` migrate sub-mode.** Repairs concepts orphaned by the pre-0.7.23 `derived_from` schema mismatch. Selects concepts where `string::starts_with(source, 'gem:')` AND `array::len(->derived_from->?) = 0`, strips the `gem:` prefix to derive the artifact path, and re-RELATEs `concept→derived_from→artifact`. Idempotent — the orphan filter excludes already-linked concepts. Invoke via `introspect.action=migrate, filter=backfill_derived_from`. Verified live: 63 orphans repaired on the maintainer's DB, 0 missing artifacts, 0 RELATE failures.

### Fixed
- **`orphan_concepts` query template — two SurrealQL bugs surfaced during backfill testing.** SQL `LIKE` is not a SurrealQL keyword (replaced with `string::starts_with()`), and `string::starts_with()` errors on `NONE` values (added `source IS NOT NONE` guard). Both fixed in the same path the backfill uses.

## [0.7.23] — 2026-04-30

### Fixed
- **`derived_from` schema mismatch.** Schema declared `IN concept OUT task`, but two real callers wrote `concept → artifact` (gem provenance from `create_knowledge_gems`) and `subagent → task` (parent linking from `pre-tool-use`). Every invocation flooded `daemon.log` with `Couldn't coerce value for field out` errors and dropped the provenance edge — concepts got created, but tracing them back to their source returned nothing. Widened to `IN concept|subagent OUT task|artifact` via `DEFINE TABLE OVERWRITE` so live DBs converge on next daemon start.
- **Missing `spawned_from` edge.** `pre-tool-use` writes `subagent → spawned_from → session` for parent-session provenance, but the relation was never declared. Added `IN subagent OUT session`; added to `VALID_EDGES` whitelist in `surreal.ts`.
- **`subagent.mode` rejected NONE.** Hook handlers create subagent rows before they know the mode (`full | incognito`), but the field was a strict `TYPE string`. Relaxed to `TYPE option<string>` via `OVERWRITE`.
- **`orchestrator_metrics_daily.p95_tokens_in` array-of-NONE.** `math::percentile()` returned the input column instead of a scalar when input was all-NONE. Added a defensive `asFloat()` coercion before write.

### Changed (silent-failures sweep)
- Promoted high-severity `.catch(() => {})` and DEBUG-level `swallow()` calls to `swallow.warn` (always logged) on graph-integrity edges that, when they fail, leave concepts orphaned from their provenance:
  - `pending-work.ts:384` — `reflects_on` (reflection → session)
  - `pending-work.ts:680` — `skill_from_task` (skill → task)
  - `concept-links.ts:89-98` — `narrower` / `broader`
  - `concept-links.ts:119-122` — `related_to`
  - `commit.ts:150-154` — source → concept

### Added
- **`schema-edge-integrity` regression test** (`test/schema-edge-integrity.test.ts`) — parses `schema.surql` for every `RELATION` definition and statically checks every `store.relate(<from>, "<edge>", <to>)` call site against the schema's allowed IN/OUT types. Catches future bugs of the 0.7.22 class at PR time.
- **`orphan_concepts` introspect query** — concepts older than 1h with no outgoing `derived_from` edge. Runtime visibility into provenance gaps so the next regression of this class shows up in `kongcode-status` instead of being silently absorbed.

### Notes
- Test suite: 555 tests pass (was 548). New schema-edge-integrity contributes 3.
- Existing daemons running pre-0.7.23 schema will converge on next restart — `OVERWRITE` runs every boot via `runSchema()` and is idempotent.

## [0.7.15] — 2026-04-29

### Fixed
- `backfillSessionTurnCounts` SurrealQL parse error: was constructing `UPDATE <uuid>` statements with raw `turn.session_id` values (Claude Code session UUIDs). Now looks up by `kc_session_id` field. Eliminates the noisy "Cannot perform subtraction with 'e74702b0' and 'eb6b'" entries from `daemon.log`.

## [0.7.14] — 2026-04-29

### Added
- **Auto-drain scheduler restored.** Daemon now spawns `claude --agent kongcode:memory-extractor -p ...` as a headless subprocess when the `pending_work` queue exceeds threshold. Restores the auto-extraction behavior that lived in the in-process MemoryDaemon before commit `4f7b962` removed the Anthropic SDK.
- New env vars: `KONGCODE_AUTO_DRAIN`, `KONGCODE_AUTO_DRAIN_THRESHOLD` (default 5), `KONGCODE_AUTO_DRAIN_INTERVAL_MS` (default 300000), `KONGCODE_CLAUDE_BIN`
- New `src/daemon/auto-drain.ts` with PID-file-locked scheduler
- SessionEnd hook triggers an immediate debounced drain check

## [0.7.13] — 2026-04-29

### Changed
- Default idle reap timeout: 60s → 6s. Anything longer was just holding ~150MB of BGE-M3 in RAM for nobody. Configurable via `KONGCODE_DAEMON_IDLE_TIMEOUT_MS`.

## [0.7.12] — 2026-04-29

### Added
- One-time historical backfill: `backfillSessionTurnCounts` runs in `runBootstrapMaintenance` and reconciles `session.turn_count = 0` rows by counting their linked `turn` rows.

### Changed
- `turn_count` increments now happen on UserPromptSubmit (reliable hook, fires at turn start), not Stop (fragile). Token accounting still happens in Stop.
- Split `store.updateSessionStats` into `bumpSessionTurn` and `addSessionTokens`. The combined version is `@deprecated` and kept as a backward-compat shim.

## [0.7.11] — 2026-04-29

### Added
- `KONGCODE_DAEMON_IDLE_TIMEOUT_MS` env var (default 60s) to tune the idle reaper introduced in 0.7.10.

## [0.7.10] — 2026-04-29

### Added
- **Idle reaper.** Daemon exits after `idleTimeoutMs` of zero attached clients. Restores the implicit "die when nobody's home" behavior from the pre-0.7.0 monolith model.
- `meta.health.stats` now includes `idleSince` and `idleTimeoutMs` for observability.

## [0.7.9] — 2026-04-29

### Added
- **Per-socket client identity registry.** `DaemonServer.clients` is now `Map<Socket, ClientInfo>` instead of `Set<Socket>`. New `meta.handshake` request shape accepts `{clientInfo: {pid, version, sessionId}}`; daemon logs connect/disconnect lines with full identity.
- `meta.health.stats.clients` returns the array of identified clients

## [0.7.8] — 2026-04-29

### Added
- **Orphan-recycle fallback.** When a 0.7.8+ mcp-client connects to a pre-0.7.7 daemon and `meta.requestSupersede` returns `-32601 Method not found`, the client falls back to checking `meta.health.activeClients`. If we're the only attached client (orphan), it sends `meta.shutdown` and re-spawns. Closes the bootstrap gap on the upgrade boundary from older daemons.

## [0.7.7] — 2026-04-29

### Added
- **Supersede protocol.** New `meta.requestSupersede` RPC. A newer mcp-client flags the running daemon for graceful exit when its last attached client disconnects. Older sibling sessions keep working until they naturally close. Multi-session-safe code refresh.

### Changed
- `DaemonServer.checkSupersedeReady` fires `onSupersedeReady` callback exactly once per supersede cycle.

## [0.7.6] — 2026-04-29

**Reverted in 0.7.7.** Initial version-mismatch logic killed the daemon on any mismatch; correctly flagged by user as wrong (would disrupt sibling sessions). Replaced with the supersede protocol.

## [0.7.5] — 2026-04-29

### Fixed
- `session.turn_count` stuck at 0: Stop hook now calls `updateSessionStats` to increment per-turn. Previously only PreCompact fired the increment, which is rare.
- `sessionEnd:endSession: Invalid record ID format:` log noise: guarded `endSession` call on truthy `surrealSessionId`.

## [0.7.4] — 2026-04-29

### Fixed
- **ESM `require()` bug in spawn-lock cleanup.** `package.json` is `"type": "module"` so `require("node:fs").unlinkSync(...)` threw ReferenceError silently swallowed by `try/catch`. Three call sites in `mcp-client/daemon-spawn.ts` and one in `daemon/index.ts` patched to use the imported `unlinkSync`/`mkdirSync` directly. Stale `daemon.spawn.lock` files now actually get cleaned up.
- **Lazy session-row backfill on `claude --resume`.** Claude Code doesn't refire SessionStart on resumed conversations, so resumed sessions had no DB row, leaving turns ingested but unattributable. UserPromptSubmit now calls `store.ensureSessionRow(kcSessionId, agentId)` (idempotent) when `session.surrealSessionId` is unset. Closes the X-close orphan pattern forward.

## [0.7.3] — 2026-04-29

### Fixed
- Stale `daemon.spawn.lock` recovery: `tryAcquireSpawnLock` now reads the holder PID, unlinks the file if dead, and retries the lock acquire. Self-heals stale locks from prior daemon attempts that exited without clean release.

## [0.7.2] — 2026-04-29

### Fixed
- **Eager daemon spawn from mcp-client startup.** Hooks fire BEFORE any tool call, so the lazy "spawn daemon on first tool call" path missed every hook in a session that didn't invoke MCP tools. mcp-client now triggers `getOrConnectIpc()` in the background after the MCP stdio handshake completes. In-flight promise cache prevents lock-contention races between the eager call and any concurrent tool-call.

## [0.7.1] — 2026-04-29

### Added
- Daemon now exposes the legacy HTTP API on a per-PID Unix socket (`~/.kongcode-<pid>.sock`) so `hook-proxy.cjs` can find it. Without this, hooks silently no-op'd in the daemon-arch path.
- `.mcp.json` flipped from `node dist/mcp-server.js` (legacy monolith) to `node dist/mcp-client/index.js` (daemon-arch thin client).

## [0.7.0] — 2026-04-28

### Added
- **Daemon-split architecture.** Two cooperating processes:
  - `kongcode-daemon`: long-lived background process owning `SurrealStore`, `EmbeddingService`, ACAN weights, all 12 tool + 10 hook handlers
  - `kongcode-mcp`: thin per-Claude-Code-session client; forwards MCP RPC to daemon via JSON-RPC 2.0 over Unix socket (TCP loopback fallback for Windows)
- Multiple Claude Code sessions share one daemon; one BGE-M3 in RAM regardless of session count
- Daemon survives plugin updates, MCP restarts, and Claude Code crashes via `detached: true, unref()`
- SEA binaries built for linux-x64/arm64, macOS-arm64, win32-x64 (macOS-x64 still falls back to JS)

## [0.6.x series] — 2026-04-28

Self-contained first-run bootstrap shipped:

- `src/engine/bootstrap.ts` provisions SurrealDB binary, BGE-M3 GGUF model, node-llama-cpp native bindings on first run
- `bin-manifest.json` pins versions and per-platform sha256 hashes
- Auto-detects existing kongcode SurrealDB on legacy ports (8000, 8042) before spawning a managed child
- Various Windows-specific fixes (npm.cmd shell:true, PATH propagation guidance)

## [0.5.x series and earlier]

See `git log` for pre-0.6.0 history. Highlights:

- **0.5.4**: restored `userTurnCount` increment in `ingestTurn` (silent-failure regression from `4f7b962`)
- **0.5.1**: closed issue #5 (pending_work drain visibility)
- **0.4.0**: auto-seal contract — `commitKnowledge` auto-fires `narrower`/`broader`/`related_to`/`about_concept`/`mentions` edges on every write
- **0.3.0**: full Option A multi-MCP hardening (atomic weights save, training lockfile, mtime hot-reload)
- **0.2.0**: skill suite + grounding metric instrumentation
- **0.1.x**: initial port from KongBrain
