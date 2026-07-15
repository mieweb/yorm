import { defineConfig } from "@playwright/test";

// The specs share one server, one SQLite database, and one Patient document
// (the projection trigger policy is per-document), so they run serially.
// E2E gets its own port (5179): any manually opened demo tab on 5178 would
// reconnect to the test server and merge its stale CRDT history over the
// test document (two Y.Docs with no shared history merge as concurrent).
const E2E_PORT = 5179;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: { baseURL: `http://localhost:${E2E_PORT}` },
  webServer: {
    command: "pnpm run e2e:server",
    port: E2E_PORT,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: { PORT: String(E2E_PORT) },
  },
});
