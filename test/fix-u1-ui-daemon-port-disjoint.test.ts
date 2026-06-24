/**
 * U1 regression guard: the read-only UI server port window (ui-server.ts
 * UI_PORT_BASE/uiPort()) must be DISJOINT from the daemon's loopback IPC port
 * window (daemon-spawn.ts PORT_OFFSET_BASE + hash%PORT_OFFSET_RANGE).
 *
 * Round-7's T3 raised the IPC window to [28765, 32764]; the UI default was
 * 28900 + uid%10000, which overlapped it, so ~1/4000 TCP-transport users
 * (always Windows; or POSIX with LAQRUMCODE_DAEMON_TRANSPORT=tcp) got a working
 * daemon whose web UI silently failed to bind (EADDRINUSE — non-fatal, but the
 * UI never came up). U1 moved UI_PORT_BASE to 33000, just above the IPC ceiling.
 *
 * Pure constant/derivation assertions — no DB, no sockets.
 */
import { describe, it, expect } from "vitest";
import { uiPort, UI_PORT_BASE } from "../src/ui-server.js";
import { PORT_OFFSET_BASE, PORT_OFFSET_RANGE } from "../src/mcp-client/daemon-spawn.js";

const IPC_LO = PORT_OFFSET_BASE; // 28765
const IPC_HI = PORT_OFFSET_BASE + PORT_OFFSET_RANGE; // 32765 (exclusive upper bound of the IPC window)
const UI_WINDOW = 10000; // uiPort = UI_PORT_BASE + uid%10000

describe("U1: UI port window is disjoint from the daemon IPC port window", () => {
  it("the UI window starts at or above the daemon IPC window ceiling (drift-proof, both bases from source)", () => {
    // The load-bearing invariant: no UI port for any uid can land in the IPC
    // window. UI window = [UI_PORT_BASE, UI_PORT_BASE + UI_WINDOW); it is wholly
    // above the IPC window iff UI_PORT_BASE >= IPC_HI.
    expect(UI_PORT_BASE).toBeGreaterThanOrEqual(IPC_HI);
  });

  it("the daemon IPC window stays below the 32768 ephemeral floor (IPC is load-bearing)", () => {
    // The IPC port MUST bind (a transient ephemeral squatter would be fatal), so
    // it must stay below the OS ephemeral floor. The UI port may sit above it
    // (it is non-fatal on conflict) — that's why the UI window goes ABOVE, not
    // into the [IPC_HI, 32768) sliver.
    expect(IPC_HI).toBeLessThanOrEqual(32768);
  });

  it("uiPort() for the live uid does not fall inside the IPC window", () => {
    const saved = process.env.LAQRUMCODE_UI_PORT;
    delete process.env.LAQRUMCODE_UI_PORT;
    try {
      const p = uiPort();
      expect(p < IPC_LO || p >= IPC_HI).toBe(true);
    } finally {
      if (saved !== undefined) process.env.LAQRUMCODE_UI_PORT = saved;
    }
  });

  it("no uid in [0, UI_WINDOW) maps a UI port into the IPC window", () => {
    for (let uid = 0; uid < UI_WINDOW; uid += 137) {
      const p = UI_PORT_BASE + (uid % UI_WINDOW);
      expect(p < IPC_LO || p >= IPC_HI).toBe(true);
    }
  });

  it("an explicit LAQRUMCODE_UI_PORT override is honored verbatim", () => {
    const saved = process.env.LAQRUMCODE_UI_PORT;
    process.env.LAQRUMCODE_UI_PORT = "29999";
    try {
      expect(uiPort()).toBe(29999);
    } finally {
      if (saved !== undefined) process.env.LAQRUMCODE_UI_PORT = saved;
      else delete process.env.LAQRUMCODE_UI_PORT;
    }
  });
});
