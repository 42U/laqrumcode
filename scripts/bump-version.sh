#!/usr/bin/env bash
# Bump all version surfaces atomically.
# Usage: ./scripts/bump-version.sh 0.7.59
set -euo pipefail

if [ -z "${1:-}" ]; then
  echo "Usage: $0 <version>"
  echo "Example: $0 0.7.59"
  exit 1
fi

VERSION="$1"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TODAY=$(date +%Y-%m-%d)

echo "Bumping to v${VERSION}..."

# --- CHANGELOG gate ---
# Require that CHANGELOG.md has a section for this version before bumping.
# If [Unreleased] has content and no version section exists, promote it.
CHANGELOG="$ROOT/CHANGELOG.md"

if grep -q "## \[${VERSION}\]" "$CHANGELOG"; then
  echo "  CHANGELOG: section [${VERSION}] already exists ✓"
else
  # Check if [Unreleased] has content (non-blank lines between ## [Unreleased] and the next ## [)
  UNRELEASED_CONTENT=$(sed -n '/^## \[Unreleased\]/,/^## \[/{/^## \[/d;/^$/d;p;}' "$CHANGELOG")
  if [ -n "$UNRELEASED_CONTENT" ]; then
    echo "  CHANGELOG: promoting [Unreleased] → [${VERSION}] — ${TODAY}"
    sed -i "s/^## \[Unreleased\]/## [Unreleased]\n\n## [${VERSION}] — ${TODAY}/" "$CHANGELOG"
  else
    echo ""
    echo "  ERROR: CHANGELOG.md has no [${VERSION}] section and [Unreleased] is empty."
    echo "  Document what changed before bumping. Add entries under ## [Unreleased]"
    echo "  or create a ## [${VERSION}] — ${TODAY} section manually, then re-run."
    echo ""
    exit 1
  fi
fi

# 1. package.json
sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"${VERSION}\"/" "$ROOT/package.json"

# 2. .claude-plugin/plugin.json
sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"${VERSION}\"/" "$ROOT/.claude-plugin/plugin.json"

# 3. DAEMON_VERSION in src/daemon/index.ts is now dynamic (reads package.json
#    at runtime, or __LAQRUMCODE_VERSION__ injected by esbuild --define at bundle
#    time). No source bump needed; staleness check below skips it for the same
#    reason.

# 4. CLIENT_VERSION in src/mcp-client/index.ts
sed -i "s/const CLIENT_VERSION = \"[^\"]*\"/const CLIENT_VERSION = \"${VERSION}\"/" "$ROOT/src/mcp-client/index.ts"

# 5. README.md version badge (use | delimiter to avoid clashing with URL slashes)
sed -i -E "s|badge/v[0-9]+\.[0-9]+\.[0-9]+-stable|badge/v${VERSION}-stable|" "$ROOT/README.md"

# 6. README.md tests badge — read current passing count from last test run
TEST_COUNT=$(cd "$ROOT" && npm test 2>&1 | grep -oP '\d+ passed' | tail -1 | grep -oP '\d+' || echo "")
if [ -n "$TEST_COUNT" ]; then
  sed -i -E "s|Tests-[0-9]+_passing|Tests-${TEST_COUNT}_passing|" "$ROOT/README.md"
  echo "  Tests badge: ${TEST_COUNT} passing"
fi

# 7. Rebuild dist/
(cd "$ROOT" && npm run build)

# --- Staleness check ---
# Verify no version surface was missed. Compare what the script just wrote
# against what's on disk. This catches new surfaces added to the codebase
# but not yet wired into this script.
STALE=""
grep -q "\"version\": \"${VERSION}\"" "$ROOT/package.json" || STALE="${STALE}  package.json\n"
grep -q "\"version\": \"${VERSION}\"" "$ROOT/.claude-plugin/plugin.json" || STALE="${STALE}  plugin.json\n"
# DAEMON_VERSION is dynamic (reads package.json at runtime). No hardcoded literal to check.
grep -q "CLIENT_VERSION = \"${VERSION}\"" "$ROOT/src/mcp-client/index.ts" || STALE="${STALE}  CLIENT_VERSION\n"
grep -q "badge/v${VERSION}-stable" "$ROOT/README.md" || STALE="${STALE}  README version badge\n"
grep -q "## \[${VERSION}\]" "$CHANGELOG" || STALE="${STALE}  CHANGELOG.md\n"

if [ -n "$STALE" ]; then
  echo ""
  echo "  WARNING: These surfaces still show a stale version:"
  echo -e "$STALE"
  echo "  Fix them before committing."
  exit 1
fi

# 8. Commit, tag, and push
git -C "$ROOT" add -A
git -C "$ROOT" commit -m "chore: bump to v${VERSION}"
git -C "$ROOT" tag "v${VERSION}"
echo ""
echo "  package.json:          ${VERSION}"
echo "  plugin.json:           ${VERSION}"
echo "  DAEMON_VERSION:        ${VERSION} (dynamic from package.json)"
echo "  CLIENT_VERSION:        ${VERSION}"
echo "  README badge:          v${VERSION}"
echo "  CHANGELOG:             [${VERSION}] — ${TODAY}"
echo ""
echo "Done. Run 'git push origin master --tags' to publish."
