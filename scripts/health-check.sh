#!/usr/bin/env bash
# LaqrumCode health check — quick connectivity diagnostics.
set -euo pipefail

# SurrealDB URL discovery:
#   1. SURREAL_URL env var (explicit override — used by BYO-server setups)
#   2. LAQRUMCODE_SURREAL_PORT (overrides the bootstrap-managed default 18765)
#   3. Bootstrap default: ws://127.0.0.1:18765/rpc
# Note: the legacy ws://localhost:8000/rpc default was retired in 0.6.0 when
# the bootstrap started managing its own SurrealDB child process.
DEFAULT_PORT="${LAQRUMCODE_SURREAL_PORT:-18765}"
SURREAL_URL="${SURREAL_URL:-ws://127.0.0.1:${DEFAULT_PORT}/rpc}"
HTTP_URL=$(echo "$SURREAL_URL" | sed 's|ws://|http://|' | sed 's|wss://|https://|' | sed 's|/rpc|/health|')

STATUS="OK"

# SurrealDB
if curl -sf --max-time 3 "$HTTP_URL" >/dev/null 2>&1; then
  echo "SurrealDB: connected (${SURREAL_URL})"
else
  echo "SurrealDB: UNREACHABLE (${SURREAL_URL})"
  STATUS="DEGRADED"
fi

# MCP Server socket. The MCP writes per-PID sockets to $HOME/.laqrumcode-<pid>.sock
# to avoid races between multiple concurrent MCP processes (introduced for
# multi-MCP support). hook-proxy.sh enumerates these by mtime + alive-PID; we
# do a simpler "any responsive socket counts" probe here.
SOCK_FOUND=0
for sock in "$HOME"/.laqrumcode-*.sock; do
  [ -S "$sock" ] || continue
  if curl -sf --unix-socket "$sock" --max-time 2 "http://localhost/health" >/dev/null 2>&1; then
    echo "MCP Server: running (${sock})"
    SOCK_FOUND=1
    break
  fi
done
if [ "$SOCK_FOUND" -eq 0 ]; then
  echo "MCP Server: not running (no responsive socket under \$HOME/.laqrumcode-*.sock)"
  STATUS="DEGRADED"
fi

# Embedding model. 0.6.0 default lives under the laqrumcode cache dir
# (~/.laqrumcode/cache/models/bge-m3-Q4_K_M.gguf); legacy default
# (~/.node-llama-cpp/models/bge-m3-q4_k_m.gguf) checked as a fallback so users
# upgrading from earlier installs don't see a false negative.
DEFAULT_CACHE="${LAQRUMCODE_CACHE_DIR:-$HOME/.laqrumcode/cache}"
MODEL_PATH="${EMBED_MODEL_PATH:-$DEFAULT_CACHE/models/bge-m3-Q4_K_M.gguf}"
if [ ! -f "$MODEL_PATH" ] && [ -f "$HOME/.node-llama-cpp/models/bge-m3-q4_k_m.gguf" ]; then
  MODEL_PATH="$HOME/.node-llama-cpp/models/bge-m3-q4_k_m.gguf"
fi
if [ -f "$MODEL_PATH" ]; then
  SIZE=$(du -h "$MODEL_PATH" | cut -f1)
  echo "Embedding model: loaded (${SIZE} at ${MODEL_PATH})"
else
  echo "Embedding model: not downloaded yet"
fi

echo ""
echo "Overall: ${STATUS}"
