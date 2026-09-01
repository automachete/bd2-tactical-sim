import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "../ui/tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 5_000 },
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:8771",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "..\\.venv\\Scripts\\bd2-play.exe --no-open --port 8771 --mcts-simulations 3 --mcts-rollout-depth 2 --mcts-max-branching 5",
    url: "http://127.0.0.1:8771/api/state",
    timeout: 30_000,
    reuseExistingServer: true,
  },
});
