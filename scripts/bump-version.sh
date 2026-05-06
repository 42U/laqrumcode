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

echo "Bumping to v${VERSION}..."

# 1. package.json
sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"${VERSION}\"/" "$ROOT/package.json"

# 2. .claude-plugin/plugin.json
sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"${VERSION}\"/" "$ROOT/.claude-plugin/plugin.json"

# 3. DAEMON_VERSION in src/daemon/index.ts
sed -i "s/const DAEMON_VERSION = \"[^\"]*\"/const DAEMON_VERSION = \"${VERSION}\"/" "$ROOT/src/daemon/index.ts"

# 4. CLIENT_VERSION in src/mcp-client/index.ts
sed -i "s/const CLIENT_VERSION = \"[^\"]*\"/const CLIENT_VERSION = \"${VERSION}\"/" "$ROOT/src/mcp-client/index.ts"

# 5. README.md version badge
sed -i -E "s/badge\/v[0-9]+\.[0-9]+\.[0-9]+-stable/badge\/v${VERSION}-stable/" "$ROOT/README.md"

# 6. README.md tests badge — read current passing count from last test run
TEST_COUNT=$(cd "$ROOT" && npm test 2>&1 | grep -oP '\d+ passed' | grep -oP '\d+' || echo "")
if [ -n "$TEST_COUNT" ]; then
  sed -i -E "s/Tests-[0-9]+_passing/Tests-${TEST_COUNT}_passing/" "$ROOT/README.md"
  echo "  Tests badge: ${TEST_COUNT} passing"
fi

# 7. Rebuild dist/
(cd "$ROOT" && npm run build)

# 8. Commit, tag, and push
git -C "$ROOT" add -A
git -C "$ROOT" commit -m "chore: bump to v${VERSION}"
git -C "$ROOT" tag "v${VERSION}"
echo ""
echo "  package.json:          ${VERSION}"
echo "  plugin.json:           ${VERSION}"
echo "  DAEMON_VERSION:        ${VERSION}"
echo "  CLIENT_VERSION:        ${VERSION}"
echo "  README badge:          v${VERSION}"
echo ""
echo "Done. Run 'git push origin master --tags' to publish."
