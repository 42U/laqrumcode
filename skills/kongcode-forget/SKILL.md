---
name: kongcode-forget
description: Selectively and REVERSIBLY forget stored memories/concepts (privacy / declutter) — soft-deactivate content matching a query or date so it stops surfacing in retrieval. Use when the user wants sensitive or unwanted data out of their kongcode graph.
---

# kongcode forget (reversible)

Soft-forget content so it stops surfacing in retrieval. Honors the D4 founder
rule — **nothing is deleted**; matching rows are soft-deactivated with an audit
annotation (`archive_reason='forget:…'`) and can be fully reactivated.

## Usage

```bash
node scripts/forget.mjs --query "api key"             # preview (DRY RUN)
node scripts/forget.mjs --query "api key" --commit    # apply
node scripts/forget.mjs --before 2026-01-01 --commit  # forget content older than a date
node scripts/forget.mjs --undo --commit               # reactivate everything forgotten by this tool
```

## Behavior

- **DRY RUN by default** — prints what *would* be forgotten (with samples); pass
  `--commit` to apply.
- **memory** → `status='archived'`; **concept** → `superseded_at` set — both with
  `archive_reason='forget:…'`. The retrieval pipeline already excludes these, so
  they stop surfacing immediately, with no change to the hot retrieval path.
- **Reversible**: `--undo --commit` reactivates everything this tool forgot.
- **Nothing is DELETEd** — rows survive for forensic recovery (D4).

## Scope (v1)

- Selectors: `--query` (case-insensitive substring) and `--before` (ISO date).
- Tables: `memory` + `concept` (the content tables whose retrieval candidate
  query already filters the deactivation flag).
- Planned follow-ups: `--project` / `--session` (edge-scoped) and never-remember
  redaction at ingestion (`privacy.json`).
- Env: `SURREAL_URL/USER/PASS/NS/DB` (same defaults as backup).
