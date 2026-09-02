import { createRequire } from "node:module";

const toolsRequire = createRequire(new URL("../../../tools/package.json", import.meta.url));
const { expect, test } = toolsRequire("@playwright/test");

const startMode = async (request, mode = "NORMAL") => {
  const catalogResponse = await request.get("/api/catalog");
  const catalog = await catalogResponse.json();
  const setup = structuredClone(catalog.presets[mode]);
  setup.seed = 42;
  setup.mcts_simulations = 3;
  setup.mcts_rollout_depth = 2;
  setup.mcts_max_branching = 5;
  const response = await request.post("/api/start", { data: setup });
  expect(response.ok()).toBeTruthy();
};

const openBattle = async (page, request, mode = "NORMAL") => {
  await startMode(request, mode);
  await page.goto("/");
  await expect(page.getByTestId("player-token-1")).toBeVisible();
};

const maximumLoadout = character => character.costumes.map(costume => ({
  costume_id: costume.id,
  enhancement: costume.max_enhancement,
  burst_level: costume.max_burst_level,
  potential_mask: costume.max_potential_mask,
  permanent_potential_enabled: true,
}));

const startWithCharacter = async (request, characterId) => {
  const catalog = await (await request.get("/api/catalog")).json();
  const setup = structuredClone(catalog.presets.NORMAL);
  const character = catalog.characters.find(item => item.id === characterId);
  setup.player_units = [
    setup.player_units[0],
    ...setup.player_units.slice(1).filter(unit => unit.character_id !== characterId),
  ];
  setup.player_units[0].character_id = character.id;
  setup.player_units[0].costumes = maximumLoadout(character);
  setup.mcts_simulations = 3;
  const response = await request.post("/api/start", { data: setup });
  expect(response.ok()).toBeTruthy();
};

test.beforeEach(async ({ page, request }) => {
  await openBattle(page, request, "NORMAL");
});

test("renders a single top-down battlefield with two complete 3x4 grids", async ({ page }) => {
  await expect(page.getByTestId("topdown-stage")).toHaveCount(1);
  await expect(page.locator("#player-field .field-cell")).toHaveCount(12);
  await expect(page.locator("#enemy-field .field-cell")).toHaveCount(12);
  await expect(page.locator("#view-toggle")).toHaveCount(0);
});

test("loads generated token portraits only from local 64px PNG assets", async ({ page, request }) => {
  const portraits = page.locator("img.character-portrait");
  expect(await portraits.count()).toBeGreaterThan(0);
  await expect.poll(() => portraits.evaluateAll(images => images.every(image => image.complete && image.naturalWidth === 64 && image.naturalHeight === 64))).toBeTruthy();
  const resources = await page.locator("link, script, img").evaluateAll(nodes => nodes.map(node => node.href || node.src));
  expect(resources.every(url => new URL(url).origin === "http://127.0.0.1:8771")).toBeTruthy();
  expect(resources.filter(url => url.endsWith(".png")).every(url => new URL(url).pathname.startsWith("/assets/character-icons/64/"))).toBeTruthy();
  const response = await request.get("/assets/character-icons/64/Lathel.png");
  expect(response.ok()).toBeTruthy();
  expect(response.headers()["content-type"]).toBe("image/png");
});

test("initialization and a full rerender produce no browser errors", async ({ page }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.reload();
  await expect(page.getByTestId("player-token-1")).toBeVisible();
  await page.getByTestId("player-token-2").click();
  expect(errors).toEqual([]);
});

test("player reservation exposes no wait action", async ({ page }) => {
  await expect(page.locator("#costume-strip [data-command-type='WAIT']")).toHaveCount(0);
  await expect(page.locator("#costume-strip")).not.toContainText("待機");
});

test("selected costume shows the resolved official Japanese description in the battle header", async ({ page }) => {
  await page.locator("#costume-strip [data-costume-id='Loen_1']").click();
  await expect(page.locator("#selected-skill-name")).toHaveText("業火降臨");
  await expect(page.locator("#selected-skill-summary")).toHaveText(
    "敵に自身の魔法力1000%分の魔法ダメージを与えます。",
  );
  const placement = await page.locator("#selected-skill-summary").evaluate(element => ({
    inHeader: Boolean(element.closest(".battle-header .selected-skill-detail")),
    width: element.getBoundingClientRect().width,
    headerBottom: element.closest(".battle-header").getBoundingClientRect().bottom,
    workspaceTop: document.querySelector(".battle-workspace").getBoundingClientRect().top,
  }));
  expect(placement.inHeader).toBe(true);
  expect(placement.width).toBeGreaterThan(300);
  expect(placement.headerBottom).toBeLessThanOrEqual(placement.workspaceTop + 1);
});

test("selection accents follow all five character elements while global chrome remains neutral", async ({ page, request }) => {
  const samples = [
    ["Loen", "fire"],
    ["Wilhelmina", "water"],
    ["Nebris", "wind"],
    ["Michaela", "light"],
    ["Eclipse", "dark"],
  ];
  const accents = new Set();
  let waterAccent = "";
  let baseAccent = "";
  for (const [characterId, element] of samples) {
    await startWithCharacter(request, characterId);
    await page.reload();
    await expect(page.getByTestId("player-token-1")).toBeVisible();
    await page.getByTestId("player-token-1").click();
    await expect(page.locator("#game-shell")).toHaveAttribute("data-active-element", element);
    const colors = await page.locator("#game-shell").evaluate(node => ({
      selected: getComputedStyle(node).getPropertyValue("--selection-accent").trim(),
      base: getComputedStyle(node).getPropertyValue("--accent").trim(),
    }));
    accents.add(colors.selected);
    baseAccent = colors.base;
    if (element === "water") waterAccent = colors.selected;
    const selectedBorder = await page.locator(".command-card.selected").evaluate(node => getComputedStyle(node).borderColor);
    expect(selectedBorder).toBeTruthy();
  }
  expect(accents.size).toBe(5);
  expect(baseAccent).not.toBe(waterAccent);
});

test("knockback card exposes each character's unique direction and one-cell vector", async ({ page, request }) => {
  for (const [characterId, arrow] of [["Loen", "↗"], ["Liberta", "↓"], ["Lathel", "↖"]]) {
    await startWithCharacter(request, characterId);
    await page.reload();
    await expect(page.getByTestId("player-token-1")).toBeVisible();
    await page.getByTestId("player-token-1").click();
    const knockback = page.locator("#costume-strip [data-command-type='KNOCKBACK']");
    await expect(knockback).toContainText(arrow);
    await expect(knockback.locator(".knockback-value em")).toHaveText("1");
    await expect(knockback.locator(".knockback-grid .origin")).toHaveCount(1);
    await expect(knockback.locator(".knockback-grid .destination")).toHaveCount(1);
  }
});

test("selected attack shows authoritative total and per-target predicted damage", async ({ page }) => {
  await page.locator("#costume-strip [data-costume-id='Loen_1']").click();
  await expect(page.locator("#selected-damage")).not.toHaveText("—", { timeout: 5_000 });
  await expect.poll(async () => Number((await page.locator("#selected-damage").textContent()).replaceAll(",", ""))).toBeGreaterThan(0);
  await expect.poll(() => page.locator("[data-testid^='predicted-damage-']").count()).toBeGreaterThan(0);
  await expect(page.locator(".command-card.selected .command-prediction")).toContainText("予測");
});

test("content switching never injects runtime summons such as ET001 into setup", async ({ page }) => {
  await page.locator("#open-formation").click();
  const dialog = page.locator("#formation-dialog");
  for (const mode of ["MONSTER_CHASER", "MIRROR_WAR", "NORMAL", "MONSTER_CHASER", "NORMAL"]) {
    await dialog.locator(`#content-tabs [data-mode='${mode}']`).click();
    await expect(dialog.locator("[data-character-id*='summon:']")).toHaveCount(0);
    await expect(dialog.locator("[data-character-id*='fiend:']")).toHaveCount(0);
    await expect(dialog).not.toContainText("ET001");
  }
});

test("interactive controls have names and DOM ids are unique", async ({ page }) => {
  const unnamed = await page.locator("button").evaluateAll(buttons => buttons
    .filter(button => !(button.getAttribute("aria-label") || button.textContent.trim() || button.title))
    .length);
  const duplicateIds = await page.locator("[id]").evaluateAll(nodes => {
    const ids = nodes.map(node => node.id);
    return ids.filter((id, index) => ids.indexOf(id) !== index);
  });
  expect(unnamed).toBe(0);
  expect(duplicateIds).toEqual([]);
});

test("Fluent surfaces are flat, neutral, and use the system UI typeface", async ({ page }) => {
  const styles = await page.locator("#game-shell, .topdown-stage, .battle-button, .field-cell").evaluateAll(nodes =>
    nodes.map(node => {
      const style = getComputedStyle(node);
      return { image: style.backgroundImage, family: style.fontFamily, radius: style.borderRadius };
    }),
  );
  expect(styles.every(style => style.image === "none")).toBeTruthy();
  expect(styles[0].family).toContain("Segoe UI Variable");
  expect(styles.slice(1).every(style => Number.parseFloat(style.radius) >= 5)).toBeTruthy();
});

test("legacy mixed-language UI captions are absent", async ({ page }) => {
  await page.locator("#open-formation").click();
  const text = await page.locator("body").innerText();
  for (const caption of ["BATTLE PREPARATION", "BATTLE RESULT", "PAUSED", "BATTLE RECORD", "CONTROLS", "RULE BASED BOSS", "TEAM 1", "PLAYER", "ENEMY"]) {
    expect(text).not.toContain(caption);
  }
  await expect(page.locator("#player-formation .formation-token").first()).toContainText("火");
  await expect(page.locator("#player-formation .formation-token").first()).not.toContainText("FIRE");
});

test("selecting a board unit updates the command panel", async ({ page }) => {
  await page.getByTestId("player-token-2").click();
  await expect(page.locator("#selected-name")).toHaveText("ミカエラ");
  await expect(page.locator("#costume-strip .command-card")).toHaveCount(5);
});

test("action order and vertical reservation choices form one left-side workbench", async ({ page }) => {
  await expect(page.locator(".reservation-workbench > .order-panel")).toHaveCount(1);
  await expect(page.locator(".reservation-workbench > #action-dock")).toHaveCount(1);
  await expect(page.locator(".battle-center > #action-dock, .battle-footer #action-dock")).toHaveCount(0);
  const geometry = await page.locator(".order-panel, #action-dock, #costume-strip .command-card").evaluateAll(nodes =>
    nodes.map(node => {
      const box = node.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
    }),
  );
  const [order, dock, first, second] = geometry;
  expect(dock.left).toBeGreaterThanOrEqual(order.right);
  expect(Math.abs(dock.top - order.top)).toBeLessThan(1);
  expect(second.top).toBeGreaterThan(first.bottom);
});

test("dragging a unit to an empty cell updates planned placement", async ({ page }) => {
  await page.getByTestId("player-token-1").dragTo(page.getByTestId("player-cell-0-3"));
  await expect(page.getByTestId("player-cell-0-3").getByTestId("player-token-1")).toHaveCount(1);
  await expect(page.getByTestId("player-cell-0-0").getByTestId("player-token-1")).toHaveCount(0);
  await expect(page.locator("#tip-banner")).toContainText("移動しました");
});

test("dragging onto an occupied cell swaps both units", async ({ page }) => {
  await page.getByTestId("player-token-1").dragTo(page.getByTestId("player-cell-1-0"));
  await expect(page.getByTestId("player-cell-1-0").getByTestId("player-token-1")).toHaveCount(1);
  await expect(page.getByTestId("player-cell-0-0").getByTestId("player-token-2")).toHaveCount(1);
  await expect(page.locator("#tip-banner")).toContainText("入れ替えました");
});

test("pointer dragging follows the same placement path", async ({ page }) => {
  const source = await page.getByTestId("player-token-1").boundingBox();
  const target = await page.getByTestId("player-cell-0-2").boundingBox();
  expect(source).not.toBeNull();
  expect(target).not.toBeNull();
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId("player-cell-0-2").getByTestId("player-token-1")).toHaveCount(1);
});

test("keyboard pickup, arrow movement, and Enter move the unit", async ({ page }) => {
  await page.getByTestId("player-token-1").focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("player-cell-0-1").getByTestId("player-token-1")).toHaveCount(1);
});

test("Escape cancels keyboard placement", async ({ page }) => {
  await page.getByTestId("player-token-1").focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("player-cell-0-0").getByTestId("player-token-1")).toHaveCount(1);
});

test("dragging attack-order portraits reorders the plan", async ({ page }) => {
  await page.getByTestId("order-unit-1").dragTo(page.getByTestId("order-unit-3"));
  await expect(page.locator("#ally-rail .order-card").first()).toContainText("ミカエラ");
  await expect(page.locator("#ally-rail .order-card").nth(1)).toContainText("ロエン");
});

test("order editing has no extra mode and supports a non-visual keyboard alternative", async ({ page }) => {
  await expect(page.locator("#toggle-order, .order-controls")).toHaveCount(0);
  await page.getByTestId("order-unit-1").focus();
  await page.keyboard.press("Alt+ArrowDown");
  await expect(page.locator("#ally-rail .order-card").first()).toContainText("ミカエラ");
});

test("dragging into the empty tail can place an action at the final slot", async ({ page }) => {
  const rail = page.locator("#ally-rail");
  const box = await rail.boundingBox();
  await page.getByTestId("order-unit-1").dragTo(rail, {
    targetPosition: { x: box.width / 2, y: box.height - 2 },
  });
  await expect(page.locator("#ally-rail .order-card").nth(0)).toContainText("ミカエラ");
  await expect(page.locator("#ally-rail .order-card").nth(1)).toContainText("ウィルヘルミナ");
  await expect(page.locator("#ally-rail .order-card").nth(2)).toContainText("ロエン");
});

test("touch pointer reordering uses the same before-and-after drop semantics", async ({ page }) => {
  const source = page.getByTestId("order-unit-1");
  const sourceBox = await source.boundingBox();
  const targetBox = await page.getByTestId("order-unit-3").boundingBox();
  const pointer = {
    pointerType: "touch",
    pointerId: 17,
    button: 0,
    clientX: sourceBox.x + sourceBox.width / 2,
    clientY: sourceBox.y + sourceBox.height / 2,
  };
  await source.dispatchEvent("pointerdown", pointer);
  await source.dispatchEvent("pointermove", {
    ...pointer,
    clientX: targetBox.x + targetBox.width / 2,
    clientY: targetBox.y + targetBox.height - 2,
  });
  await source.dispatchEvent("pointerup", {
    ...pointer,
    clientX: targetBox.x + targetBox.width / 2,
    clientY: targetBox.y + targetBox.height - 2,
  });
  await expect(page.locator("#ally-rail .order-card").nth(2)).toContainText("ロエン");
});

test("selecting a costume reserves SP and exposes range highlights", async ({ page }) => {
  await page.getByTestId("command-1-2").click();
  await expect(page.getByTestId("command-1-2")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#sp-text")).toHaveText("10 / 20");
  await expect(page.locator("#sp-status")).toHaveText("残りSP 10、消費SP 5、うちバーストSP 0");
  await expect(page.locator("#enemy-field .target-preview")).toHaveCount(4, { timeout: 5_000 });
  await expect(page.locator("#enemy-field .target-occupied")).toHaveCount(2);
  await expect(page.locator("#enemy-field .target-anchor")).toHaveAttribute("data-coordinate", "1-1");
});

test("global SP HUD stays centered and renders twenty true diamond markers without category counters", async ({ page }) => {
  for (const viewport of [
    { width: 800, height: 650 },
    { width: 1024, height: 700 },
    { width: 1440, height: 900 },
    { width: 1600, height: 1000 },
  ]) {
    await page.setViewportSize(viewport);
    const geometry = await page.locator(".battle-footer, .sp-panel").evaluateAll(nodes => nodes.map(node => {
      const box = node.getBoundingClientRect();
      return { left: box.left, right: box.right, center: box.left + box.width / 2 };
    }));
    expect(Math.abs(geometry[0].center - geometry[1].center), JSON.stringify({ viewport, geometry })).toBeLessThan(1);
  }
  await expect(page.locator("#sp-remaining, #sp-consumed, #sp-burst, .sp-metric")).toHaveCount(0);
  await expect(page.locator("#sp-pips i")).toHaveCount(20);
  const markerStyle = await page.locator("#sp-pips i").first().evaluate(marker => {
    const style = getComputedStyle(marker);
    const box = marker.getBoundingClientRect();
    return { transform: style.transform, width: box.width, height: box.height };
  });
  expect(markerStyle.transform).not.toBe("none");
  expect(Math.abs(markerStyle.width - markerStyle.height)).toBeLessThan(0.6);
});

test("burst arrows select stages zero through three and execute the chosen variant", async ({ page, request }) => {
  await page.getByTestId("order-unit-2").click();
  const card = page.locator("#costume-strip [data-costume-id='Michaela_1']");
  await card.click();
  await expect(card).toHaveAttribute("data-burst-level", "0");
  await expect(page.locator(".burst-level")).toHaveText("バーストなし");
  await expect(page.locator("#selected-skill-summary")).toContainText("2ターンの間自身の魔法力が200%増加");
  await expect(page.getByRole("button", { name: /バースト段階を下げる/ })).toBeDisabled();
  await expect(page.locator("#sp-text")).toHaveText("12 / 20");
  await expect(page.locator("#sp-pips i.remaining")).toHaveCount(12);
  await expect(page.locator("#sp-pips i.spent")).toHaveCount(3);
  await expect(page.locator("#sp-pips i.burst")).toHaveCount(0);

  const increase = page.getByRole("button", { name: /バースト段階を上げる/ });
  await increase.click();
  await expect(card).toHaveAttribute("data-burst-level", "1");
  await expect(page.locator(".burst-level")).toHaveText("BURST 1");
  await expect(page.locator("#sp-text")).toHaveText("11 / 20");
  await expect(page.locator("#sp-pips i.burst")).toHaveCount(1);

  await increase.click();
  await expect(card).toHaveAttribute("data-burst-level", "2");
  await expect(page.locator(".burst-level")).toHaveText("BURST 2");
  await expect(page.locator("#selected-upgrade")).toContainText("B2");
  await expect(page.locator("#sp-text")).toHaveText("10 / 20");
  await expect(page.locator("#sp-pips i.spent")).toHaveCount(3);
  await expect(page.locator("#sp-pips i.burst")).toHaveCount(2);

  await increase.click();
  await expect(card).toHaveAttribute("data-burst-level", "3");
  await expect(page.locator(".burst-level")).toHaveText("BURST 3");
  await expect(page.locator("#selected-skill-summary")).toContainText("4ターンの間自身の魔法力が300%増加");
  await expect(increase).toBeDisabled();
  await expect(page.locator("#sp-text")).toHaveText("9 / 20");

  await page.getByRole("button", { name: /バースト段階を下げる/ }).click();
  await expect(card).toHaveAttribute("data-burst-level", "2");
  await page.getByTestId("order-unit-1").click();
  await expect(page.locator(".burst-stepper")).toHaveCount(0);
  await page.getByTestId("order-unit-2").click();
  await expect(card).toHaveAttribute("data-burst-level", "2");
  await expect(page.locator(".burst-level")).toHaveText("BURST 2");
  await page.setViewportSize({ width: 800, height: 650 });
  const burstControlBounds = await page.locator(".command-card.selected, .burst-stepper").evaluateAll(nodes => nodes.map(node => {
    const box = node.getBoundingClientRect();
    return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
  }));
  expect(burstControlBounds[1].left).toBeGreaterThanOrEqual(burstControlBounds[0].left);
  expect(burstControlBounds[1].right).toBeLessThanOrEqual(burstControlBounds[0].right);
  expect(burstControlBounds[1].top).toBeGreaterThanOrEqual(burstControlBounds[0].top);
  expect(burstControlBounds[1].bottom).toBeLessThanOrEqual(burstControlBounds[0].bottom);
  await page.getByTestId("speed").click();
  await page.getByTestId("speed").click();
  await page.getByTestId("battle-start").click();
  await expect(page.locator("#game-shell")).not.toHaveClass(/executing/, { timeout: 45_000 });
  const payload = await (await request.get("/api/state")).json();
  const action = payload.state.event_log.find(event =>
    event.kind.type === "ACTION_STARTED" && Number(event.kind.actor_id) === 2,
  );
  expect(action.kind.command.burst_level).toBe(2);
});

test("normal attack and knockback can each be reserved", async ({ page }) => {
  for (const index of [0, 1]) {
    await page.getByTestId(`command-1-${index}`).click();
    await expect(page.getByTestId(`command-1-${index}`)).toHaveAttribute("aria-selected", "true");
  }
});

test("automatic skill reservation updates selections without exceeding SP", async ({ page }) => {
  await page.getByTestId("auto-reserve").click();
  await expect(page.getByTestId("auto-reserve")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".command-card[aria-selected='true'][data-command-type='USE_COSTUME']")).toHaveCount(1);
  const remaining = Number((await page.locator("#sp-text").textContent()).split("/")[0].trim());
  expect(remaining).toBeGreaterThanOrEqual(0);
});

test("automatic reservation preserves the costume the player already chose", async ({ page }) => {
  await page.getByTestId("command-1-3").click();
  await page.getByTestId("auto-reserve").click();
  await page.getByTestId("order-unit-1").click();
  await expect(page.locator("#costume-strip [data-costume-id='Loen_2']")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#costume-strip [data-costume-id='Loen_3']")).toHaveAttribute("aria-selected", "false");
});

test("an unaffordable costume reservation is rejected without negative SP", async ({ page }) => {
  for (const unitId of [1, 2, 3]) {
    await page.getByTestId(`player-token-${unitId}`).click();
    const cards = page.locator("#costume-strip .command-card[data-command-type='USE_COSTUME']");
    const labels = await cards.allTextContents();
    const costs = labels.map(label => Number(label.match(/SP\s*(\d+)/)?.[1] || 0));
    const maximumIndex = costs.indexOf(Math.max(...costs));
    await cards.nth(maximumIndex).click();
    const increase = page.getByRole("button", { name: /バースト段階を上げる/ });
    while (await increase.isVisible().catch(() => false) && await increase.isEnabled()) {
      await increase.click();
      if (await page.locator("#toast").isVisible()) break;
    }
    if (await page.locator("#toast").isVisible()) break;
  }
  await expect(page.locator("#toast")).toContainText("SPが不足");
  const remaining = Number((await page.locator("#sp-text").textContent()).split("/")[0].trim());
  expect(remaining).toBeGreaterThanOrEqual(0);
});

test("typed Legendary equipment changes the battle unit stats through the real setup path", async ({ page, request }) => {
  const catalog = await (await request.get("/api/catalog")).json();
  const before = await (await request.get("/api/state")).json();
  const baseline = before.state.units["1"].base_stats;
  const setup = structuredClone(catalog.presets.NORMAL);
  const equipment = catalog.equipment.find(item => item.kind === "CRAFTED_LEGENDARY" && item.slot === "WEAPON");
  setup.player_units[0].equipment = {
    WEAPON: {
      equipment_id: equipment.id,
      refinement_score: 18,
      primary_stat: null,
      secondary_stat: null,
      substats: Array(3).fill(equipment.allowed_substats[0].key),
    },
  };
  setup.mcts_simulations = 3;
  const response = await request.post("/api/start", { data: setup });
  expect(response.ok()).toBeTruthy();
  const after = await response.json();
  expect(after.state.units["1"].base_stats).not.toEqual(baseline);
  await page.reload();
  await page.getByTestId("player-token-1").click();
  await expect(page.locator("#selected-name")).toHaveText("ロエン");
});

test("speed control cycles 1x, 2x, 3x, and back", async ({ page }) => {
  const speed = page.getByTestId("speed");
  await speed.click();
  await expect(speed).toHaveText("×2");
  await speed.click();
  await expect(speed).toHaveText("×3");
  await speed.click();
  await expect(speed).toHaveText("×1");
});

test("pause opens, resume closes, and rollback is initially disabled", async ({ page }) => {
  await page.getByTestId("pause").click();
  await expect(page.getByTestId("pause-dialog")).toBeVisible();
  await expect(page.getByTestId("rollback")).toBeDisabled();
  await page.locator("#resume").click();
  await expect(page.getByTestId("pause-dialog")).not.toBeVisible();
});

test("battle execution commits placement and enables exact rollback", async ({ page }) => {
  await page.getByTestId("player-token-1").dragTo(page.getByTestId("player-cell-0-3"));
  await page.getByTestId("speed").click();
  await page.getByTestId("speed").click();
  await page.getByTestId("battle-start").click();
  await expect(page.locator("#game-shell")).toHaveClass(/executing/, { timeout: 10_000 });
  await expect(page.getByTestId("player-cell-0-3").getByTestId("player-token-1")).toHaveCount(1);
  await page.getByTestId("pause").click();
  await expect(page.getByTestId("rollback")).toBeEnabled();
  await page.getByTestId("rollback").click();
  await expect(page.getByTestId("player-cell-0-0").getByTestId("player-token-1")).toHaveCount(1);
  await expect(page.locator("#turn-label")).toHaveText("ターン 1");
});

test("complex plan keeps formation, order, SP, resolved footprint, and actual hits consistent", async ({ page, request }) => {
  await page.getByTestId("player-token-1").dragTo(page.getByTestId("player-cell-2-3"));
  await page.getByTestId("order-unit-1").dragTo(page.getByTestId("order-unit-3"));
  await page.getByTestId("order-unit-1").click();
  await page.getByTestId("command-1-2").click();
  await page.getByTestId("order-unit-2").click();
  await page.getByTestId("command-2-0").click();
  await page.getByTestId("order-unit-3").click();
  await page.getByTestId("command-3-0").click();
  await page.getByTestId("order-unit-1").click();

  await expect(page.locator("#enemy-field .target-preview")).toHaveCount(4);
  await expect(page.locator("#enemy-field .target-occupied")).toHaveCount(2);
  await expect(page.locator("#enemy-field .target-anchor")).toHaveAttribute("data-coordinate", "3-1");
  await expect(page.locator("#sp-text")).toHaveText("10 / 20");

  await page.getByTestId("speed").click();
  await page.getByTestId("speed").click();
  await page.getByTestId("battle-start").click();
  await expect(page.locator("#game-shell")).not.toHaveClass(/executing/, { timeout: 45_000 });
  const payload = await (await request.get("/api/state")).json();
  const playerActions = payload.state.event_log
    .filter(event => event.kind.type === "ACTION_STARTED" && Number(event.kind.actor_id) < 100)
    .map(event => Number(event.kind.actor_id));
  const loenTargets = [...new Set(payload.state.event_log
    .filter(event => event.kind.type === "DAMAGE_APPLIED" && Number(event.kind.actor_id) === 1)
    .map(event => Number(event.kind.target_id)))].sort((a, b) => a - b);
  expect(playerActions.slice(0, 3)).toEqual([2, 1, 3]);
  expect(loenTargets).toEqual([102, 103]);
  expect(payload.state.units["1"].position).toEqual({ row: 2, depth: 3 });
});

test("rapid mixed reservations converge on one latest authoritative target preview", async ({ page, request }) => {
  let previewRequests = 0;
  page.on("request", requestEvent => {
    if (requestEvent.url().endsWith("/api/preview")) previewRequests += 1;
  });
  await page.evaluate(() => {
    document.querySelector('[data-testid="order-unit-1"]').click();
    document.querySelector('[data-testid="command-1-2"]').click();
    document.querySelector('[data-testid="order-unit-2"]').click();
    document.querySelector('[data-testid="command-2-0"]').click();
    document.querySelector('[data-testid="order-unit-3"]').click();
    document.querySelector('[data-testid="command-3-0"]').click();
    document.querySelector('[data-testid="order-unit-1"]').click();
  });

  await expect(page.locator("#enemy-field .target-preview")).toHaveCount(4);
  await expect(page.locator("#enemy-field .target-anchor")).toHaveAttribute("data-coordinate", "1-1");
  expect(previewRequests).toBeLessThanOrEqual(1);
  expect((await request.get("/api/catalog")).ok()).toBeTruthy();
});

test("later action preview and execution account for enemies killed by earlier reservations", async ({ page, request }) => {
  await page.getByTestId("command-1-2").click();
  await page.getByTestId("order-unit-2").click();
  await page.getByTestId("command-2-0").click();
  await page.getByTestId("order-unit-3").click();
  await page.getByTestId("command-3-0").click();
  await page.getByTestId("order-unit-2").click();

  await expect(page.locator("#enemy-field .target-anchor")).toHaveAttribute("data-coordinate", "3-1");
  await expect(page.locator("#enemy-field .target-occupied")).toHaveCount(1);

  await page.getByTestId("speed").click();
  await page.getByTestId("speed").click();
  await page.getByTestId("battle-start").click();
  await expect(page.locator("#game-shell")).not.toHaveClass(/executing/, { timeout: 45_000 });
  const payload = await (await request.get("/api/state")).json();
  const locked = payload.state.event_log.find(event =>
    event.kind.type === "TARGET_LOCKED" && Number(event.kind.actor_id) === 2,
  );
  expect(Number(locked.kind.target_id)).toBe(103);
});

test("battle playback shows actor, target, damage and obeys pause and speed", async ({ page }) => {
  await page.getByTestId("command-1-2").click();
  await page.getByTestId("battle-start").click();
  await expect(page.locator("#game-shell")).toHaveClass(/executing/, { timeout: 10_000 });
  await expect(page.locator("#battle-cue")).toBeVisible();
  await page.getByTestId("pause").click();
  const pausedCue = await page.locator("#battle-cue").textContent();
  await page.waitForTimeout(700);
  await expect(page.locator("#battle-cue")).toHaveText(pausedCue);
  await page.locator("#resume").click();
  await page.getByTestId("speed").click();
  await page.getByTestId("speed").click();
  await expect(page.locator(".enemy-card[data-unit-id='101'] small")).toContainText("HP 0", { timeout: 10_000 });
  await expect(page.locator("#game-shell")).not.toHaveClass(/executing/, { timeout: 45_000 });
});

test("battle history translates authoritative events without exposing engine JSON", async ({ page, request }) => {
  test.setTimeout(90_000);
  for (const unitId of [2, 3]) {
    await page.getByTestId(`order-unit-${unitId}`).click();
    await page.locator("#costume-strip [data-command-type='NORMAL_ATTACK']").click();
  }
  await page.getByTestId("order-unit-1").click();
  await page.getByTestId("speed").click();
  await page.getByTestId("speed").click();
  await page.getByTestId("battle-start").click();
  await expect.poll(async () => {
    const payload = await (await request.get("/api/state")).json();
    return payload.state.game_turn;
  }, { timeout: 15_000 }).toBeGreaterThan(1);
  await page.reload();
  await expect(page.locator("#game-shell")).not.toHaveClass(/executing/, { timeout: 45_000 });
  const reloadedState = await (await request.get("/api/state")).json();
  if (reloadedState.state.terminal) {
    await expect(page.locator("#terminal")).toBeVisible();
    await page.getByTestId("terminal-log").click();
  } else {
    await page.locator("#open-log").click();
  }
  const history = page.locator("#events");
  await expect(history).toContainText("ダメージ");
  await expect(history).toContainText("ロエン");
  await expect(history).not.toContainText(/DAMAGE_APPLIED|TARGET_LOCKED|target_id|actor_id|effect_id/);
});

test("multi-hit playback exposes chain changes instead of silently skipping them", async ({ page }) => {
  await page.evaluate(() => {
    window.__observedChains = [];
    new MutationObserver(records => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE && node.classList.contains("chain")) {
            window.__observedChains.push(node.textContent);
          }
        }
      }
    }).observe(document.querySelector("#floating-layer"), { childList: true });
  });
  await page.getByTestId("command-1-2").click();
  await page.locator("#speed").click();
  await page.locator("#speed").click();
  await page.getByTestId("battle-start").click();
  await expect(page.locator("#turn-label")).toHaveText("ターン 3", { timeout: 30_000 });
  const chains = await page.evaluate(() => window.__observedChains);
  expect(chains.length).toBeGreaterThan(0);
  expect(chains.every(text => /\d+チェイン/.test(text))).toBeTruthy();
});

test("knockback collision shows each authoritative damage event only once", async ({ page, request }) => {
  const catalog = await (await request.get("/api/catalog")).json();
  const setup = structuredClone(catalog.presets.NORMAL);
  const justia = catalog.characters.find(character => character.id === "Justia");
  setup.player_units[0].character_id = justia.id;
  setup.player_units[0].costumes = maximumLoadout(justia);
  setup.enemy_units[0].row = 0;
  setup.enemy_units[0].depth = 0;
  setup.enemy_units[1].row = 0;
  setup.enemy_units[1].depth = 1;
  setup.mcts_simulations = 3;
  const started = await request.post("/api/start", { data: setup });
  expect(started.ok()).toBeTruthy();
  const before = await started.json();
  const lastSequence = Math.max(...before.state.event_log.map(event => Number(event.sequence)));
  await page.reload();
  await page.getByTestId("command-1-1").click();
  await page.getByTestId("order-unit-2").click();
  await page.getByTestId("command-2-0").click();
  await page.getByTestId("order-unit-3").click();
  await page.getByTestId("command-3-0").click();
  await page.evaluate(() => {
    window.__observedDamage = [];
    new MutationObserver(records => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE && node.classList.contains("floating-number")) {
            window.__observedDamage.push(node.textContent);
          }
        }
      }
    }).observe(document.querySelector("#floating-layer"), { childList: true });
  });
  await page.locator("#speed").click();
  await page.locator("#speed").click();
  const responsePromise = page.waitForResponse(response => response.url().endsWith("/api/step"));
  await page.getByTestId("battle-start").click();
  const result = await (await responsePromise).json();
  await expect(page.locator("#turn-label")).toHaveText("ターン 3", { timeout: 30_000 });
  const events = result.state.event_log
    .filter(event => Number(event.sequence) > lastSequence)
    .map(event => event.kind);
  const collision = events.find(event => event.type === "COLLISION_DAMAGE");
  expect(collision).toBeTruthy();
  const damageEventCount = events.filter(event =>
    event.type === "DAMAGE_APPLIED" && Number(event.amount) === Number(collision.amount)).length;
  const label = `−${Number(collision.amount).toLocaleString("ja-JP")}`;
  const observed = await page.evaluate(() => window.__observedDamage);
  expect(observed.filter(text => text === label)).toHaveLength(damageEventCount);
});

test("used costumes remain visible with an explicit disabled cooldown state next turn", async ({ page }) => {
  await page.getByTestId("command-1-2").click();
  for (const unitId of [2, 3]) {
    await page.getByTestId(`order-unit-${unitId}`).click();
    await page.getByTestId(`command-${unitId}-0`).click();
  }
  await page.getByTestId("speed").click();
  await page.getByTestId("speed").click();
  await page.getByTestId("battle-start").click();
  await expect(page.locator("#game-shell")).not.toHaveClass(/executing/, { timeout: 45_000 });
  await page.getByTestId("order-unit-1").click();
  const used = page.locator("#costume-strip [data-costume-id='Loen_1']");
  await expect(page.locator("#costume-strip .command-card")).toHaveCount(5);
  await expect(used).toBeDisabled();
  await expect(used).toContainText("CT 2");
});

test("a newly created summon is inserted during playback before later events can target it", async ({ page, request }) => {
  await startWithCharacter(request, "Morpeah");
  await page.goto("/");
  await page.locator("#costume-strip [data-costume-id='Morpeah_2']").click();
  const partyIds = await page.locator("#ally-rail .order-card").evaluateAll(cards => cards.map(card => Number(card.dataset.unitId)));
  for (const unitId of partyIds.filter(unitId => unitId !== 1)) {
    await page.getByTestId(`order-unit-${unitId}`).click();
    await page.locator("#costume-strip [data-command-type='NORMAL_ATTACK']").click();
  }
  await page.getByTestId("battle-start").click();
  await expect(page.locator("#game-shell.executing .playback-created")).toHaveCount(1, { timeout: 15_000 });
  await expect(page.locator("#game-shell")).not.toHaveClass(/executing/, { timeout: 45_000 });
  const payload = await (await request.get("/api/state")).json();
  const summons = Object.values(payload.state.units).filter(unit => unit.side === "PLAYER" && unit.is_summon);
  expect(summons).toHaveLength(3);
  for (const summon of summons.filter(unit => unit.alive)) {
    await expect(page.getByTestId(`player-token-${summon.id}`)).toBeVisible();
  }
  for (const summon of summons.filter(unit => !unit.alive)) {
    await expect(page.getByTestId(`player-token-${summon.id}`)).toHaveCount(0);
  }
});

test("summoned units keep official entity and skill metadata on their next controllable turn", async ({ page, request }) => {
  await startWithCharacter(request, "Morpeah");
  await page.reload();
  const summonCard = page.locator(".order-card").filter({ hasText: "Persona of Worship" });
  await expect(summonCard).toHaveCount(1);
  await expect(summonCard).not.toContainText("summon:");
  await summonCard.click();
  const skill = page.locator('[data-costume-id="summon:PersonaOfWorship:skill"]');
  await expect(page.locator("#selected-name")).toHaveText("Persona of Worship");
  await expect(skill).toContainText("精神崩潰");
  await expect(skill).not.toContainText("undefined");
  expect(await skill.locator(".command-range .hit").count()).toBeGreaterThan(0);
});

test("reloading preserves the active custom formation and MCTS configuration", async ({ page, request }) => {
  await startWithCharacter(request, "Morpeah");
  await page.reload();
  await page.locator("#open-formation").click();
  await expect(page.locator("#player-roster .roster-chip").first()).toContainText("モルフェア");
  await expect(page.locator("#mcts-simulations")).toHaveValue("3");
});

test("dragged attack order is sent as the simulator action sequence", async ({ page, request }) => {
  await page.getByTestId("order-unit-1").dragTo(page.getByTestId("order-unit-3"));
  await page.getByTestId("battle-start").click();
  await expect(page.locator("#game-shell")).toHaveClass(/executing/, { timeout: 10_000 });
  const response = await request.get("/api/state");
  const payload = await response.json();
  const playerActions = payload.state.event_log
    .filter(event => event.kind.type === "ACTION_STARTED" && Number(event.kind.actor_id) < 100)
    .map(event => Number(event.kind.actor_id));
  expect(playerActions.slice(0, 3)).toEqual([2, 1, 3]);
});

test("enemy inspection opens complete status and closes", async ({ page }) => {
  await page.getByTestId("enemy-token-101").click();
  await expect(page.locator("#inspect-dialog")).toBeVisible();
  await expect(page.locator("#inspect-content")).toContainText("HP");
  await page.getByRole("button", { name: "ユニット詳細を閉じる" }).click();
  await expect(page.locator("#inspect-dialog")).not.toBeVisible();
});

test("formation editor supports drag to empty cells", async ({ page }) => {
  await page.locator("#open-formation").click();
  await expect(page.getByTestId("formation-dialog")).toBeVisible();
  await page.locator("#player-formation [data-editor-index='0']").dragTo(page.getByTestId("player-formation-cell-0-3"));
  await expect(page.getByTestId("player-formation-cell-0-3").locator("[data-editor-index='0']")).toHaveCount(1);
});

test("formation editor swaps occupied units", async ({ page }) => {
  await page.locator("#open-formation").click();
  await page.locator("#player-formation [data-editor-index='0']").dragTo(page.getByTestId("player-formation-cell-1-0"));
  await expect(page.getByTestId("player-formation-cell-1-0").locator("[data-editor-index='0']")).toHaveCount(1);
  await expect(page.getByTestId("player-formation-cell-0-0").locator("[data-editor-index='1']")).toHaveCount(1);
});

test("formation drag is persisted when a new battle starts", async ({ page }) => {
  await page.locator("#open-formation").click();
  await page.locator("#player-formation [data-editor-index='0']").dragTo(page.getByTestId("player-formation-cell-0-3"));
  await page.getByTestId("start-battle").click();
  await expect(page.getByTestId("formation-dialog")).not.toBeVisible();
  await expect(page.getByTestId("player-cell-0-3").getByTestId("player-token-1")).toHaveCount(1);
});

test("unit details expose character, costume, link, potential, and equipment controls", async ({ page }) => {
  await page.locator("#open-formation").click();
  await page.locator("#player-roster").getByRole("button", { name: /ロエンの詳細設定/ }).click();
  await expect(page.locator(".advanced-popover")).toBeVisible();
  await expect(page.locator("#formation-dialog > .advanced-popover")).toHaveCount(1);
  await expect(page.locator(".advanced-top select option")).toHaveCount(61);
  await expect(page.locator(".costume-line")).not.toHaveCount(0);
  await expect(page.locator(".inline-setting select")).toBeVisible();
  await expect(page.locator(".equipment-slot-row")).toHaveCount(5);
  await expect(page.locator(".equipment-editor textarea")).toHaveCount(0);
  await expect(page.locator(".build-settings-editor")).toBeVisible();
  await expect(page.locator(".advanced-top select option").first()).not.toContainText(/FIRE|WATER|WIND|LIGHT|DARK|PHYSICAL|MAGICAL/);
});

test("exclusive equipment exposes owner-only main abilities and persists refinement 18-24", async ({ page, request }) => {
  const catalog = await (await request.get("/api/catalog")).json();
  const owner = catalog.presets.NORMAL.player_units[0].character_id;
  const exclusive = catalog.equipment.find(item => item.kind === "EXCLUSIVE" && item.owner_character_id === owner);
  expect(exclusive).toBeTruthy();

  await page.locator("#open-formation").click();
  await page.locator("#player-roster .roster-advanced").first().click();
  const item = page.getByTestId(`equipment-item-${exclusive.slot}`);
  await expect(item.locator(`option[value="${exclusive.id}"]`)).toContainText("専用UR");
  await item.selectOption(exclusive.id);
  await expect(page.getByTestId(`equipment-score-${exclusive.slot}`)).toHaveValue("18");
  await expect(page.getByTestId(`equipment-primary-${exclusive.slot}`)).toBeVisible();
  await expect(page.getByTestId(`equipment-secondary-${exclusive.slot}`)).toBeVisible();
  await page.getByTestId(`equipment-score-${exclusive.slot}`).selectOption("24");
  const secondaryOptions = page.getByTestId(`equipment-secondary-${exclusive.slot}`).locator("option");
  if (await secondaryOptions.count() > 1) {
    await page.getByTestId(`equipment-secondary-${exclusive.slot}`).selectOption(await secondaryOptions.nth(1).getAttribute("value"));
  }
  const selectedPrimary = await page.getByTestId(`equipment-primary-${exclusive.slot}`).inputValue();
  const selectedSecondary = await page.getByTestId(`equipment-secondary-${exclusive.slot}`).inputValue();
  await page.locator(".advanced-top .secondary-button").click();
  await page.getByTestId("start-battle").click();

  const state = await (await request.get("/api/state")).json();
  const equipped = state.setup.player_units[0].equipment[exclusive.slot];
  expect(equipped.equipment_id).toBe(exclusive.id);
  expect(equipped.refinement_score).toBe(24);
  expect(equipped.primary_stat).toBe(selectedPrimary);
  expect(equipped.secondary_stat).toBe(selectedSecondary);
});

test("exclusive equipment is removed atomically when its owner is replaced", async ({ page, request }) => {
  const catalog = await (await request.get("/api/catalog")).json();
  const owner = catalog.presets.NORMAL.player_units[0].character_id;
  const exclusive = catalog.equipment.find(item => item.kind === "EXCLUSIVE" && item.owner_character_id === owner);
  const replacement = catalog.characters.find(item => item.id !== owner && !catalog.presets.NORMAL.player_units.some(unit => unit.character_id === item.id));
  await page.locator("#open-formation").click();
  await page.locator("#player-roster .roster-advanced").first().click();
  await page.getByTestId(`equipment-item-${exclusive.slot}`).selectOption(exclusive.id);
  await page.locator(".advanced-top select").selectOption(replacement.id);
  await expect(page.getByTestId(`equipment-item-${exclusive.slot}`)).toHaveValue("");
  await expect(page.getByTestId(`equipment-item-${exclusive.slot}`).locator(`option[value="${exclusive.id}"]`)).toHaveCount(0);
});

test("exclusive equipment editor stays operable without horizontal overflow on a narrow browser", async ({ page, request }) => {
  const catalog = await (await request.get("/api/catalog")).json();
  const owner = catalog.presets.NORMAL.player_units[0].character_id;
  const exclusive = catalog.equipment.find(item => item.kind === "EXCLUSIVE" && item.owner_character_id === owner);
  await page.setViewportSize({ width: 640, height: 720 });
  await page.locator("#open-formation").click();
  await page.locator("#player-roster .roster-advanced").first().click();
  await page.getByTestId(`equipment-item-${exclusive.slot}`).selectOption(exclusive.id);
  await expect(page.getByTestId(`equipment-primary-${exclusive.slot}`)).toBeVisible();
  await expect(page.getByTestId(`equipment-secondary-${exclusive.slot}`)).toBeVisible();
  const layout = await page.locator(".advanced-popover").evaluate(popover => {
    const box = popover.getBoundingClientRect();
    return {
      left: box.left,
      right: box.right,
      viewport: window.innerWidth,
      clientWidth: popover.clientWidth,
      scrollWidth: popover.scrollWidth,
      documentWidth: document.documentElement.scrollWidth,
      offenders: [...document.querySelectorAll("body *")]
        .map(node => ({ node: `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ""}${node.className && typeof node.className === "string" ? `.${node.className.trim().replaceAll(/\\s+/g, ".")}` : ""}`, right: node.getBoundingClientRect().right, width: node.scrollWidth }))
        .filter(item => item.right > window.innerWidth + 1 || item.width > window.innerWidth + 1)
        .slice(0, 20),
    };
  });
  expect(layout.left).toBeGreaterThanOrEqual(0);
  expect(layout.right).toBeLessThanOrEqual(layout.viewport);
  expect(layout.documentWidth, JSON.stringify(layout.offenders)).toBeLessThanOrEqual(layout.viewport);
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);
});

test("BD2DB build defaults and configurable bonuses survive a GUI round trip", async ({ page, request }) => {
  await page.locator("#open-formation").click();
  await page.locator("#player-roster .roster-advanced").first().click();
  await page.locator(".build-settings-editor summary").click();
  await expect(page.getByTestId("build-collection-attack_bp")).toHaveValue("8000");
  await expect(page.getByTestId("build-option-count")).toHaveValue("15");
  await expect(page.getByTestId("build-elemental-advantage")).toBeChecked();
  await page.getByTestId("build-collection-attack_bp").fill("4321");
  await page.getByTestId("build-collection-attack_bp").blur();
  await page.getByTestId("build-external-crit_damage_bp").fill("1234");
  await page.getByTestId("build-external-crit_damage_bp").blur();
  await page.getByTestId("build-world-buff").check();
  await page.locator(".advanced-top .secondary-button").click();
  await page.getByTestId("start-battle").click();

  const state = await (await request.get("/api/state")).json();
  const settings = state.setup.player_units[0].build_settings;
  expect(settings.collection.attack_bp).toBe(4321);
  expect(settings.external_buffs.crit_damage_bp).toBe(1234);
  expect(settings.calculator.world_buff_enabled).toBe(true);
});

test("advanced character replacement cannot create a duplicate in the same party", async ({ page }) => {
  await page.locator("#open-formation").click();
  await page.locator("#player-roster").getByRole("button", { name: /ミカエラの詳細設定/ }).click();
  await expect(page.locator(".advanced-top select option[value='Loen']")).toBeDisabled();
  await expect(page.locator(".advanced-top select option[value='Michaela']")).toBeEnabled();
});

test("disabling a linked costume atomically clears the invalid costume link", async ({ page }) => {
  await page.locator("#open-formation").click();
  await page.locator("#player-roster").getByRole("button", { name: /ロエンの詳細設定/ }).click();
  const link = page.locator(".inline-setting select");
  await link.selectOption("Loen_1");
  const firstCostume = page.locator(".advanced-costumes .costume-line:not(.costume-line-heading)").first();
  await firstCostume.locator("input[type='checkbox']").first().uncheck();
  await expect(link).toHaveValue("");
  await expect(link.locator("option[value='Loen_1']")).toHaveAttribute("disabled", "");
});

test("the final equipped costume cannot be disabled into an invalid empty loadout", async ({ page, request }) => {
  await startWithCharacter(request, "Yomi");
  await page.reload();
  await page.locator("#open-formation").click();
  await page.locator("#player-roster .roster-advanced").first().click();
  const equipped = page.locator(".advanced-popover .costume-line input[type=checkbox]").first();
  await expect(equipped).toBeChecked();
  await expect(equipped).toBeDisabled();
});

test("closing preparation removes its nested advanced editor before reopening", async ({ page }) => {
  await page.locator("#open-formation").click();
  await page.locator("#player-roster .roster-advanced").first().click();
  await expect(page.locator(".advanced-popover")).toHaveCount(1);
  await page.locator("#formation-dialog .dialog-close").click();
  await expect(page.locator("#formation-dialog")).not.toBeVisible();
  await page.locator("#open-formation").click();
  await expect(page.locator(".advanced-popover")).toHaveCount(0);
});

test("invalid fractional MCTS input cannot start or silently truncate a battle", async ({ page, request }) => {
  const before = await (await request.get("/api/state")).json();
  await page.locator("#open-formation").click();
  await page.locator("#mcts-simulations").fill("3.5");
  await page.getByTestId("start-battle").click();
  await expect(page.locator("#formation-dialog")).toBeVisible();
  await expect(page.locator("#toast")).toContainText("整数の有効範囲内");
  const after = await (await request.get("/api/state")).json();
  expect(after.state).toEqual(before.state);
  expect(after.mcts).toEqual(before.mcts);
});

test("automatic turns stay suspended while a modal editor is open", async ({ page, request }) => {
  await page.locator("#auto-turn").click();
  await page.locator("#open-formation").click();
  const before = await (await request.get("/api/state")).json();
  await page.waitForTimeout(1_200);
  const during = await (await request.get("/api/state")).json();
  expect(during.state).toEqual(before.state);
  await page.locator("#formation-dialog .dialog-close").click();
  await page.locator("#auto-turn").click();
});

test("configured costume potential changes the displayed skill range variant", async ({ page, request }) => {
  const catalog = await (await request.get("/api/catalog")).json();
  const setup = structuredClone(catalog.presets.NORMAL);
  const loen = setup.player_units.find(unit => unit.character_id === "Loen");
  const costume = loen.costumes.find(item => item.costume_id === "Loen_1");
  Object.assign(costume, { enhancement: 0, burst_level: 0, potential_mask: 0 });
  setup.mcts_simulations = 3;
  await request.post("/api/start", { data: setup });
  await page.goto("/");
  const card = page.locator("#costume-strip .command-card").filter({ hasText: "業火降臨" });
  await expect(card.locator(".command-range i.hit")).toHaveCount(5);
});

test("next-ally skills retarget immediately when the left action order is dragged", async ({ page, request }) => {
  await startWithCharacter(request, "Helena");
  await page.goto("/");
  const skill = page.locator("#costume-strip [data-costume-id='Helena_3']");
  await skill.click();
  await expect(page.locator("#player-field .target-anchor")).toHaveAttribute("data-coordinate", "2-1");

  await page.getByTestId("order-unit-1").dragTo(page.getByTestId("order-unit-3"));
  await page.getByTestId("order-unit-1").click();
  await expect(page.locator("#player-field .target-anchor")).toHaveAttribute("data-coordinate", "3-1");
  await expect(page.locator("#player-field .target-occupied")).toHaveCount(1);

  for (const unitId of [2, 3]) {
    await page.getByTestId(`order-unit-${unitId}`).click();
    await page.locator("#costume-strip [data-command-type='NORMAL_ATTACK']").click();
  }
  await page.getByTestId("speed").click();
  await page.getByTestId("speed").click();
  await page.getByTestId("battle-start").click();
  await expect(page.locator("#game-shell")).not.toHaveClass(/executing/, { timeout: 45_000 });
  const payload = await (await request.get("/api/state")).json();
  const lock = payload.state.event_log.find(event =>
    event.kind.type === "TARGET_LOCKED" && Number(event.kind.actor_id) === 1,
  );
  expect(Number(lock.kind.target_id)).toBe(3);
});

test("unit addition lets the user search and choose any five-star DB character", async ({ page }) => {
  await page.locator("#open-formation").click();
  await page.locator("#player-roster .remove-unit").first().click();
  await page.locator('[data-add-side="PLAYER"]').click();
  await expect(page.getByTestId("character-picker")).toBeVisible();
  await expect(page.locator("#character-options .character-option")).toHaveCount(61);
  const portraits = page.locator("#character-options img.character-portrait");
  await expect(portraits).toHaveCount(61);
  await expect.poll(() => portraits.evaluateAll(images => images.filter(image => image.complete && image.naturalWidth === 64 && image.naturalHeight === 64).length)).toBe(61);
  const portraitSources = await portraits.evaluateAll(images => images.map(image => new URL(image.src).pathname));
  expect(new Set(portraitSources).size).toBe(61);
  expect(portraitSources.every(path => path.startsWith("/assets/character-icons/64/") && path.endsWith(".png"))).toBeTruthy();
  await page.locator("#character-search").fill("アレック");
  await expect(page.locator("#character-options .character-option")).toHaveCount(1);
  await page.getByTestId("character-option-Alec").click();
  await expect(page.getByTestId("character-picker")).not.toBeVisible();
  await expect(page.locator("#player-roster")).toContainText("アレック");
});

test("all five elements use distinct colors on character cards and portraits", async ({ page }) => {
  await page.locator("#open-formation").click();
  await page.locator("#player-roster .remove-unit").first().click();
  await page.locator('[data-add-side="PLAYER"]').click();
  const colors = await page.locator("#character-options .character-option").evaluateAll(cards => {
    const result = {};
    for (const card of cards) {
      for (const element of ["fire", "water", "wind", "light", "dark"]) {
        if (card.classList.contains(element) && !result[element]) {
          const emblem = card.querySelector(".token-emblem");
          result[element] = {
            card: getComputedStyle(card).borderInlineStartColor,
            portrait: getComputedStyle(emblem).borderColor,
            variable: getComputedStyle(card).getPropertyValue("--element-color").trim(),
          };
        }
      }
    }
    return result;
  });
  expect(Object.keys(colors).sort()).toEqual(["dark", "fire", "light", "water", "wind"]);
  expect(new Set(Object.values(colors).map(value => value.variable)).size).toBe(5);
  for (const value of Object.values(colors)) {
    expect(value.card).toBe(value.portrait);
  }
});

test("portrait identity follows a token through selection and drag placement", async ({ page }) => {
  const token = page.getByTestId("player-token-1");
  const source = await token.locator("img.character-portrait").getAttribute("src");
  const characterId = await token.locator(".token-emblem").getAttribute("data-character-id");
  expect(source).toBe(`/assets/character-icons/64/${characterId}.png`);
  await token.click();
  await expect(page.locator("#selected-emblem img.character-portrait")).toHaveAttribute("src", source);
  await token.dragTo(page.getByTestId("player-cell-0-3"));
  await expect(page.getByTestId("player-cell-0-3").locator("img.character-portrait")).toHaveAttribute("src", source);
});

test("Mirror War locks runtime formation while retaining manual commands", async ({ page, request }) => {
  await openBattle(page, request, "MIRROR_WAR");
  await expect(page.locator("#formation-state")).toHaveText("配置固定");
  await expect(page.getByTestId("player-token-1")).toHaveAttribute("draggable", "false");
  const originalCell = await page.getByTestId("player-token-1").evaluate(token => ({ row: token.parentElement.dataset.row, depth: token.parentElement.dataset.depth }));
  await page.getByTestId("player-token-1").dragTo(page.getByTestId("player-cell-0-3"));
  await expect(page.getByTestId(`player-cell-${originalCell.row}-${originalCell.depth}`).getByTestId("player-token-1")).toHaveCount(1);
  await expect(page.locator("#costume-strip .command-card")).not.toHaveCount(0);
});

test("Mirror War keyboard placement reports the lock and does not move", async ({ page, request }) => {
  await openBattle(page, request, "MIRROR_WAR");
  const token = page.getByTestId("player-token-1");
  const originalCell = await token.evaluate(node => `${node.parentElement.dataset.row}-${node.parentElement.dataset.depth}`);
  await token.focus();
  await page.keyboard.press("Space");
  await expect(page.locator("#toast")).toContainText("固定");
  await expect(page.getByTestId(`player-cell-${originalCell}`).getByTestId("player-token-1")).toHaveCount(1);
});

test("Monster Chaser shows team and rule-based boss forecast", async ({ page, request }) => {
  await openBattle(page, request, "MONSTER_CHASER");
  await expect(page.locator("#controller-label")).toHaveText("ルール制御");
  await expect(page.locator("#fiend-zone")).toBeVisible();
  await expect(page.locator("#forecast-list li")).toHaveCount(5);
  await expect(page.locator("#team-label")).toHaveText("チーム 1");
  await expect(page.locator("#enemy-rail")).toBeHidden();
  const payload = await (await request.get("/api/state")).json();
  const monster = payload.state.monster_chaser;
  const total = monster.level_hp_segments.reduce((sum, value) => sum + Number(value), 0);
  await expect(page.locator("#fiend-percent")).toHaveText("100.0%");
  await expect(page.locator("#fiend-hp-text")).toHaveText(`${monster.battle_hp_remaining.toLocaleString("ja-JP")} / ${total.toLocaleString("ja-JP")}`);
  await expect(page.locator("#fiend-hp-bar")).not.toHaveAttribute("style", /NaN/);
  await expect(page.locator("#forecast-list")).not.toContainText("[object Object]");
  await expect(page.locator("#forecast-list")).not.toContainText("Conditional");
  await expect(page.locator("#forecast-list")).not.toContainText("Instant Death");
  await expect(page.locator("#forecast-list")).not.toContainText("Remove Effects By Tag");
  await expect(page.locator("#forecast-list")).toContainText("敵のいずれかのチェインが8以上");
  await expect(page.locator("#enemy-field .battle-token").first()).toContainText("仇怨のキメラ（風）");
});

test("Monster Chaser battle delegates the enemy turn to the rule controller", async ({ page, request }) => {
  await openBattle(page, request, "MONSTER_CHASER");
  for (const unitId of [1, 2, 3, 4, 5]) {
    await page.getByTestId(`player-token-${unitId}`).click();
    await page.locator("#costume-strip [data-command-type='NORMAL_ATTACK']").click();
  }
  await page.getByTestId("battle-start").click();
  await expect(page.locator("#sp-text")).toHaveText("14 / 20", { timeout: 15_000 });
  await expect(page.getByTestId("player-cell-2-3")).toHaveClass(/target-anchor/, { timeout: 15_000 });
  await page.getByTestId("speed").click();
  await page.getByTestId("speed").click();
  await expect(page.locator("#game-shell")).not.toHaveClass(/executing/, { timeout: 45_000 });
  await expect(page.locator("#ai-report")).toContainText("外部DBのルール");
});

test("Monster Chaser level transition is animated and the current HP segment stays numeric", async ({ page, request }) => {
  const catalog = await (await request.get("/api/catalog")).json();
  const setup = structuredClone(catalog.presets.MONSTER_CHASER);
  setup.monster_level = 3;
  setup.mcts_simulations = 3;
  await request.post("/api/start", { data: setup });
  await page.goto("/");
  const initialHp = await page.locator("#fiend-hp-text").textContent();
  await page.getByTestId("auto-reserve").click();
  await page.getByTestId("battle-start").click();
  await expect(page.locator("#fiend-hp-text")).not.toHaveText(initialHp, { timeout: 20_000 });
  await expect(page.locator("#cue-title")).toHaveText("魔物レベル 2", { timeout: 20_000 });
  await page.getByTestId("speed").click();
  await page.getByTestId("speed").click();
  await expect(page.locator("#game-shell")).not.toHaveClass(/executing/, { timeout: 45_000 });
  const payload = await (await request.get("/api/state")).json();
  expect(payload.state.monster_chaser.current_level).toBe(2);
  await expect(page.locator("#fiend-level")).toContainText("レベル 2 / 3");
  await expect(page.locator("#fiend-percent")).not.toHaveText(/NaN/);
});

test("Monster Chaser inserts party two during playback when party one is eliminated", async ({ page, request }) => {
  test.setTimeout(180_000);
  const catalog = await (await request.get("/api/catalog")).json();
  const setup = structuredClone(catalog.presets.MONSTER_CHASER);
  setup.monster_level = 25;
  setup.mcts_simulations = 3;
  await request.post("/api/start", { data: setup });
  await page.goto("/");
  await page.getByTestId("speed").click();
  await page.getByTestId("speed").click();

  const expectVisiblePartyToDefaultToNormalAttacks = async () => {
    const cards = page.locator("#ally-rail .order-card:not(:disabled)");
    await expect.poll(async () => cards.evaluateAll(items => (
      items.length > 0 && items.every(item => item.textContent.includes("通常攻撃"))
    ))).toBe(true);
  };

  await expectVisiblePartyToDefaultToNormalAttacks();
  await page.getByTestId("battle-start").click();
  await expect(page.locator("#game-shell")).not.toHaveClass(/executing/, { timeout: 45_000 });

  await page.evaluate(() => {
    window.__partyTwoInsertedDuringPlayback = false;
    window.__partyTwoObserver?.disconnect();
    window.__partyTwoObserver = new MutationObserver(() => {
      if (document.querySelector("#game-shell.executing [data-testid='player-token-101']")) {
        window.__partyTwoInsertedDuringPlayback = true;
      }
    });
    window.__partyTwoObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ["class"],
      childList: true,
      subtree: true,
    });
  });

  for (let turn = 0; turn < 8; turn += 1) {
    const state = await (await request.get("/api/state")).json();
    if (state.state.monster_chaser.current_party === 2) break;
    await expectVisiblePartyToDefaultToNormalAttacks();
    await page.getByTestId("battle-start").click();
    await expect(page.locator("#game-shell")).not.toHaveClass(/executing/, { timeout: 45_000 });
  }

  await expect.poll(() => page.evaluate(() => window.__partyTwoInsertedDuringPlayback)).toBe(true);
  await page.evaluate(() => window.__partyTwoObserver?.disconnect());
  const state = await (await request.get("/api/state")).json();
  expect(state.state.monster_chaser.current_party).toBe(2);
  await expect(page.locator("#team-label")).toHaveText("チーム 2");
});

test("formation mode tabs expose both Monster Chaser teams", async ({ page }) => {
  await page.locator("#open-formation").click();
  await page.locator("[data-mode='MONSTER_CHASER']").click();
  await expect(page.locator("#party-switch")).toBeVisible();
  await page.locator("#party-switch [data-party='2']").click();
  await expect(page.locator("#party-switch [data-party='2']")).toHaveClass(/active/);
  await expect(page.locator("#player-roster .roster-chip")).not.toHaveCount(0);
});

test("switching from Monster Chaser to Mirror War leaves no boss HUD state", async ({ page }) => {
  await page.locator("#open-formation").click();
  await page.locator("[data-mode='MONSTER_CHASER']").click();
  await page.locator("[data-mode='MIRROR_WAR']").click();
  await page.getByTestId("start-battle").click();
  await expect(page.locator("#mode-label")).toHaveText("鏡戦争");
  await expect(page.locator("#fiend-zone")).toBeHidden();
  await expect(page.locator("#enemy-rail")).toBeVisible();
  await expect(page.locator("#formation-state")).toHaveText("配置固定");
});

test("automatic turn start advances and can be stopped", async ({ page }) => {
  await page.getByTestId("speed").click();
  await page.getByTestId("speed").click();
  await page.getByTestId("auto-turn").click();
  await expect(page.locator("#turn-label")).not.toHaveText("ターン 1", { timeout: 45_000 });
  if (await page.locator("#terminal").isVisible()) {
    await expect(page.getByTestId("auto-turn")).toHaveAttribute("aria-pressed", "false");
  } else {
    await page.getByTestId("auto-turn").click();
  }
  await expect(page.getByTestId("auto-turn")).toHaveAttribute("aria-pressed", "false");
});

test("grid cells remain exactly square across browser sizes", async ({ page }) => {
  for (const viewport of [{ width: 800, height: 650 }, { width: 1024, height: 700 }, { width: 1280, height: 800 }, { width: 1600, height: 1000 }]) {
    await page.setViewportSize(viewport);
    await expect(page.getByTestId("topdown-stage")).toBeVisible();
    const boxes = await page.locator(".battle-grid .field-cell").evaluateAll(cells => cells.map(cell => {
      const box = cell.getBoundingClientRect();
      return [box.width, box.height];
    }));
    expect(boxes.every(([width, height]) => Math.abs(width - height) < 0.6)).toBeTruthy();
  }
});

test("compact Fluent layout keeps primary controls inside an 800px viewport", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 650 });
  await expect(page.locator(".opponent-panel")).toBeHidden();
  const boxes = await page.locator(".battle-header, .order-panel, .topdown-stage, .battle-footer, #execute").evaluateAll(nodes =>
    nodes.map(node => {
      const box = node.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
    }),
  );
  expect(
    boxes.every(box => box.left >= 0 && box.right <= 800 && box.top >= 0 && box.bottom <= 650),
    JSON.stringify(boxes),
  ).toBeTruthy();
});
