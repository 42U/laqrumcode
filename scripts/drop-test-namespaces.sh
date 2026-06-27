#!/usr/bin/env bash
# Drop ONLY the ephemeral vitest temp namespaces + the old-brand test ns from the
# :8000 SurrealDB instance. Targets: kctest_* and kong_test.
# NEVER touches kong / laqrum / laqrum_test / main.
set -euo pipefail
URL="http://127.0.0.1:8000/sql"

mapfile -t NS < <(curl -s -X POST "$URL" -u root:root --data "INFO FOR ROOT;" \
  | grep -oE 'DEFINE NAMESPACE (kctest_[A-Za-z0-9_]+|kong_test)' | awk '{print $3}' | sort -u)

echo "Dropping ${#NS[@]} test namespaces (keeping kong / laqrum / laqrum_test / main):"
printf '  %s\n' "${NS[@]}"

for ns in "${NS[@]}"; do
  printf '  dropping %s ... ' "$ns"
  curl -s -X POST "$URL" -u root:root --data "REMOVE NAMESPACE IF EXISTS \`$ns\`;" >/dev/null && echo ok
done

echo "Done. Remaining namespaces:"
curl -s -X POST "$URL" -u root:root --data "INFO FOR ROOT;" \
  | grep -oE 'DEFINE NAMESPACE [A-Za-z0-9_]+' | awk '{print "  "$3}'
