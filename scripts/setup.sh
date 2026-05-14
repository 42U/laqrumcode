#!/usr/bin/env bash
# KongCode setup — checks prerequisites and guides initial configuration.
set -euo pipefail

echo "=== KongCode Setup ==="
echo ""

# ──────────────────────────────────────────────────────────────────────────
# Credential bootstrap: generate a random root password on first install so
# we never advise the user to run SurrealDB with the documented default
# `--user root --pass root` combo. Stored in ~/.kongcode/cache/surreal-creds
# with 0o600 so only the invoking user can read it. The daemon picks the
# creds up via SURREAL_USER / SURREAL_PASS env vars (parsePluginConfig).
# ──────────────────────────────────────────────────────────────────────────
CREDS_DIR="${HOME}/.kongcode/cache"
CREDS_FILE="${CREDS_DIR}/surreal-creds"
if [ ! -f "$CREDS_FILE" ]; then
  # umask 077 BEFORE mkdir so the cache dir is created 0o700 directly. Setting
  # umask after mkdir leaves the dir at whatever the user's default mask gives
  # (often 0o755), exposing the directory listing — the file inside is still
  # chmodded 600 below, but a 0o755 parent dir leaks the auth-token filename
  # to other local users.
  umask 077
  mkdir -p "$CREDS_DIR"
  # 32 url-safe chars; openssl rand is available on macOS + every Linux distro
  # this script targets. Fallback to /dev/urandom + tr if openssl is missing.
  if command -v openssl >/dev/null 2>&1; then
    GEN_PASS=$(openssl rand -base64 24 | tr -d '=+/' | head -c 32)
  else
    GEN_PASS=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32)
  fi
  {
    echo "SURREAL_USER=kongcode"
    echo "SURREAL_PASS=${GEN_PASS}"
  } > "$CREDS_FILE"
  chmod 600 "$CREDS_FILE"
  echo "  [OK] Generated random Surreal root credentials at ${CREDS_FILE}"
  echo "       Export them before starting the daemon:  set -a; source ${CREDS_FILE}; set +a"
else
  chmod 600 "$CREDS_FILE" 2>/dev/null || true
  echo "  [OK] Surreal credentials already provisioned at ${CREDS_FILE}"
fi
# Source for this shell so the launch hints below can quote the real values.
# shellcheck disable=SC1090
set -a; . "$CREDS_FILE"; set +a

# Check SurrealDB
SURREAL_URL="${SURREAL_URL:-ws://localhost:8000/rpc}"
HTTP_URL=$(echo "$SURREAL_URL" | sed 's|ws://|http://|' | sed 's|wss://|https://|' | sed 's|/rpc|/health|')

echo "Checking SurrealDB at ${SURREAL_URL}..."
if curl -sf --max-time 3 "$HTTP_URL" >/dev/null 2>&1; then
  echo "  [OK] SurrealDB is running"
else
  echo "  [MISSING] SurrealDB not reachable at ${SURREAL_URL}"
  echo ""
  echo "  Install SurrealDB:"
  # SECURITY: bind to 127.0.0.1 only — anything broader (0.0.0.0, LAN IP)
  # exposes the database to other hosts. The default root/root credentials
  # in the SurrealDB docs become a remote-root-shell on any reachable network
  # the moment the daemon starts. Loopback + the random password generated
  # above is the safe combo. If you genuinely need remote access, put a
  # reverse proxy with TLS + auth in front; do NOT bind 0.0.0.0 directly.
  echo "    Docker:  docker run -d --name surrealdb -p 127.0.0.1:8000:8000 surrealdb/surrealdb:latest \\"
  echo "               start --user \"\${SURREAL_USER}\" --pass \"\${SURREAL_PASS}\""
  echo "    Native:  curl -sSf https://install.surrealdb.com | sh && \\"
  echo "             surreal start --user \"\${SURREAL_USER}\" --pass \"\${SURREAL_PASS}\" --bind 127.0.0.1:8000"
  echo ""
  echo "  NOTE: the env vars above come from ${CREDS_FILE}; \`set -a; . \"${CREDS_FILE}\"; set +a\`"
  echo "        loads them into the current shell before launching SurrealDB."
  echo ""
fi

# Check ANTHROPIC_API_KEY
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  echo "  [OK] ANTHROPIC_API_KEY is set"
else
  echo "  [OPTIONAL] ANTHROPIC_API_KEY not set — daemon extraction will be disabled"
  echo "    Set it for automatic knowledge extraction: export ANTHROPIC_API_KEY=sk-ant-..."
fi

# Check embedding model
MODEL_PATH="${EMBED_MODEL_PATH:-$HOME/.node-llama-cpp/models/bge-m3-q4_k_m.gguf}"
if [ -f "$MODEL_PATH" ]; then
  echo "  [OK] Embedding model found at ${MODEL_PATH}"
else
  echo "  [INFO] Embedding model will auto-download on first use (~420MB)"
fi

echo ""
echo "Setup complete. Start Claude Code with this plugin to begin."
