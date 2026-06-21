---
name: kongcode-web-ui
description: Open the kongcode read-only web UI to explore the memory graph (dashboard, memory/concept browsers, graph explorer) in a browser. Use when the user asks to see/visualize/inspect what kongcode has stored.
---

# kongcode web UI (read-only)

A local, read-only web UI for exploring the kongcode memory graph (GH #15, v1):
**Dashboard** (record counts + embedding coverage), **Memory browser**,
**Concept browser**, and an interactive **Graph explorer**.

## Launch

```bash
node scripts/open-ui.mjs
```

This reads the daemon's auth token (`~/.kongcode/cache/auth-token`) and opens
`http://127.0.0.1:<port>/ui` in the browser. The default port is
`33000 + (uid % 10000)` (kept above the daemon's IPC port window); override
with `KONGCODE_UI_PORT`.

## Requirements

- The kongcode daemon must be running (any MCP call spins it up). The UI server
  is part of the daemon — a dedicated `127.0.0.1`-only TCP listener, separate
  from the Unix-socket hook API.
- It is **read-only**: the browser never mutates the graph (write surfaces are a
  later increment). All access requires the daemon's bearer token, presented as
  an HttpOnly cookie.

## Notes

- Bound to loopback only; never exposed off-host.
- Set `KONGCODE_UI=0` to disable the UI server in the daemon entirely.
