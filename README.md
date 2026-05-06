<div align="center">

# KongCode

![KongCode](kongcodeLogoV4.png)

[![VoidOrigin](https://img.shields.io/badge/VOIDORIGIN-voidorigin.com-0a0a0a?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSI+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMTAiIHN0cm9rZT0iI2ZmNmIzNSIgc3Ryb2tlLXdpZHRoPSIyIi8+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iNCIgZmlsbD0iI2ZmNmIzNSIvPjwvc3ZnPg==&logoColor=ff6b35&labelColor=0a0a0a)](https://voidorigin.com)

[![Version](https://img.shields.io/badge/v0.7.59-stable-22c55e?style=for-the-badge)](https://github.com/42U/kongcode)
[![GitHub Stars](https://img.shields.io/github/stars/42U/kongcode?style=for-the-badge&logo=github&color=gold)](https://github.com/42U/kongcode)
[![License: MIT](https://img.shields.io/github/license/42U/kongcode?style=for-the-badge&logo=opensourceinitiative&color=blue)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![SurrealDB](https://img.shields.io/badge/SurrealDB-3.0-ff00a0?style=for-the-badge&logo=surrealdb&logoColor=white)](https://surrealdb.com)
[![Tests](https://img.shields.io/badge/Tests-648_passing-brightgreen?style=for-the-badge&logo=vitest&logoColor=white)](https://vitest.dev)

**Graph-backed permanent memory for [Claude Code](https://claude.ai/claude-code).** Forked from [KongBrain](https://github.com/42U/kongbrain).

[Quick start](#quick-start) | [Architecture](#architecture) | [Configuration](#configuration) | [Troubleshooting](#troubleshooting) | [Development](#development)

</div>

---

## What it does

KongCode gives Claude Code a persistent, queryable memory that grows with every session — backed by a SurrealDB graph and BGE-M3 vector embeddings running locally.

| Capability | Stock Claude Code | With KongCode |
|---|---|---|
| **Memory** | File-based, per-project, manual | Graph DB, cross-session, automatic |
| **Context window** | Sliding, lost on `/clear` or session end | Retrieval-augmented from prior turns and concepts |
| **Knowledge extraction** | None | 9 types: concepts, causal chains, monologues, corrections, preferences, artifacts, decisions, skills, reflections |
| **Procedural memory** | None | Skills mined from successful workflows, surfaced when preconditions match |
| **Identity** | Stateless on every turn | Earned soul after a graduation gate (volume + quality thresholds) |

## Quick start

KongCode ships with a self-contained first-run bootstrap. No manual SurrealDB install, no embedding-model download, no shell scripts — install the plugin, open a session, and the daemon provisions the rest in the background.

### Prerequisites

| Tool | When required |
|---|---|
| **git** | Always — Claude Code uses it to clone the marketplace repo |
| **Node.js ≥ 18 + npm** | Only when running the JS fallback (no SEA binary for your platform yet, or running from a dev checkout). Most users on linux-x64/arm64, macOS x64/arm64, win-x64 get the SEA binary and don't need Node. |

Quick installs (only if you need Node + git for the fallback path):

- **macOS**: `brew install node git`
- **Windows (PowerShell, elevated)**: `winget install OpenJS.NodeJS.LTS Git.Git` then **restart your terminal AND Claude Code** so the new PATH is picked up.
- **Linux**: distro package manager (`apt install nodejs npm git`) or [nvm](https://github.com/nvm-sh/nvm).

### 1. Install the plugin

In Claude Code:

```
/plugin marketplace add 42U/kongcode
/plugin install kongcode@kongcode-marketplace
```

### 2. Open a session

```bash
claude
```

On first run, the kongcode daemon provisions everything it needs (one-time, ~2-3 minutes depending on your connection):

- Installs npm deps (pulls node-llama-cpp's platform-correct native binding)
- Downloads the SurrealDB binary for your platform from the official GitHub release into `~/.kongcode/cache/`
- Downloads the BGE-M3 GGUF embedding model (~420MB) from Hugging Face into `~/.kongcode/cache/models/`
- Spawns a managed SurrealDB child process backed by `~/.kongcode/data/`

Subsequent sessions skip bootstrap and start in seconds — they warm-attach to the long-lived daemon.

### 3. Launch Claude with the kongcode prompt (recommended)

Claude Code ships with its own file-based "auto memory" system that writes to `~/.claude/projects/<project>/memory/*.md`. Without redirection, you end up with two parallel memory stores (kongcode's graph and Claude Code's files) that fragment your knowledge.

We ship a kongcode-branded system prompt at [`templates/kongcode.txt`](templates/kongcode.txt) that turns Claude into an autonomous, memory-aware agent:

- Explains kongcode's per-turn context injection (`<active_directives>`, `<recalled_memory>`, retrieval rationale, etc.) so Claude knows how to read and ground in it
- Standards for every action: be factually correct, slow down on non-trivial work, verify before claiming done, apply user-set rules every turn
- A four-phase turn loop (READ / REASON / RECALL / SAVE) with explicit save and recall triggers
- Self-healing rules so Claude diagnoses retrieval problems with `introspect` rather than asking you to run commands

Install it once:

```bash
cp /path/to/kongcode/templates/kongcode.txt ~/.kongcode-prompt.txt
```

Then launch Claude with it via `--append-system-prompt-file`. The simplest UX is a shell alias so you do not have to remember the flag:

```bash
# bash / zsh
echo 'alias claude="claude --append-system-prompt-file ~/.kongcode-prompt.txt"' >> ~/.zshrc
source ~/.zshrc
```

Or use it directly:

```bash
claude --append-system-prompt-file ~/.kongcode-prompt.txt
```

**Why `--append-system-prompt-file` and not `~/.claude/CLAUDE.md`?** Both work, but `--append-system-prompt-file` injects the prompt at system-prompt level, which is more authoritative than the auto-discovered `CLAUDE.md` block. CLAUDE.md is fine as a lighter alternative if you do not want a shell alias.

**Per-project CLAUDE.md** (optional). Drop a short file at your repo root for project-specific notes:

```markdown
# <project name>

The kongcode daemon may be running locally and injecting context every turn. See the kongcode prompt for the full agent guide. Query the kongcode MCP tools (`recall`, `record_finding`, `core_memory`, `introspect`) for historical decisions, architecture, and user preferences before guessing.
```

**Migrating an existing memory directory.** If `~/.claude/projects/<project>/memory/` already has `.md` files, ask Claude in a session for that project to ingest them into kongcode (`create_knowledge_gems` with the file contents, or `record_finding` per file), then delete the originals and replace `MEMORY.md` with a pointer that says "deprecated, see kongcode."

### Updating

```
/plugin marketplace update kongcode-marketplace
/plugin update kongcode@kongcode-marketplace
```

There's no auto-update — Claude Code's plugin system requires explicit user-initiated updates. Once you update, the new mcp-client detects it's running newer than the daemon, flags the daemon for graceful exit on next disconnect, and the next session you open spawns a fresh daemon with the new code. No manual restart of anything.

### Bring-your-own-SurrealDB (advanced)

If you'd rather use a SurrealDB instance you already run, set `SURREAL_URL` and the bootstrap skips the managed child:

```bash
export SURREAL_URL="ws://localhost:8000/rpc"
export SURREAL_USER=root
export SURREAL_PASS=root
```

KongCode also auto-detects an existing SurrealDB on `8000`, `8042`, or the managed port at startup, so you usually don't need to set this manually if you already have one running.

### Platform support

| Platform | SEA binary | JS fallback (needs Node) |
|---|---|---|
| linux-x64 | ✅ | ✅ |
| linux-arm64 | ✅ | ✅ |
| macOS-arm64 | ✅ | ✅ |
| macOS-x64 | — | ✅ if Node 18+ available |
| win32-x64 | ✅ | ✅ |
| Other | — | ✅ if Node 18+ available |

If you hit issues, please file at https://github.com/42U/kongcode/issues.

## Architecture

KongCode runs as **two cooperating processes**:

```
                    ┌────────────────────────────────────────────┐
                    │  kongcode-daemon (long-lived, 1 per host)  │
                    │  ┌──────────────────────────────────────┐  │
                    │  │ SurrealStore (graph DB connection)   │  │
                    │  │ EmbeddingService (BGE-M3 in RAM)     │  │
                    │  │ ACAN weights + retrain loop          │  │
                    │  │ All 12 tool + 10 hook handlers       │  │
                    │  │ Auto-drain scheduler                 │  │
                    │  └──────────────────────────────────────┘  │
                    │                       ▲                    │
                    │           Unix socket │ JSON-RPC 2.0       │
                    │     ~/.kongcode-daemon.sock                │
                    └────────────────────┬─┴──────────────────────┘
                                         │
              ┌──────────────────────────┼──────────────────────────┐
              │                          │                          │
   ┌──────────┴──────────┐    ┌──────────┴──────────┐    ┌──────────┴──────────┐
   │  kongcode-mcp #1    │    │  kongcode-mcp #2    │    │  headless drainer   │
   │  (Claude Code A)    │    │  (Claude Code B)    │    │  (auto-drain spawn) │
   └─────────────────────┘    └─────────────────────┘    └─────────────────────┘
```

- **kongcode-daemon**: long-lived background process owning the SurrealDB connection, BGE-M3 embedding model (~150MB RAM), ACAN weights, all tool/hook handlers, and the auto-drain scheduler. Survives plugin updates, MCP restarts, and Claude Code crashes. Auto-recycles cleanly on version mismatch via the supersede protocol.
- **kongcode-mcp**: thin per-Claude-Code-session client (~50MB RAM). Forwards MCP RPC to the daemon over local IPC. Plugin updates only restart this; the daemon keeps running.

**Multiple Claude Code sessions share one daemon** — one BGE-M3 in RAM instead of N copies, one SurrealDB connection pool. The daemon tracks per-client identity (`{pid, version, sessionId}` registered at handshake) and serves all attached clients concurrently.

### Lifecycle highlights

- **Spawn**: the first mcp-client to find a missing daemon socket forks one (detached, unref'd, PID-file-locked so concurrent sessions don't race).
- **Idle reap**: when no clients are attached for `KONGCODE_DAEMON_IDLE_TIMEOUT_MS` (default 6s), the daemon gracefully exits to free RAM. The next client spawns a fresh one — typically a 1–2s warm path because the SurrealDB child is already running.
- **Supersede on update**: a newer mcp-client calls `meta.requestSupersede`; the daemon flags itself for exit on its last client disconnect. Older sibling sessions keep working until they close naturally — the upgrade happens at the natural disconnect boundary, not by killing live work.
- **Auto-drain**: when `pending_work` exceeds `KONGCODE_AUTO_DRAIN_THRESHOLD` (default 5), the daemon shells out to `claude --agent kongcode:memory-extractor -p …` as a headless subprocess. It drains 5–15 items and exits. See [Auto-drain & costs](#auto-drain--costs) for the cost story.

## Auto-drain & costs

KongCode's memory extraction (causal chains, concepts, skills, etc.) is cognitive work that needs an LLM. To avoid managing API keys or duplicating the cognitive layer, the daemon **shells out to your already-authenticated `claude` CLI** to drain the queue. Specifically:

```bash
claude --agent kongcode:memory-extractor --print --permission-mode bypassPermissions "..."
```

This invocation runs as a regular Claude Code subagent under your existing authentication, **consuming tokens against your normal Claude Code quota**. Each spawn drains roughly 5-15 queued items before exiting.

**Cadence**:
- Startup check immediately after the daemon initializes
- Every 5 minutes (`KONGCODE_AUTO_DRAIN_INTERVAL_MS`) while the daemon is alive
- Once after each `SessionEnd` hook, debounced via PID-file lock

**Cost gating**:
- `KONGCODE_AUTO_DRAIN_THRESHOLD` (default 5): below this queue size, scheduler is a no-op
- PID-file lock at `~/.kongcode/cache/auto-drain.pid` prevents overlapping spawns
- `KONGCODE_AUTO_DRAIN=0` disables the entire scheduler — falls back to manual subagent spawning at session start (the assistant sees an alert and chooses whether to spawn)

If you'd rather kongcode never auto-spawn anything: `export KONGCODE_AUTO_DRAIN=0` in your shell rc.

## Commands & tools

KongCode exposes two surfaces: **slash commands** (you type, run as a skill) and **MCP tools** (the assistant calls them, scoped to its task). Slash commands are wrappers — they invoke the same skills the assistant uses.

| Slash command | What it does |
|---|---|
| `/recall [query]` | Search past knowledge across concepts, memories, turns, artifacts, and skills |
| `/core-memory [action]` | List, add, update, or deactivate always-loaded directives (Tier 0 = every turn, Tier 1 = session) |
| `/introspect [action]` | Database diagnostics: `status`, `count`, `verify`, `query`, `trends`, `migrate` |
| `/kongcode-status` | One-shot health dashboard (counts, embedding coverage, graduation progress) |

The assistant additionally has access to MCP tools the user doesn't typically invoke directly — `recall`, `core_memory`, `introspect`, `memory_health`, `record_finding`, `supersede`, `link_hierarchy`, `what_is_missing`, `cluster_scan`, `create_knowledge_gems`, plus the daemon-managed `fetch_pending_work` / `commit_work_results` queue. Skills declared in `skills/` auto-activate when their frontmatter triggers match.

## Configuration

All env vars are optional with sensible defaults.

### SurrealDB connection

| Variable | Default | Description |
|----------|---------|-------------|
| `SURREAL_URL` | `ws://localhost:8000/rpc` | SurrealDB WebSocket URL. Bootstrap auto-detects in order: `8000`, `8042`, then the managed-child port (`18765` by default). |
| `SURREAL_USER` | `root` | SurrealDB username |
| `SURREAL_PASS` | `root` | SurrealDB password |
| `SURREAL_NS` | `kong` | SurrealDB namespace |
| `SURREAL_DB` | `memory` | SurrealDB database |
| `SURREAL_BIN_PATH` | (auto) | Path to surreal binary; bypasses bootstrap download |

### Cache & data paths

| Variable | Default | Description |
|----------|---------|-------------|
| `KONGCODE_CACHE_DIR` | `~/.kongcode/cache` | Where binaries, models, and lock files live |
| `KONGCODE_DATA_DIR` | `~/.kongcode/data` | SurrealDB data directory |
| `EMBED_MODEL_PATH` | (auto) | Override path to the BGE-M3 GGUF file |
| `KONGCODE_SURREAL_PORT` | `18765` | Managed SurrealDB child's port (when bootstrap spawns one) |

### Bootstrap & daemon lifecycle

| Variable | Default | Description |
|----------|---------|-------------|
| `KONGCODE_SKIP_BOOTSTRAP` | `0` | Set `1` to skip first-run provisioning entirely |
| `KONGCODE_DAEMON_IDLE_TIMEOUT_MS` | `6000` | Daemon exits this long after the last client disconnects. Set `0` to disable idle reap. |
| `KONGCODE_DAEMON_TRANSPORT` | `unix` | Set `tcp` to force loopback TCP (Windows/paranoid setups) |
| `KONGCODE_NODE_LLAMA_CPP_PATH` | (auto) | Override path to node-llama-cpp install |
| `KONGCODE_LEGACY_MONOLITH` | `0` | Set `1` to fall back to pre-0.7.0 single-process mode (emergency rollback) |

### Auto-drain

| Variable | Default | Description |
|----------|---------|-------------|
| `KONGCODE_AUTO_DRAIN` | `1` | Set `0` to disable the auto-drain scheduler entirely |
| `KONGCODE_AUTO_DRAIN_THRESHOLD` | `5` | Min `pending_work` queue size before scheduler spawns an extractor |
| `KONGCODE_AUTO_DRAIN_INTERVAL_MS` | `300000` | Periodic check cadence (5 min) |
| `KONGCODE_CLAUDE_BIN` | (auto) | Explicit path to the `claude` binary; otherwise scheduler uses `which claude` |

### Logging

| Variable | Default | Description |
|----------|---------|-------------|
| `KONGCODE_LOG_LEVEL` | `warn` | One of `error`, `warn`, `info`, `debug` |

## How it works

KongCode runs cognitive work in three loops, each at a different cadence.

### Per turn (synchronous, sub-second)
1. **`UserPromptSubmit`** — classify intent, retrieve relevant graph context (concepts, memories, prior turns) ranked by vector similarity + reranker, inject via `additionalContext`. Increment `session.turn_count`.
2. **`PreToolUse`** — record the tool call against the session's adaptive budget; track subagent spawns.
3. **`PostToolUse`** — record outcomes (success/failure, duration), track new or modified artifacts.
4. **`Stop`** — ingest the assistant's response, accumulate token deltas, queue trailing work items.

### Between turns (async, daemon-driven)
A background subagent (auto-drained when `pending_work` exceeds threshold) extracts nine knowledge types from the rolling transcript: concepts, causal chains, inner-monologue traces, corrections, preferences, artifacts, decisions, skills, and reflections. Each write goes through `commitKnowledge()`, which auto-seals graph edges (hierarchy, related-to, mentions) so callers never have to wire links manually.

### Between sessions (async, queued)
`SessionEnd` queues 5–6 cognitive work items (extraction, handoff, reflection, skill mining, causal graduation, soul evolution). The auto-drain scheduler spawns a headless `claude` subprocess to drain the queue against your existing Claude Code authentication. A deferred-cleanup pass on next session start reaps orphaned sessions (terminals X-closed without a clean shutdown).

### Soul graduation
After roughly 15 sessions with sufficient quality signals — populated reflections, completed causal chains, a healthy concept graph, and accumulated skills — the agent crosses a graduation gate and earns a **soul**: an emergent identity document with working style, self-observations, and evidence-grounded values. Once graduated, the soul is loaded as Tier 0 core memory on every turn, supplying continuity across sessions without retraining.

## Troubleshooting

### "Failed to reconnect to plugin:kongcode"

The mcp-client failed to start. Common causes:

- **Node not on PATH** (Windows post-winget install): restart your terminal AND Claude Code so the new PATH takes effect
- **Daemon binary corrupted**: `rm -rf ~/.kongcode/cache && claude` will re-bootstrap
- **Port conflict**: another process is on 18765 (the managed SurrealDB port). Set `KONGCODE_SURREAL_PORT` to a free port.

Check the daemon log for the actual error: `tail -100 ~/.kongcode/cache/daemon.log`

### Daemon won't recycle to new version

If you've updated kongcode but the running daemon stays on the old code:

- Other Claude Code sessions or background extractors may still be attached. Daemon waits for ALL clients to disconnect before honoring the supersede flag (architectural invariant: never disrupt a sibling session for an upgrade).
- Force-recycle: `kill -TERM $(cat ~/.kongcode/cache/daemon.pid)`. The next client will spawn a fresh daemon. Cost: ~3-5s of cold-start on the next session.

### Auto-drain isn't running

Check:

```bash
# Is auto-drain disabled?
echo $KONGCODE_AUTO_DRAIN  # should be empty or "1"
# Is the scheduler holding a lock?
cat ~/.kongcode/cache/auto-drain.pid 2>/dev/null
# Is claude binary findable?
which claude
```

If the binary isn't on PATH, set `KONGCODE_CLAUDE_BIN=/path/to/claude` and restart Claude Code.

### Pending_work queue keeps growing

Each session end queues 5-6 items. If queue is growing faster than draining:

- Check daemon log: `grep auto-drain ~/.kongcode/cache/daemon.log`
- Threshold gate may be skipping spawns: lower `KONGCODE_AUTO_DRAIN_THRESHOLD=1` to trigger more aggressively
- Manually trigger a drain via the `kongcode-health` skill or by spawning a `kongcode:memory-extractor` subagent

### Files & paths to know

| Path | Purpose |
|------|---------|
| `~/.kongcode/cache/daemon.pid` | PID of the running daemon |
| `~/.kongcode/cache/daemon.log` | Daemon stdout/stderr (lifecycle, errors) |
| `~/.kongcode/cache/daemon.spawn.lock` | Held during daemon spawn; cleaned on exit |
| `~/.kongcode/cache/auto-drain.pid` | Held while a headless extractor is running |
| `~/.kongcode/cache/surreal.pid` | Managed SurrealDB child's PID (if bootstrapped) |
| `~/.kongcode-daemon.sock` | Daemon's IPC listening socket |
| `~/.kongcode-<pid>.sock` | Daemon's per-PID HTTP socket for hook-proxy.cjs |
| `~/.kongcode/data/` | SurrealDB data files |
| `~/.kongcode/cache/models/` | Downloaded GGUF embedding model |

## Skill suite

KongCode ships a suite of production-grade skills that encode reusable patterns for managing graph memory across sessions. Each skill lives in `skills/<name>/SKILL.md` with frontmatter triggers and auto-activates on matching user prompts.

**Foundation:**
- `kongcode-health` — pre-flight check before graph writes (runs introspect, recall probe, fetch_pending_work)
- `ground-on-memory` — enforce grounding discipline: scan injected context, cite relevant items, note when nothing matches

**Intelligence:**
- `recall-explain` — cluster recall output, flag contradictions, produce narrative evidence summaries
- `capture-insight` — foreground knowledge capture without waiting for the batch daemon

**Write-time quality:**
- `supersede-stale` — realtime supersession of outdated concepts
- `extract-knowledge` — source-agnostic extraction (PDF, code, URL, doc, transcript) with cross-source linking

**Compound value:**
- `synthesize-sources` — multi-source meta-concept generation with cross-link edges
- `knowledge-gap-scan` — topic coverage analysis before research
- `audit-drift` — periodic sweep for stale knowledge

Canonical edge vocabulary: `src/engine/edge-vocabulary.ts`. Full workflow docs: [`docs/WORKFLOWS.md`](docs/WORKFLOWS.md).

## Development

```bash
npm run build      # Compile TypeScript + copy schema.surql to dist/
npm run dev        # Watch mode
npm run typecheck  # Type check only
npm test           # Run vitest (555 tests across 35 files)
```

The `dist/` directory ships in releases (intentionally not gitignored). Contributors working from the dev tree should `npm run build` before testing — `loadSchema()` resolves to `dist/engine/schema.surql` first.

A `pre-push` hook gates pushes on the full vitest run. The suite includes a **schema-edge integrity guard** (`test/schema-edge-integrity.test.ts`) that statically checks every `store.relate(<from>, "<edge>", <to>)` call site in `src/` against the IN/OUT types declared in `schema.surql` — catching schema/code mismatches at PR time rather than as silent runtime warnings.

---

<div align="center">

MIT License | Built by [42U](https://github.com/42U) | [VoidOrigin](https://voidorigin.com)

</div>
