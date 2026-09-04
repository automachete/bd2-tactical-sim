import assert from "node:assert/strict";
import { test } from "vitest";
import type { BattleMode, Cell, ModeCapabilities } from "../src/lib/types";

import {
  actionIndices,
  autoReserve,
  burstOptionsForCostume,
  cellKey,
  commandBurstCost,
  commandCost,
  CURRENT_SP_CAP,
  isValidCell,
  keyboardTarget,
  knockbackPreviewCells,
  knockbackPresentation,
  modeCapabilities,
  moveFormation,
  nextSpeed,
  normalizeFormation,
  occupantAt,
  playbackDelay,
  plannedBurstSpCost,
  plannedSpCost,
  rangePreviewCells,
  reorder,
  selectCommand,
  serializeFormation,
  spBreakdown,
} from "../src/lib/battle-ui-model";

const legal = new Map([
  [1, { commands: [{ type: "NORMAL_ATTACK" }, { type: "USE_COSTUME", costume_id: "a", ui: { sp_cost: 4, burst_sp_cost: 0 } }] }],
  [2, { commands: [{ type: "NORMAL_ATTACK" }, { type: "USE_COSTUME", costume_id: "b", ui: { sp_cost: 3, burst_sp_cost: 0 } }] }],
]);
const legalById = (unitId: number | string) => legal.get(Number(unitId));
const costumes: Record<string, { sp_cost: number }> = { a: { sp_cost: 4 }, b: { sp_cost: 3 } };
const costumeLookup = (id: string) => costumes[id];

test("cellKey normalizes numeric strings", () => assert.equal(cellKey("1", "2"), "1,2"));

const validCellCases: Array<[number, number, boolean]> = [
  [0, 0, true], [2, 3, true], [1, 2, true], [-1, 0, false], [3, 0, false],
  [0, 4, false], [0.5, 0, false], [0, Number.NaN, false],
];
for (const [row, depth, expected] of validCellCases) {
  test(`isValidCell(${row}, ${depth}) is ${expected}`, () => assert.equal(isValidCell(row, depth), expected));
}

test("normalizeFormation accepts runtime positions", () => {
  assert.deepEqual(normalizeFormation([{ id: 7, position: { row: 2, depth: 1 } }]), { "7": { row: 2, depth: 1 } });
});

test("normalizeFormation accepts setup units and filters parties", () => {
  const units = [
    { character_id: "A", row: 0, depth: 0, party_no: 1 },
    { character_id: "B", row: 1, depth: 1, party_no: 2 },
  ];
  assert.deepEqual(normalizeFormation(units, 2), { B: { row: 1, depth: 1 } });
});

test("occupantAt finds a unit", () => assert.equal(occupantAt({ 1: { row: 0, depth: 0 } }, 0, 0), "1"));
test("occupantAt excludes the dragged unit", () => assert.equal(occupantAt({ 1: { row: 0, depth: 0 } }, 0, 0, 1), null));
test("occupantAt returns null for empty cell", () => assert.equal(occupantAt({ 1: { row: 0, depth: 0 } }, 2, 3), null));

test("moveFormation moves onto an empty cell without mutating input", () => {
  const source = { 1: { row: 0, depth: 0 }, 2: { row: 1, depth: 0 } };
  const result = moveFormation(source, 1, 2, 3);
  assert.deepEqual(result.formation["1"], { row: 2, depth: 3 });
  assert.deepEqual(source[1], { row: 0, depth: 0 });
  assert.equal(result.swappedUnitId, null);
});

test("moveFormation swaps two occupied cells", () => {
  const result = moveFormation({ 1: { row: 0, depth: 0 }, 2: { row: 1, depth: 2 } }, 1, 1, 2);
  assert.deepEqual(result.formation, { 1: { row: 1, depth: 2 }, 2: { row: 0, depth: 0 } });
  assert.equal(result.swappedUnitId, "2");
});

test("moveFormation reports a no-op", () => assert.equal(moveFormation({ 1: { row: 0, depth: 0 } }, 1, 0, 0).moved, false));
test("moveFormation rejects an unknown unit", () => assert.throws(() => moveFormation({}, 1, 0, 0), /unknown/));
test("moveFormation rejects an invalid row", () => assert.throws(() => moveFormation({ 1: { row: 0, depth: 0 } }, 1, 3, 0), /invalid/));
test("moveFormation rejects an invalid depth", () => assert.throws(() => moveFormation({ 1: { row: 0, depth: 0 } }, 1, 0, 4), /invalid/));
test("moveFormation can reject occupied cells", () => assert.throws(() => moveFormation({ 1: { row: 0, depth: 0 }, 2: { row: 1, depth: 0 } }, 1, 1, 0, { swap: false }), /occupied/));

test("serializeFormation converts values to numbers", () => {
  assert.deepEqual(serializeFormation({ 1: { row: "2", depth: "3" } }), { 1: { row: 2, depth: 3 } });
});
test("serializeFormation filters disallowed unit ids", () => {
  assert.deepEqual(serializeFormation({ 1: { row: 0, depth: 0 }, 2: { row: 1, depth: 1 } }, [2]), { 2: { row: 1, depth: 1 } });
});

const knockbackVectorCases: Array<[Cell, string, Cell]> = [
  [{ row: -1, depth: -1 }, "↖", { row: 0, depth: 0 }],
  [{ row: -1, depth: 0 }, "↑", { row: 0, depth: 1 }],
  [{ row: -1, depth: 1 }, "↗", { row: 0, depth: 2 }],
  [{ row: 0, depth: -1 }, "←", { row: 1, depth: 0 }],
  [{ row: 0, depth: 1 }, "→", { row: 1, depth: 2 }],
  [{ row: 1, depth: -1 }, "↙", { row: 2, depth: 0 }],
  [{ row: 1, depth: 0 }, "↓", { row: 2, depth: 1 }],
  [{ row: 1, depth: 1 }, "↘", { row: 2, depth: 2 }],
];
for (const [offset, arrow, destination] of knockbackVectorCases) {
  test(`authoritative knockback vector ${offset.row},${offset.depth} has the matching arrow and mini-grid destination`, () => {
    assert.deepEqual(knockbackPresentation("BACK", offset), { direction: "BACK", arrow, distance: 1, ...offset });
    const preview = knockbackPreviewCells("BACK", offset);
    assert.deepEqual(preview.origin, { row: 1, depth: 1 });
    assert.deepEqual(preview.destination, destination);
  });
}

test("all external direction labels are retained without redefining their vectors in the UI", () => {
  for (const direction of ["BACK", "FRONT", "UP", "DOWN", "UP_BACK", "DOWN_BACK", "UP_FRONT", "DOWN_FRONT"] as const) {
    assert.equal(knockbackPresentation(direction, { row: 0, depth: 1 }).direction, direction);
  }
});

test("unknown directions and missing or invalid authoritative vectors fail closed", () => {
  assert.throws(() => knockbackPresentation("INVALID", { row: 0, depth: 1 }), /Unsupported knockback direction/);
  assert.throws(() => knockbackPresentation(undefined, { row: 0, depth: 1 }), /Unsupported knockback direction/);
  assert.throws(() => knockbackPresentation("BACK", undefined), /Missing authoritative knockback offset/);
  assert.throws(() => knockbackPresentation("BACK", { row: 0, depth: 0 }), /Unsupported knockback offset/);
});

const reorderCases: Array<[number, number, number[]]> = [
  [2, -1, [2, 1, 3]], [2, 1, [1, 3, 2]], [1, -1, [1, 2, 3]], [3, 1, [1, 2, 3]], [9, 1, [1, 2, 3]],
];
for (const [unitId, direction, expected] of reorderCases) {
  test(`reorder ${unitId} by ${direction}`, () => assert.deepEqual(reorder([1, 2, 3], unitId, direction), expected));
}

test("commandCost charges only costumes", () => {
  assert.equal(commandCost({ type: "USE_COSTUME", costume_id: "a", ui: { sp_cost: 4 } }, costumeLookup), 4);
  assert.equal(commandCost({ type: "NORMAL_ATTACK" }, costumeLookup), 0);
});

test("commandCost prefers exact runtime variant metadata over catalog maximum", () => {
  assert.equal(commandCost({ type: "USE_COSTUME", costume_id: "a", ui: { sp_cost: 2 } }, costumeLookup), 2);
});

test("commandBurstCost reads only the additional burst portion of costume SP", () => {
  assert.equal(commandBurstCost({ type: "USE_COSTUME", ui: { sp_cost: 6, burst_sp_cost: 3 } }), 3);
  assert.equal(commandBurstCost({ type: "NORMAL_ATTACK", ui: { burst_sp_cost: 9 } }), 0);
  assert.throws(() => commandBurstCost({ type: "USE_COSTUME", costume_id: "missing" }), /resolved burst SP cost/);
});

test("SP planning rejects missing runtime metadata and legal-action records", () => {
  assert.throws(
    () => commandCost({ type: "USE_COSTUME", costume_id: "missing" }, costumeLookup),
    /resolved SP cost/,
  );
  assert.throws(
    () => plannedSpCost([99], new Map(), legalById, costumeLookup),
    /missing legal actions/,
  );
});

test("burstOptionsForCostume returns every stage in order and prefers legal variants", () => {
  const commands = [
    { type: "NORMAL_ATTACK" },
    { type: "USE_COSTUME", costume_id: "a", burst_level: 0 },
    { type: "USE_COSTUME", costume_id: "a", burst_level: 1 },
    { type: "USE_COSTUME", costume_id: "b", burst_level: 0 },
  ];
  const unavailable = [
    { type: "USE_COSTUME", costume_id: "a", burst_level: 1, unavailable_reason: "MASKED" },
    { type: "USE_COSTUME", costume_id: "a", burst_level: 2, unavailable_reason: "INSUFFICIENT_SP" },
  ];
  assert.deepEqual(
    burstOptionsForCostume(commands, unavailable, "a").map(option => ({
      level: option.level,
      index: option.index,
      available: option.available,
    })),
    [
      { level: 0, index: 1, available: true },
      { level: 1, index: 2, available: true },
      { level: 2, index: null, available: false },
    ],
  );
});

test("plannedSpCost follows selected action indexes", () => {
  assert.equal(plannedSpCost([1, 2], new Map([[1, 1], [2, 1]]), legalById, costumeLookup), 7);
});

test("plannedBurstSpCost follows selected exact runtime variants", () => {
  const burstLegal = new Map([
    [1, { commands: [{ type: "NORMAL_ATTACK" }, { type: "USE_COSTUME", ui: { sp_cost: 6, burst_sp_cost: 3 } }] }],
    [2, { commands: [{ type: "USE_COSTUME", ui: { sp_cost: 2, burst_sp_cost: 1 } }] }],
  ]);
  assert.equal(plannedBurstSpCost([1, 2], new Map([[1, 1], [2, 0]]), id => burstLegal.get(Number(id))), 4);
});

test("spBreakdown keeps remaining, regular consumption, and burst consumption disjoint", () => {
  assert.deepEqual(spBreakdown({ current: 15, reserved: 6, burst: 3, cap: 20 }), {
    cap: 20,
    current: 15,
    remaining: 9,
    consumed: 6,
    regularConsumed: 3,
    burst: 3,
  });
});

test("spBreakdown rejects corrupt state instead of hiding it in the HUD", () => {
  assert.equal(CURRENT_SP_CAP, 20);
  assert.throws(() => spBreakdown({ current: 21, reserved: 0, burst: 0, cap: 20 }), /outside/);
  assert.throws(() => spBreakdown({ current: -1, reserved: 0, burst: 0, cap: 20 }), /outside/);
  assert.throws(() => spBreakdown({ current: 20, reserved: 21, burst: 0, cap: 20 }), /reserved/);
  assert.throws(() => spBreakdown({ current: 20, reserved: 5, burst: 6, cap: 20 }), /burst/);
  assert.throws(() => spBreakdown({ current: 20, reserved: 0, burst: 0, cap: 21 }), /cap/);
  assert.throws(() => spBreakdown({ current: 20.5, reserved: 0, burst: 0, cap: 20 }), /integers/);
});

test("selectCommand accepts an affordable command", () => {
  const result = selectCommand({ order: [1, 2], selections: new Map([[1, 0], [2, 0]]), legalById, costumeLookup, sp: 4 }, 1, 1);
  assert.equal(result.accepted, true);
  assert.equal(result.selections.get(1), 1);
});

test("selectCommand preserves state when SP is insufficient", () => {
  const selections = new Map([[1, 0], [2, 1]]);
  const result = selectCommand({ order: [1, 2], selections, legalById, costumeLookup, sp: 6 }, 1, 1);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "INSUFFICIENT_SP");
  assert.equal(result.selections.get(1), 0);
});

test("selectCommand rejects a masked action", () => {
  const result = selectCommand({ order: [1], selections: new Map(), legalById, costumeLookup, sp: 20 }, 1, 99);
  assert.deepEqual({ accepted: result.accepted, reason: result.reason }, { accepted: false, reason: "MASKED_ACTION" });
});

test("autoReserve selects affordable costume skills in order", () => {
  const result = autoReserve({ order: [1, 2], selections: new Map(), legalById, costumeLookup, sp: 7 });
  assert.deepEqual([...result.entries()], [[1, 1], [2, 1]]);
});

test("autoReserve falls back to normal attacks without enough SP", () => {
  const result = autoReserve({ order: [1, 2], selections: new Map(), legalById, costumeLookup, sp: 2 });
  assert.deepEqual([...result.entries()], [[1, 0], [2, 0]]);
});

test("autoReserve spends remaining SP on later affordable skills", () => {
  const result = autoReserve({ order: [1, 2], selections: new Map(), legalById, costumeLookup, sp: 3 });
  assert.deepEqual([...result.entries()], [[1, 0], [2, 1]]);
});

test("autoReserve preserves a manually preferred affordable costume instead of replacing it by cost", () => {
  const localLegal = new Map([
    [1, { commands: [
      { type: "NORMAL_ATTACK" },
      { type: "USE_COSTUME", costume_id: "a", ui: { sp_cost: 4 } },
      { type: "USE_COSTUME", costume_id: "c", ui: { sp_cost: 2 } },
    ] }],
  ]);
  const result = autoReserve({
    order: [1],
    selections: new Map([[1, 2]]),
    legalById: unitId => localLegal.get(Number(unitId)),
    costumeLookup,
    sp: 4,
  });
  assert.deepEqual([...result.entries()], [[1, 2]]);
});

test("autoReserve follows costume order when there is no prior manual preference", () => {
  const localLegal = new Map([
    [1, { commands: [
      { type: "NORMAL_ATTACK" },
      { type: "USE_COSTUME", costume_id: "c", ui: { sp_cost: 2 } },
      { type: "USE_COSTUME", costume_id: "a", ui: { sp_cost: 4 } },
    ] }],
  ]);
  const result = autoReserve({
    order: [1],
    selections: new Map([[1, 0]]),
    legalById: unitId => localLegal.get(Number(unitId)),
    costumeLookup,
    sp: 4,
  });
  assert.deepEqual([...result.entries()], [[1, 1]]);
});

test("rangePreviewCells centers relative offsets instead of treating them as absolute cells", () => {
  const range = [
    { row: -1, depth: 0 }, { row: 0, depth: -1 }, { row: 0, depth: 0 },
    { row: 0, depth: 1 }, { row: 1, depth: 0 }, { row: 0, depth: 0 },
  ];
  assert.deepEqual([...rangePreviewCells(range)].sort(), ["0,1", "1,0", "1,1", "1,2", "2,1"]);
});

test("range helpers reject missing and malformed battle metadata", () => {
  assert.throws(() => rangePreviewCells(undefined), /array/);
  assert.throws(() => rangePreviewCells([{ row: 0, depth: "unknown" }]), /integer/);
});

test("long mixed command-selection sequences never overspend or mutate rejected state", () => {
  let selections = new Map([[1, 0], [2, 0]]);
  const attempts: Array<[number, number]> = [[1, 1], [2, 1], [1, 0], [2, 0], [2, 1], [1, 1], [1, 0]];
  for (const [unitId, index] of attempts) {
    const before = new Map(selections);
    const result = selectCommand({ order: [1, 2], selections, legalById, costumeLookup, sp: 6 }, unitId, index);
    if (!result.accepted) assert.deepEqual(result.selections, before);
    selections = result.selections;
    assert.ok(plannedSpCost([1, 2], selections, legalById, costumeLookup) <= 6);
  }
});

const modeCases: Array<[BattleMode, boolean, ModeCapabilities]> = [
  ["NORMAL", true, { formation: true, mctsOpponent: true, ruleBasedOpponent: false, automaticBattle: false, twoPlayerParties: false, manualPlayer: true }],
  ["MIRROR_WAR", false, { formation: false, mctsOpponent: true, ruleBasedOpponent: false, automaticBattle: false, twoPlayerParties: false, manualPlayer: true }],
  ["MONSTER_CHASER", true, { formation: true, mctsOpponent: false, ruleBasedOpponent: true, automaticBattle: false, twoPlayerParties: true, manualPlayer: true }],
  ["GOLDEN_COLOSSEUM", false, { formation: false, mctsOpponent: false, ruleBasedOpponent: false, automaticBattle: true, twoPlayerParties: false, manualPlayer: false }],
];
for (const [mode, formation, expected] of modeCases) {
  test(`modeCapabilities describes ${mode}`, () => assert.deepEqual(modeCapabilities(mode, formation), expected));
}

const keyboardCases: Array<[string, Cell]> = [
  ["ArrowUp", { row: 0, depth: 2 }], ["ArrowDown", { row: 2, depth: 2 }],
  ["ArrowLeft", { row: 1, depth: 1 }], ["ArrowRight", { row: 1, depth: 3 }],
  ["Escape", { row: 1, depth: 2 }],
];
for (const [key, expected] of keyboardCases) {
  test(`keyboardTarget handles ${key}`, () => assert.deepEqual(keyboardTarget({ row: 1, depth: 2 }, key), expected));
}

test("keyboardTarget clamps at all board edges", () => {
  assert.deepEqual(keyboardTarget({ row: 0, depth: 0 }, "ArrowUp"), { row: 0, depth: 0 });
  assert.deepEqual(keyboardTarget({ row: 2, depth: 3 }, "ArrowRight"), { row: 2, depth: 3 });
});

const speedCases: Array<[number, number]> = [[1, 2], [2, 3], [3, 1], [99, 1]];
for (const [speed, expected] of speedCases) {
  test(`nextSpeed maps ${speed} to ${expected}`, () => assert.equal(nextSpeed(speed), expected));
}

test("playbackDelay makes the speed selector control real event timing", () => {
  assert.equal(playbackDelay(900, 1), 900);
  assert.equal(playbackDelay(900, 2), 450);
  assert.equal(playbackDelay(900, 3), 300);
});

test("actionIndices serialize order-indexed command choices", () => {
  assert.deepEqual(actionIndices([2, 1], new Map([[1, 2], [2, 1]])), [1, 2]);
});
