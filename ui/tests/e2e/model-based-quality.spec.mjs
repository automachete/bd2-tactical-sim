import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";

const toolsRequire = createRequire(new URL("../../../tools/package.json", import.meta.url));
const { expect, test } = toolsRequire("@playwright/test");

const sequenceCount = Number(process.env.BD2_GUI_QUALITY_SEQUENCES ?? 4);
const sequenceOffset = Number(process.env.BD2_GUI_QUALITY_OFFSET ?? 0);
const modes = ["NORMAL", "MIRROR_WAR", "MONSTER_CHASER", "GOLDEN_COLOSSEUM"];

const startMode = async (request, catalog, mode, seed) => {
  const setup = structuredClone(catalog.presets[mode]);
  setup.seed = seed;
  setup.mcts_simulations = 1;
  setup.mcts_rollout_depth = 2;
  setup.mcts_max_branching = 5;
  const response = await request.post("/api/start", { data: setup });
  expect(response.ok(), `${mode} seed ${seed}`).toBeTruthy();
};

const assertDomMatchesCore = async (page, request) => {
  const payload = await (await request.get("/api/state")).json();
  const state = payload.state;
  await expect(page.locator("#game-shell")).toHaveAttribute("data-mode", state.rules.mode, { timeout: 20_000 });
  await expect(page.locator("#turn-label")).toContainText(String(state.game_turn), { timeout: 20_000 });
  const dom = await page.evaluate(() => {
    const tokens = {};
    for (const token of document.querySelectorAll(".battle-token[data-unit-id]")) {
      const cell = token.parentElement;
      tokens[token.dataset.unitId] = {
        row: Number(cell?.dataset.row),
        depth: Number(cell?.dataset.depth),
      };
    }
    const firstCell = document.querySelector("#player-field .field-cell");
    const box = firstCell?.getBoundingClientRect();
    return {
      sp: document.querySelector("#sp-text")?.textContent?.trim(),
      tokens,
      grid: { width: box?.width ?? 0, height: box?.height ?? 0 },
      waitCommands: document.querySelectorAll("[data-command-type='WAIT']").length,
    };
  });
  expect(dom.sp).toBe(
    state.rules.mode === "GOLDEN_COLOSSEUM" ? "∞" : `${state.teams[0].sp} / 20`,
  );
  for (const unit of Object.values(state.units)) {
    if (!unit.alive) continue;
    if (unit.side === "PLAYER" && Number(unit.party_no || 1) !== Number(state.monster_chaser?.current_party || 1)) continue;
    expect(dom.tokens[String(unit.id)], `unit ${unit.id} board position`).toEqual(unit.position);
  }
  expect(Math.abs(dom.grid.width - dom.grid.height)).toBeLessThan(0.6);
  expect(dom.waitCommands).toBe(0);
  return payload;
};

const exercisePlanningControls = async (page, mode, sequence) => {
  if (mode === "GOLDEN_COLOSSEUM") return;
  const firstOrder = page.locator("#ally-rail .order-card:not(:disabled)").first();
  if (await firstOrder.count()) {
    await firstOrder.click();
    const commands = page.locator("#costume-strip .command-card:not(:disabled)");
    const commandCount = await commands.count();
    if (commandCount) await commands.nth(sequence % commandCount).click();
    if (sequence % 3 === 0) {
      const burstUp = page.locator("#costume-strip .burst-up:not(:disabled)").first();
      if (await burstUp.count()) await burstUp.click();
    }
  }
  if ((mode === "NORMAL" || mode === "MONSTER_CHASER") && sequence % 5 === 0) {
    const cards = page.locator("#ally-rail .order-card:not(:disabled)");
    if (await cards.count() > 1) await cards.first().dragTo(cards.last());
  }
  if ((mode === "NORMAL" || mode === "MONSTER_CHASER") && sequence % 7 === 0) {
    const token = page.locator("#player-field .battle-token").first();
    const empty = page.locator("#player-field .field-cell:not(:has(.battle-token))").last();
    if (await token.count() && await empty.count()) await token.dragTo(empty);
  }
};

test("model-based multi-turn GUI sequences stay synchronized with the battle core", async ({ page, request }) => {
  test.setTimeout(Math.max(120_000, sequenceCount * 20_000));
  await page.addInitScript(() => {
    const nativeTimeout = window.setTimeout.bind(window);
    window.setTimeout = (callback, delay = 0, ...args) =>
      nativeTimeout(callback, Math.min(Number(delay), 2), ...args);
  });
  const browserErrors = [];
  const networkErrors = [];
  let operationContext = "startup";
  page.on("pageerror", error => browserErrors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("response", async response => {
    if (response.status() >= 400) {
      let body = "<response body unavailable after navigation>";
      try {
        body = await response.text();
      } catch {
        // Navigation may dispose a superseded preview response before DevTools
        // can expose its body. The status and operation context still remain evidence.
      }
      networkErrors.push(`${operationContext}: ${response.status()} ${response.url()} ${body}`);
    }
  });
  const catalog = await (await request.get("/api/catalog")).json();
  let completedTurns = 0;
  for (let localSequence = 0; localSequence < sequenceCount; localSequence += 1) {
    const sequence = sequenceOffset + localSequence;
    const mode = modes[sequence % modes.length];
    const seed = 10_000 + sequence * 7_919;
    operationContext = `${mode} sequence=${sequence} seed=${seed} start`;
    // Tear down the previous document before replacing the server-side session;
    // otherwise a legitimate preview from that document can race the new setup.
    await page.goto("about:blank");
    await startMode(request, catalog, mode, seed);
    await page.goto("/");
    await expect(page.locator("#game-shell")).toBeVisible();
    await assertDomMatchesCore(page, request);
    await exercisePlanningControls(page, mode, sequence);
    await page.getByTestId("speed").click();
    await page.getByTestId("speed").click();

    for (let turn = 0; turn < 2; turn += 1) {
      operationContext = `${mode} sequence=${sequence} seed=${seed} turn=${turn}`;
      const before = await (await request.get("/api/state")).json();
      if (before.state.terminal) break;
      await page.getByTestId("battle-start").click();
      await expect.poll(async () => {
        const current = await (await request.get("/api/state")).json();
        return current.state.action_sequence;
      }, { timeout: 20_000 }).toBeGreaterThan(before.state.action_sequence);
      const after = await assertDomMatchesCore(page, request);
      await expect(page.locator("#game-shell")).not.toHaveClass(/executing/, { timeout: 20_000 });
      expect(after.state.action_sequence).toBeGreaterThan(before.state.action_sequence);
      completedTurns += 1;
      if (after.state.terminal) break;
      await exercisePlanningControls(page, mode, sequence + turn + 1);
    }
  }
  expect(completedTurns).toBeGreaterThanOrEqual(sequenceCount);
  expect({ browserErrors, networkErrors }).toEqual({ browserErrors: [], networkErrors: [] });
  const report = {
    schema: "bd2-gui-model-quality-v1",
    sequences: sequenceCount,
    sequenceOffset,
    completedTurns,
    modes,
    failures: 0,
    status: "ok",
  };
  if (process.env.BD2_GUI_QUALITY_REPORT) {
    await writeFile(process.env.BD2_GUI_QUALITY_REPORT, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  console.log(JSON.stringify(report));
});
