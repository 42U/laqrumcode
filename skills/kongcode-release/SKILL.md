---
name: kongcode-release
description: End-to-end procedural skill for shipping a new kongcode version. Bumps all 6 version surfaces atomically, commits, tags, pushes, and verifies CI green with the correct exit-code pattern. Use BEFORE running `git push` on a release commit, not after.
---

Body in kongcode DB. Call `mcp__plugin_kongcode_kongcode__get_skill_body` with `name="kongcode-release"` to load full instructions.
