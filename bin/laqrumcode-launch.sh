#!/usr/bin/env sh
# laqrumcode platform dispatcher (POSIX shell — linux + macOS).
#
# Invoked by Claude Code's plugin loader via .mcp.json. Detects the host
# platform + arch, then execs the matching SEA binary that ships with the
# plugin. The whole point is to make the plugin install zero-Node-prereq:
# the SEA binary contains the Node runtime, so once Claude Code copies the
# plugin files in, no further user setup is needed.
#
# This script lives at <plugin>/bin/laqrumcode-launch.sh. The SEA binaries
# live at <plugin>/bin/laqrumcode-mcp-<os>-<arch> (e.g. laqrumcode-mcp-linux-x64,
# laqrumcode-mcp-darwin-arm64). The matching laqrumcode-daemon-<os>-<arch> is
# spawned by mcp-client when the daemon isn't already running.

set -eu

DIR="$(cd "$(dirname "$0")" && pwd)"

# Normalize OS name. Linux, Darwin (macOS), other → linux/darwin/(unsupported).
case "$(uname -s)" in
  Linux*)  OS="linux" ;;
  Darwin*) OS="darwin" ;;
  *)
    echo "laqrumcode: unsupported OS $(uname -s) — supported: linux, darwin, win32. File at https://github.com/42U/laqrumcode/issues" >&2
    exit 1
    ;;
esac

# Normalize arch. uname -m varies across distros: x86_64 / amd64 → x64;
# aarch64 / arm64 → arm64. Anything else is unsupported.
case "$(uname -m)" in
  x86_64|amd64) ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *)
    echo "laqrumcode: unsupported arch $(uname -m) — supported: x64, arm64. File at https://github.com/42U/laqrumcode/issues" >&2
    exit 1
    ;;
esac

BIN="$DIR/laqrumcode-mcp-${OS}-${ARCH}"

# Preferred path: SEA mcp-client binary is present (0.7.0+ release with
# CI-built artifacts). Zero-Node-prereq — the binary contains the Node
# runtime. mcp-client spawns the laqrumcode-daemon binary itself if needed.
if [ -x "$BIN" ]; then
  exec "$BIN" "$@"
fi

# Fallback: invoke the unbundled JS mcp-client via Node. Used when the SEA
# binary isn't present (0.6.x github-source install with no CI release
# artifacts, or a platform our CI matrix doesn't cover yet). Requires Node
# on PATH; setupRuntimeNodePath() inside the client will fail no-op since
# the cache dir won't exist yet either.
if command -v node >/dev/null 2>&1; then
  if [ -f "$DIR/../dist/mcp-client/index.js" ]; then
    exec node "$DIR/../dist/mcp-client/index.js" "$@"
  fi
  # 0.6.x legacy fallback for installs without the new client compiled.
  exec node "$DIR/../dist/mcp-server.js" "$@"
fi

echo "laqrumcode: no usable runtime found. Tried SEA binary at $BIN (not present) and 'node' (not on PATH). Install Node.js (https://nodejs.org) and restart Claude Code, or wait for a 0.7.0 release artifact for your platform (${OS}-${ARCH})." >&2
exit 1
