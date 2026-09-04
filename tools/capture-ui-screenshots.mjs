import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { chromium, request } from "@playwright/test";

const baseURL = process.env.BD2_SCREENSHOT_BASE_URL ?? "http://127.0.0.1:8770";
const outputDirectory = resolve(
  process.env.BD2_SCREENSHOT_OUTPUT ?? "../docs/validation/ui-screenshots/baseline",
);
const viewport = { width: 1440, height: 900 };

await mkdir(outputDirectory, { recursive: true });

const api = await request.newContext({ baseURL });
const catalogResponse = await api.get("/api/catalog");
if (!catalogResponse.ok()) {
  throw new Error(`Unable to load the UI catalog: ${catalogResponse.status()}`);
}
const catalog = await catalogResponse.json();

const browser = await chromium.launch();
const page = await browser.newPage({ viewportSize: viewport });
page.on("pageerror", (error) => {
  throw error;
});

const startMode = async (mode) => {
  const setup = structuredClone(catalog.presets[mode]);
  setup.seed = 42;
  setup.mcts_simulations = 3;
  setup.mcts_rollout_depth = 2;
  setup.mcts_max_branching = 5;
  const response = await api.post("/api/start", { data: setup });
  if (!response.ok()) {
    throw new Error(`Unable to start ${mode}: ${response.status()} ${await response.text()}`);
  }
  await page.goto(baseURL);
  await page.getByTestId("simulator-shell").waitFor();
  await page.locator(".battle-token").first().waitFor();
  await page.screenshot({ path: resolve(outputDirectory, `${mode}.png`), fullPage: true });
};

for (const mode of ["NORMAL", "MIRROR_WAR", "MONSTER_CHASER", "GOLDEN_COLOSSEUM"]) {
  await startMode(mode);
}

await startMode("NORMAL");
const dialogs = [
  ["preparation", "#open-formation", "#formation-dialog"],
  ["character-profiles", "#open-character-profiles", "#character-profile-dialog"],
  ["pause", "#open-pause", "#pause-dialog"],
  ["battle-log", "#open-log", "#log-dialog"],
  ["help", "#open-help", "#help-dialog"],
];
for (const [name, trigger, dialog] of dialogs) {
  await page.locator(trigger).click();
  await page.locator(dialog).waitFor();
  await page.screenshot({ path: resolve(outputDirectory, `dialog-${name}.png`), fullPage: true });
  await page.locator(`${dialog} .dialog-close`).click();
}

await browser.close();
await api.dispose();

console.log(`Captured UI screenshots in ${outputDirectory}`);
