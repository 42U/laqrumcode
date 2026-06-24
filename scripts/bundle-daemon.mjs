#!/usr/bin/env node
// Cross-platform bundle:daemon — the $(node -pe ...) subshell in the npm
// script doesn't execute on Windows (Git Bash passes it literally to esbuild).
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
execSync("npm run build", { stdio: "inherit" });
execSync(
  `npx esbuild src/daemon/index.ts --bundle --platform=node --target=node20 --format=cjs` +
  ` --outfile=dist/daemon/bundle.cjs --external:node-llama-cpp --external:@node-llama-cpp/*` +
  ` --define:__LAQRUMCODE_VERSION__=${JSON.stringify(JSON.stringify(version))}`,
  { stdio: "inherit" },
);
