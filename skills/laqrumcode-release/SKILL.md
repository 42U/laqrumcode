---
name: laqrumcode-release
description: End-to-end procedural skill for shipping a new laqrumcode version. Bumps all 6 version surfaces atomically, commits, tags, pushes, and verifies CI green with the correct exit-code pattern. Use BEFORE running `git push` on a release commit, not after.
---

Body in laqrumcode DB. Call `mcp__plugin_laqrumcode_laqrumcode__get_skill_body` with `name="laqrumcode-release"` to load full instructions.
