import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(root, "src");
const read = (relative: string): string => readFileSync(resolve(root, relative), "utf8");
const collect = (directory: string): string[] => readdirSync(directory, { withFileTypes: true })
  .flatMap((entry) => entry.isDirectory()
    ? collect(resolve(directory, entry.name))
    : /\.(?:svelte|ts)$/u.test(entry.name) ? [resolve(directory, entry.name)] : []);

const html = read("index.html");
const css = read("src/styles.css");
const i18n = read("src/lib/i18n.ts");
const battleModel = read("src/lib/battle-ui-model.ts");
const api = read("src/lib/api.ts");
const state = read("src/lib/battle-state.svelte.ts");
const app = read("src/App.svelte");
const board = read("src/components/BattleBoard.svelte");
const order = read("src/components/ActionOrder.svelte");
const header = read("src/components/HeaderBar.svelte");
const footer = read("src/components/FooterSp.svelte");
const command = read("src/components/CommandSelection.svelte");
const preparation = read("src/components/dialogs/PreparationDialog.svelte");
const picker = read("src/components/dialogs/CharacterPickerDialog.svelte");
const pause = read("src/components/dialogs/PauseDialog.svelte");
const inspect = read("src/components/dialogs/InspectDialog.svelte");
const notification = read("src/components/NotificationLayer.svelte");
const costumes = read("src/components/editors/CostumeEditor.svelte");
const presentation = read("src/lib/presentation.ts");
const production = collect(sourceRoot).map((path) => readFileSync(path, "utf8")).join("\n");

describe("preserved UI contracts", () => {
  test.each([
    ["HTML", html],
    ["CSS", css],
    ["TypeScript/Svelte", production],
  ])("%s has no external HTTP asset reference", (_name, content) => {
    expect(content).not.toMatch(/https?:\/\//iu);
  });

  test("renders only repository-local generated character portraits", () => {
    const avatar = read("src/components/Avatar.svelte");
    expect(avatar).toContain("portraitPath(character)");
    expect(presentation).toContain("/assets/character-icons/64/${encodeURIComponent(character.id)}.png");
    expect(avatar).toContain("character-portrait");
    expect(avatar).not.toMatch(/image-bd2db|browndust2|https?:\/\//iu);
  });

  test("the runtime portrait bundle contains all 61 five-star characters", () => {
    const names = readdirSync(resolve(root, "public/assets/character-icons/64"))
      .filter((name) => name.endsWith(".png"));
    expect(names).toHaveLength(61);
    expect(new Set(names).size).toBe(61);
  });

  test("CSS has no raster or remote URL resources", () => expect(css).not.toMatch(/url\s*\(/iu));
  test("CSS contains no perspective transform", () => expect(css).not.toMatch(/perspective|rotateX|rotateY/iu));
  test("has no view-switch control", () => expect(production).not.toMatch(/view-toggle|ビュー切替/u));
  test("has no separate order-edit mode", () => expect(production).not.toMatch(/id="toggle-order"|順番編集/u));
  test("action-order panel has no redundant auxiliary button", () => expect(production).not.toContain("focus-first"));
  test("declares one top-down stage", () => expect(production.match(/data-testid="topdown-stage"/gu)).toHaveLength(1));
  test("exposes player and enemy grids", () => {
    expect(board).toContain('{#each ["PLAYER", "ENEMY"] as side');
    expect(board).toContain('id={typedSide === "PLAYER" ? "player-field" : "enemy-field"}');
    expect(board).toContain('role="grid"');
  });
  test("exposes live drag feedback", () => {
    expect(notification).toContain('id="drag-announcer"');
    expect(notification).toContain('aria-live="assertive"');
  });
  test("documents keyboard formation controls", () => {
    expect(i18n).toMatch(/Space.*Enter.*Esc/u);
  });
  test("has automatic skill reservation", () => {
    expect(header).toContain('id="auto-reserve"');
    expect(header).toContain("aria-pressed={model.autoReserveEnabled}");
  });
  test("has automatic turn start", () => {
    expect(header).toContain('id="auto-turn"');
    expect(header).toContain("aria-pressed={model.autoTurnEnabled}");
  });
  test("has a localized speed control", () => {
    expect(header).toContain('id="speed"');
    expect(header).toContain('t("controls.speedAria"');
  });
  test("has pause, rollback, and resume controls", () => {
    expect(header).toContain('id="open-pause"');
    expect(pause).toContain('id="rollback"');
    expect(pause).toContain('id="resume"');
  });
  test("has all four implemented modes", () => {
    for (const mode of ["NORMAL", "MIRROR_WAR", "MONSTER_CHASER", "GOLDEN_COLOSSEUM"]) {
      expect(preparation).toContain(`"${mode}"`);
    }
  });
  test("battle placement supports HTML drag and drop", () => {
    for (const event of ["ondragstart", "ondragover", "ondrop", "ondragend"]) expect(board).toContain(event);
  });
  test("battle placement supports pointer and touch-compatible input", () => {
    for (const event of ["onpointerdown", "onpointermove", "onpointerup", "onpointercancel"]) expect(board).toContain(event);
  });
  test("battle placement supports keyboard pickup, move, confirm, and cancel", () => {
    for (const key of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "Escape"]) expect(board).toContain(key);
  });
  test("battle execution sends planned formation to the simulator", () => {
    expect(state).toContain("battleApi.step(");
    expect(state).toContain("serializeFormation(this.plannedFormation");
  });
  test("Mirror War uses the simulator capability lock", () => {
    expect(board).toContain("model.capabilities.formation");
    expect(state).toContain("this.capabilities.formation");
  });
  test("formation editor supports occupied-cell swapping", () => {
    expect(state).toMatch(/occupiedIndex[\s\S]+occupied\.row = source\.row/u);
  });
  test("actionable order cards are draggable and inactive cards are disabled", () => {
    expect(order).toContain("draggable={actionable && model.capabilities.manualPlayer}");
    expect(order).toContain("disabled={!actionable}");
  });
  test("attack order has no visible up/down button implementation", () => {
    expect(order).not.toMatch(/order-controls|data-up|data-down/u);
  });
  test("all battle and formation cells preserve a square aspect ratio", () => {
    expect(css).toMatch(/\.field-cell, \.formation-cell[\s\S]*?aspect-ratio:\s*1/u);
    expect(css).not.toMatch(/\.battle-grid\s*\{[^}]*grid-template-rows/u);
  });
  test("range preview uses the authoritative simulator endpoint", () => {
    expect(api).toContain('"/api/preview"');
    expect(state).toContain("projectRangeCells");
  });
  test("authoritative preview renders per-target and total predicted damage", () => {
    expect(header).toContain('id="selected-damage"');
    expect(board).toContain("preview?.damage_by_target");
    expect(state).toContain("preview?.total_damage");
    expect(board).toContain("predicted-damage-${unit.id}");
    expect(i18n).toContain('"selection.predictedDamage"');
  });
  test("knockback cards use each character's external-data direction", () => {
    expect(presentation).toContain("entityById(catalog, unit.character_id)?.knockback_direction");
    expect(command).toContain("knockbackDirection={meta.knockback_direction}");
    for (const direction of ["BACK", "FRONT", "UP", "DOWN", "UP_BACK", "DOWN_BACK", "UP_FRONT", "DOWN_FRONT"]) {
      expect(i18n).toContain(`"knockback.${direction}"`);
    }
  });
  test("battle events are replayed sequentially with visible cues", () => {
    expect(board).toContain('id="battle-cue"');
    expect(board).toContain('id="target-line"');
    expect(state).toContain("private async playEvents");
    expect(state).toContain('case "DAMAGE_APPLIED"');
    expect(state).toContain("return this.animationSleep");
  });
  test("speed and pause control the playback state", () => {
    expect(state).toContain("remaining -= (now - previous) * this.speed");
    expect(state).toContain("this.paused = this.executing");
  });
  test("five-star unit addition opens a searchable character picker", () => {
    expect(picker).toContain('id="character-picker"');
    expect(picker).toContain('id="character-search"');
    expect(picker).toContain("model.catalog?.characters");
    expect(picker).toContain("character-option-${character.id}");
  });
  test("UI copy is managed through the Japanese i18n resource", () => {
    expect(app).toContain('import { t } from "./lib/i18n"');
    expect(i18n).toContain('"ja-JP"');
    expect(i18n).toContain("selector.NEXT_ALLY_IN_ORDER");
    for (const path of collect(sourceRoot).filter((path) => !path.endsWith("i18n.ts"))) {
      expect(readFileSync(path, "utf8"), path).not.toMatch(/[ぁ-んァ-ヶ一-龯]/u);
    }
  });
  test("visual tokens use Fluent surfaces plus five distinct element colors", () => {
    expect(css).toContain("Fluent 2 component system");
    expect(css).toMatch(/--accent:\s*#c8cdd2/u);
    expect(css).toMatch(/--panel:\s*#202020/u);
    for (const element of ["fire", "water", "wind", "light", "dark"]) {
      expect(css).toContain(`--element-${element}:`);
      expect(css).toContain(`data-active-element="${element}"`);
    }
    const colors = [...css.matchAll(/--element-(?:fire|water|wind|light|dark):\s*(#[0-9a-f]{6})/giu)]
      .map((match) => match[1]?.toLowerCase());
    expect(new Set(colors).size).toBe(5);
    expect(css).not.toMatch(/gradient|Georgia|--gold/iu);
  });
  test("SP reservation is checked before changing command state", () => {
    expect(state).toContain('reason === "INSUFFICIENT_SP"');
  });
  test("global SP HUD uses centered diamonds without category counters", () => {
    for (const id of ["sp-text", "sp-status", "sp-pips"]) expect(footer).toContain(`id="${id}"`);
    for (const removed of ["sp-remaining", "sp-consumed", "sp-burst", "sp-metric"]) expect(footer).not.toContain(removed);
    expect(css).toMatch(/\.sp-panel\s*\{[^}]*justify-self:\s*center/u);
    expect(css).toMatch(/\.sp-pips i\s*\{[^}]*transform:\s*rotate\(45deg\)/u);
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(state).toContain("plannedBurstSpCost");
    expect(state).toContain("spBreakdown");
    expect(battleModel).toContain("CURRENT_SP_CAP = 20");
  });
  test("burst-capable costume cards expose localized previous and next stage controls", () => {
    expect(command).toContain("burstOptionsForCostume");
    expect(command).toContain("burst-arrow burst-down");
    expect(command).toContain("burst-arrow burst-up");
    for (const key of ["action.burstNone", "action.burstLevel", "action.burstDecreaseAria", "action.burstIncreaseAria"]) {
      expect(i18n).toContain(`"${key}"`);
    }
  });
  test("build editor exposes three independent Goddess Tear nodes and durable setup controls", () => {
    expect(costumes).toContain("definition.goddess_tear_nodes");
    expect(costumes).toContain("item.potential_mask = event.currentTarget.checked");
    expect(costumes).toContain("goddess-tear-${definition.id}-${node.index}");
    expect(costumes).toContain("costume-enhancement-${definition.id}");
    expect(costumes).toContain("costume-burst-${definition.id}");
    for (const id of ["saved-setup-name", "saved-setup-list", "save-setup", "load-setup"]) expect(preparation).toContain(`id="${id}"`);
    expect(api).toContain('"/api/save-setup"');
    expect(api).toContain('"/api/load-setup"');
  });
  test("automatic turn start is cancellable", () => expect(state).toContain("window.clearTimeout(this.autoTimer)"));
  test("terminal state disables turn execution", () => expect(footer).toContain("Boolean(model.snapshot?.state.terminal)"));
  test("server-side rollback is wired to the pause menu", () => {
    expect(api).toContain('"/api/rollback"');
    expect(pause).toContain("model.rollbackBattle");
  });
  test("battle log and terminal cues localize engine enums instead of exposing raw JSON", () => {
    expect(production).not.toContain("JSON.stringify(kind)");
    expect(presentation).toContain('t("event.battleEnded"');
    expect(presentation).toContain("battle.outcome.${result}");
  });
  test("unit inspection summarizes typed effects without exposing internal effect ids", () => {
    expect(inspect).toContain("unit.effects.map(effectLabel)");
    expect(inspect).not.toMatch(/effect\.effect_id\s*\|\|\s*effect\.id/u);
  });
  test("superseded target previews are debounced and aborted before they can saturate play", () => {
    expect(state).toContain("this.previewController?.abort()");
    expect(state).toContain("new AbortController()");
    expect(state).toContain("this.previewTimer = window.setTimeout");
    expect(state).toContain("controller.signal");
  });
});
