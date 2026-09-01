import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const html = readFileSync(`${root}/index.html`, "utf8");
const css = readFileSync(`${root}/styles.css`, "utf8");
const app = readFileSync(`${root}/app.js`, "utf8");
const i18n = readFileSync(`${root}/i18n.mjs`, "utf8");

for (const [name, content] of [["HTML", html], ["CSS", css], ["JavaScript", app]]) {
  test(`${name} has no external HTTP asset reference`, () => assert.doesNotMatch(content, /https?:\/\//i));
}

test("HTML contains no image elements", () => assert.doesNotMatch(html, /<img\b/i));
test("JavaScript never creates image elements", () => assert.doesNotMatch(app, /createElement\(["']img["']\)/i));
test("CSS has no raster or remote URL resources", () => assert.doesNotMatch(css, /url\s*\(/i));
test("CSS contains no perspective transform", () => assert.doesNotMatch(css, /perspective|rotateX|rotateY/i));
test("HTML has no view-switch control", () => assert.doesNotMatch(html, /view-toggle|ビュー切替/));
test("HTML has no separate order-edit mode", () => assert.doesNotMatch(html, /id="toggle-order"|順番編集/));
test("action-order panel has no redundant auxiliary button", () => assert.doesNotMatch(html, /id="focus-first"/));
test("HTML declares one top-down stage", () => assert.match(html, /data-testid="topdown-stage"/));
test("HTML exposes a player grid", () => assert.match(html, /id="player-field"[^>]+role="grid"/));
test("HTML exposes an enemy grid", () => assert.match(html, /id="enemy-field"[^>]+role="grid"/));
test("HTML exposes live drag feedback", () => assert.match(html, /id="drag-announcer"[^>]+aria-live="assertive"/));
test("HTML documents keyboard formation controls", () => assert.match(html, /Space.*Enter.*Esc/));
test("HTML has automatic skill reservation", () => assert.match(html, /id="auto-reserve"[^>]+aria-pressed="false"/));
test("HTML has automatic turn start", () => assert.match(html, /id="auto-turn"[^>]+aria-pressed="false"/));
test("HTML has speed control", () => assert.match(html, /id="speed"[^>]+aria-label="演出速度 1倍"/));
test("HTML has pause, rollback, and resume controls", () => {
  assert.match(html, /id="open-pause"/);
  assert.match(html, /id="rollback"/);
  assert.match(html, /id="resume"/);
});
test("HTML has all three requested modes", () => {
  for (const mode of ["NORMAL", "MIRROR_WAR", "MONSTER_CHASER"]) assert.match(html, new RegExp(`data-mode="${mode}"`));
});
test("battle placement supports HTML drag and drop", () => {
  for (const event of ["dragstart", "dragover", "drop", "dragend"]) assert.match(app, new RegExp(`addEventListener\\("${event}"`));
});
test("battle placement supports pointer and touch-compatible input", () => {
  for (const event of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) assert.match(app, new RegExp(`addEventListener\\("${event}"`));
});
test("battle placement supports keyboard pickup, move, confirm, and cancel", () => {
  for (const key of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "Escape"]) assert.match(app, new RegExp(key));
});
test("battle execution sends planned formation to the simulator", () => {
  assert.match(app, /serializeFormation\(plannedFormation/);
  assert.match(app, /formation,/);
  assert.match(app, /api\("\/api\/step"/);
});
test("Mirror War uses the simulator capability lock", () => assert.match(app, /capabilities\(\)\.formation/));
test("formation editor supports occupied-cell swapping", () => assert.match(app, /occupiedIndex[\s\S]+draft\[sideKey\]\[occupiedIndex\]\.row = source\.row/));
test("attack order cards are draggable", () => assert.match(app, /card\.draggable = true/));
test("attack order has no visible up/down button implementation", () => assert.doesNotMatch(app, /order-controls|data-up|data-down/));
test("all battle and formation cells preserve a square aspect ratio", () => {
  assert.match(css, /\.field-cell, \.formation-cell[\s\S]*?aspect-ratio:\s*1/);
  assert.doesNotMatch(css, /\.battle-grid\s*\{[^}]*grid-template-rows/);
});
test("range preview uses the authoritative simulator endpoint", () => {
  assert.match(app, /silentApi\("\/api\/preview"/);
  assert.match(app, /projectRangeCells/);
});
test("battle events are replayed sequentially with visible cues", () => {
  assert.match(html, /id="battle-cue"/);
  assert.match(html, /id="target-line"/);
  assert.match(app, /playBattleEvents/);
  assert.match(app, /DAMAGE_APPLIED/);
  assert.match(app, /animationSleep/);
});
test("speed and pause control the playback state", () => {
  assert.match(app, /remaining -= \(now - previous\) \* speedValue/);
  assert.match(app, /animationPaused = animationRunning/);
});
test("five-star unit addition opens a searchable character picker", () => {
  assert.match(html, /id="character-picker"/);
  assert.match(html, /id="character-search"/);
  assert.match(app, /catalog\.characters[\s\S]+character-option/);
});
test("UI copy is managed through the Japanese i18n resource", () => {
  assert.match(app, /from "\.\/i18n\.mjs"/);
  assert.match(html, /data-i18n=/);
  assert.match(i18n, /"ja-JP"/);
  assert.match(i18n, /selector\.NEXT_ALLY_IN_ORDER/);
  assert.doesNotMatch(app, /[\u3040-\u30ff\u3400-\u9fff]/);
});
test("visual tokens use a Fluent-style neutral surface and one blue accent", () => {
  assert.match(css, /Fluent 2 component system/);
  assert.match(css, /--accent:\s*#60cdff/);
  assert.match(css, /--panel:\s*#202020/);
  assert.doesNotMatch(css, /gradient|Georgia|--gold/);
});
test("SP reservation is checked before changing command state", () => assert.match(app, /reason === "INSUFFICIENT_SP"/));
test("automatic turn start is cancellable", () => assert.match(app, /clearTimeout\(autoTurnTimer\)/));
test("terminal state disables turn execution", () => assert.match(app, /Boolean\(snapshot\.state\.terminal\)/));
test("server-side rollback is wired to the pause menu", () => assert.match(app, /api\("\/api\/rollback"/));
test("battle log and terminal cues localize engine enums instead of exposing raw JSON", () => {
  assert.doesNotMatch(app, /JSON\.stringify\(kind\)/);
  assert.match(app, /event\.battleEnded/);
  assert.match(app, /battle\.outcome\.\$\{kind\.result\?\.outcome\}/);
});
test("unit inspection summarizes typed effects without exposing internal effect ids", () => {
  assert.match(app, /effectLabel\(effect\)/);
  assert.doesNotMatch(app, /effect\.effect_id \|\| effect\.id/);
});
test("superseded target previews are debounced and aborted before they can saturate play", () => {
  assert.match(app, /previewController\?\.abort\(\)/);
  assert.match(app, /new AbortController\(\)/);
  assert.match(app, /previewTimer = window\.setTimeout/);
  assert.match(app, /controller\.signal/);
});
