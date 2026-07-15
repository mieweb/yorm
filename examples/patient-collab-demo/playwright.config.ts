import { defineConfig } from "@playwright/test";

// The specs share one server, one SQLite database, and one Patient document
// (the projection trigger policy is per-document), so they run serially.
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: { baseURL: "http://localhost:5178" },
  webServer: {
    command: "pnpm run e2e:server",
    port: 5178,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
