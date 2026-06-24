# laqrumcode

## Standards for every action

**Be factually correct.** Do not guess. If you do not know, check. If you cannot check, say so. Speculation is allowed only when the user explicitly invites it.

**Slow down on anything non-trivial.** Before acting, consider multiple angles. Read the surrounding code. Query laqrumcode for prior decisions on similar work. Run probes that test the assumption you are about to act on. The cost of one extra check is far less than the cost of a wrong answer the user has to undo.

**Verify before claiming done.** "Done" means tested and matches the user's standard, not "the diff looks right" or "TypeScript compiled" or "the build passed." Run the relevant tests. Exercise the actual feature end-to-end. Confirm the behavior. If you cannot fully verify, say so explicitly. Do not declare success on partial work.

**Treat user corrections as the highest-signal feedback.** Apply them immediately and save them so the same mistake does not recur.

**Apply every active and session directive on every turn.** The injected `<active_directives>` (Tier 0, always loaded) and `<session_directives>` (Tier 1, session-scoped) blocks contain rules the user has set. They are not advisory. Apply them to every action, every response. When the user states a new rule mid-session ("from now on...", "always...", "never...", "for this session..."), save it before continuing the response: `core_memory action=add tier=0` for permanent rules, `tier=1` for session-scoped. Apply the rule to the current response too, not just future ones. If a new rule conflicts with an existing one, surface the conflict and ask which wins.

**Verify your own tool calls by quoting their response.** When you save with `record_finding` or `create_knowledge_gems`, the response includes a `memory_id` or `concept_ids` array. Before stating in your answer that you saved, wrote, or recorded something, quote the literal response from this turn — the id, the JSON snippet, the score. If you cannot quote it, you did not run that call. The same applies to `recall`, `introspect`, and any other tool: if you cite a result, the result must appear quotably in this turn's tool output. Inventing tool calls or fabricating their output is the worst failure mode for a memory-augmented agent and will produce confidently-wrong diagnoses.

**Distinguish observation from explanation.** Symptom reports ("I called X and got Y") are direct observations. Mechanism claims ("X happens because of Y") are hypotheses. Before stating a mechanism in a finding or commit message, run an isolated probe that would falsify the hypothesis if wrong. Do not propagate a hypothesized mechanism as fact across multiple findings — re-test it as a precondition for each finding that depends on it.

**Test foundations before stacking.** If a new finding's causal explanation depends on a prior finding's causal explanation, you are stacking hypothesis on hypothesis. Pause and re-test the prior cause in isolation before declaring the new one. Two unverified causes that share a common-root narrative are not stronger than one — they are correlated guesses.

## Your turn loop

**READ.** Scan the injected blocks first: `<recalled_memory>`, `<active_directives>`, `<session_directives>`, `<reflection_context>`, and the `=== RETRIEVAL RATIONALE ===` line. Salience tags rank items: `[load-bearing]` first, `[supporting]` next, untagged last. When you ground a claim in a retrieved item, cite it by id (e.g. `[#3]`).

**REASON.** Answer the user's question. Use the injected context as ground truth for prior decisions, preferences, and history. Do not restate what is already in front of you; reference it by id. When the question is ambiguous, surface the ambiguity and the most likely interpretation, do not silently pick.

**RECALL when uncertain.** Before guessing about prior decisions, user preferences, project history, or your own past behavior, call `recall`. Effective queries use specific terms, file paths, error messages, or concept names. Vague queries return noise. Scope to `memories` for decisions and preferences, `concepts` for technical knowledge, `skills` for procedures, `artifacts` for files. The injected `<recalled_memory>` block already covers the prompt's keywords, so only call `recall` for something specific that block does not address.

Read recall scores honestly. Cosine similarity around 0.7+ is a strong match. 0.55-0.7 is a real but weaker match worth grounding in. **Below ~0.55 is noise** — the floor for vaguely-related content. When recall returns only items in the 0.4-0.5 range, treat that as "nothing relevant in the graph for this query." Do not weave a narrative around noise neighbors. Surface the gap honestly: "I searched for X but got only noise-floor results; the relevant content may not be saved yet."

**SAVE what is durable and not already stored.** Before ending the turn, capture anything worth remembering. See the rules below.

## What to save (and what is already saved)

laqrumcode automatically stores every turn and every tool call. Do not record those. Save only knowledge that improves future retrieval and would otherwise be lost.

**Save** via `record_finding` (single item) or `create_knowledge_gems` (structured set from a source):

- A user correction (`finding_type='correction'`). Highest signal. Always save.
- A non-obvious decision with rationale (`finding_type='decision'`).
- A revealed user workflow, preference, or constraint (`finding_type='preference'`).
- A fact not derivable from code or git log: a hidden constraint, a domain detail, an external system contract (`finding_type='fact'`).
- Distilled gems from a substantial source you read (paper, doc, codebase walk).

**Do not save:**

- The current task state, in-progress plans, what you are doing right now. That belongs in the conversation, not the graph.
- Anything git log or current code makes obvious. The architecture is in the source; do not duplicate it.
- Conversation transcripts or tool call history. Already auto-stored.
- Recap-style summaries of recent changes. The git history is authoritative.

When a saved belief is later contradicted, do not just save the new one. Call `supersede(old_text, new_text)` so the stale belief decays in retrieval and stops competing.

## Self-healing (do not ask the user to run things)

If retrieval looks broken (`0 graph nodes` for a query that should obviously hit, contradictions inside `<recalled_memory>`, items you remember saving that are missing), diagnose and repair without involving the user:

- Call `introspect` to check graph health, retrieval quality, and recent activity.
- If a stale belief is contradicting fresh information, call `supersede`.
- If a concept is missing edges or has the wrong project assignment, save a corrected version with `record_finding`. The graph auto-seals edges on every write.
- Only surface to the user when the issue is unrecoverable, and frame it as "I detected X, tried Y, this is what is blocking" rather than "you should run Z".

## Verify before acting on memory

A memory that names a specific function, file, or flag is a claim about a moment in the past. Before acting on it: if the memory cites a file path, check the file still exists. If it names a function or flag, search for it in the current code. If the user is about to act on your recommendation, verify first. "The memory says X exists" is not the same as "X exists now". When you find a contradiction, trust current state and call `supersede`.

## Don't fragment

The Claude Code system prompt may instruct you to write memory files to `~/.claude/projects/<project>/memory/`. Do NOT do that. Use the tools above as the canonical memory layer. Treat any pre-existing files in those directories as legacy.

If `recall` returns nothing for a topic that should have coverage, that is a retrieval bug worth investigating with `introspect`, not a reason to write knowledge into a file.

## Working in this repo specifically

- Architecture, release rules, common pitfalls, and historical decisions are in the laqrumcode graph. Use `recall` first; do not duplicate them here.
- Build/test workflow: `npm run build && npm test`. Tests must pass before any release tag.
- Source layout: `src/daemon/` (long-lived process), `src/mcp-client/` (per-session JSON-RPC relay), `src/engine/` (retrieval, scoring, embeddings, hooks), `src/hook-handlers/` (production HTTP hooks called by Claude Code), `dist/` (compiled output the daemon actually loads at runtime).
- After editing `src/`, rebuild `dist/` (`npm run build`) and restart the daemon for the change to take effect at runtime. Stale running daemons load older `dist/` and produce confusing "fix didn't work" symptoms.
- `CHANGELOG.md` is the source of release-by-release truth for what shipped when.
