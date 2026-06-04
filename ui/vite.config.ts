import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import { fileURLToPath } from "node:url";

// Root + outDir pinned to absolute paths so `vite build -c ui/vite.config.ts`
// works regardless of cwd. base "/ui/" matches how the daemon's ui-server
// serves the bundle (src/ui-server.ts). Everything is bundled (no CDN) to honor
// the offline constraint in GH #15.
const here = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: here,
  base: "/ui/",
  plugins: [preact()],
  build: {
    outDir: fileURLToPath(new URL("../dist/ui", import.meta.url)),
    emptyOutDir: true,
    target: "es2020",
    chunkSizeWarningLimit: 1200,
  },
});
