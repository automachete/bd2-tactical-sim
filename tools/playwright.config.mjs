import { defineConfig } from "@playwright/test";

const port = Number(process.env.BD2_PLAYWRIGHT_PORT ?? 8771);

export default defineConfig({
  testDir: "../ui/tests/e2e",
  outputDir: `test-results-${port}`,
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 5_000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: `..\\.venv\\Scripts\\bd2-play.exe --no-open --port ${port} --mcts-simulations 3 --mcts-rollout-depth 2 --mcts-max-branching 5 --character-profile-path ..\\data\\generated\\e2e-character-profiles-${port}.json`,
    url: `http://127.0.0.1:${port}/api/state`,
    timeout: 30_000,
    reuseExistingServer: true,
  },
});
