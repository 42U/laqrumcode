#!/bin/sh
# kongcode pre-push hook — gates pushes on the full vitest suite.
#
# Install from a fresh clone:
#   cp scripts/pre-push-hook.sh .git/hooks/pre-push && chmod +x .git/hooks/pre-push
#
# What it does:
#   - Runs `npm test` (the same suite CI runs).
#   - If any test fails, the push is aborted.
#   - On green, prints the canonical confirmation line so it's obvious in
#     terminal scrollback that the gate ran (not a no-op).
#
# Override (use sparingly — the founder rule QA-BEFORE-PUSH expects this
# gate to run on every push):
#   git push --no-verify       # skip the hook entirely
#
# Note: the gate intentionally does NOT run `npm run build` here. dist/ is
# expected to be committed alongside source per the kongcode-release skill
# (the ship-dist-with-source pattern). If you're pushing a release commit,
# run `npm run build && npm test` BEFORE staging dist/ so the committed
# artifacts match the source.

set -e

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

if [ ! -f package.json ]; then
  echo "[pre-push] package.json not found; skipping test gate" >&2
  exit 0
fi

# Run the suite. Vitest prints its own pass/fail summary; this hook just
# checks the exit code and prints a one-liner so it's visible in scrollback.
if npm test --silent; then
  echo "[pre-push] all tests pass — push proceeding."
  exit 0
else
  echo "[pre-push] TESTS FAILED — push aborted. Fix tests or override with --no-verify (not recommended)." >&2
  exit 1
fi
