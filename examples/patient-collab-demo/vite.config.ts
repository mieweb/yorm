import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The @esheet packages come from the vendor/eSheet git submodule, built from
 * source (`pnpm esheet:build`) and aliased to their dist entry points. `file:`
 * dependencies can't be used: the submodule packages reference each other by
 * unpublished versions, which pnpm would try to fetch from the registry.
 * Their runtime deps resolve from vendor/eSheet/node_modules (npm workspace).
 */
const esheetDist = (pkg: string): string =>
  fileURLToPath(new URL(`../../vendor/eSheet/packages/${pkg}/dist/index.js`, import.meta.url));

// The eSheet packages declare their own React copy; dedupe pins everything to
// this example's React 18 install so hooks share one dispatcher.
export default defineConfig({
  plugins: [react()],
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: {
      "@esheet/core": esheetDist("core"),
      "@esheet/renderer": esheetDist("renderer"),
      "@esheet/builder": esheetDist("builder"),
    },
  },
  build: { outDir: "dist" },
  server: {
    port: 5173,
    proxy: {
      "/yorm": { target: "http://localhost:5178", ws: true },
      "/api": { target: "http://localhost:5178" },
    },
  },
});
