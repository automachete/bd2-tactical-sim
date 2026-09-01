import assert from "node:assert/strict";
import test from "node:test";

import {
  actionIndices,
  autoReserve,
  cellKey,
  commandCost,
  isValidCell,
  keyboardTarget,
  modeCapabilities,
  moveFormation,
  nextSpeed,
  normalizeFormation,
  occupantAt,
  playbackDelay,
  plannedSpCost,
  projectRangeCells,
  rangePreviewCells,
  reorder,
  selectCommand,
  serializeFormation,
} from "../battle-ui-model.mjs";

const legal = new Map([
  [1, { commands: [{ type: "NORMAL_ATTACK" }, { type: "USE_COSTUME", costume_id: "a" }, { type: "WAIT" }] }],
  [2, { commands: [{ type: "NORMAL_ATTACK" }, { type: "USE_COSTUME", costume_id: "b" }, { type: "WAIT" }] }],
]);
const legalById = unitId => legal.get(Number(unitId));
const costumes = { a: { sp_cost: 4 }, b: { sp_cost: 3 } };
const costumeLookup = id => costumes[id];

test("cellKey normalizes numeric strings", () => assert.equal(cellKey("1", "2"), "1,2"));

for (const [row, depth, expected] of [
  [0, 0, true], [2, 3, true], [1, 2, true], [-1, 0, false], [3, 0, false],
  [0, 4, false], [0.5, 0, false], [0, Number.NaN, false],
]) {
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

for (const [unitId, direction, expected] of [
  [2, -1, [2, 1, 3]], [2, 1, [1, 3, 2]], [1, -1, [1, 2, 3]], [3, 1, [1, 2, 3]], [9, 1, [1, 2, 3]],
]) {
  test(`reorder ${unitId} by ${direction}`, () => assert.deepEqual(reorder([1, 2, 3], unitId, direction), expected));
}

test("commandCost charges only costumes", () => {
  assert.equal(commandCost({ type: "USE_COSTUME", costume_id: "a" }, costumeLookup), 4);
  assert.equal(commandCost({ type: "NORMAL_ATTACK" }, costumeLookup), 0);
  assert.equal(commandCost({ type: "WAIT" }, costumeLookup), 0);
});

test("commandCost prefers exact runtime variant metadata over catalog maximum", () => {
  assert.equal(commandCost({ type: "USE_COSTUME", costume_id: "a", ui: { sp_cost: 2 } }, costumeLookup), 2);
});

test("plannedSpCost follows selected action indexes", () => {
  assert.equal(plannedSpCost([1, 2], new Map([[1, 1], [2, 1]]), legalById, costumeLookup), 7);
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

test("projectRangeCells anchors offsets to the Rust-resolved target and clips board edges", () => {
  const cells = projectRangeCells(
    [{ row: -1, depth: 0 }, { row: 0, depth: 0 }, { row: 1, depth: 0 }],
    { row: 0, depth: 2 },
  );
  assert.deepEqual([...cells].sort(), ["0,2", "1,2"]);
});

test("projectRangeCells can represent an all-target skill", () => {
  assert.equal(projectRangeCells([], { row: 0, depth: 0 }, { targetAll: true }).size, 12);
});

test("projectRangeCells agrees with an independent exhaustive reference at every board anchor", () => {
  const ranges = [
    [{ row: 0, depth: 0 }],
    [{ row: -2, depth: 0 }, { row: -1, depth: 0 }, { row: 0, depth: 0 }, { row: 1, depth: 0 }, { row: 2, depth: 0 }],
    [
      { row: -1, depth: -1 }, { row: -1, depth: 0 }, { row: -1, depth: 1 },
      { row: 0, depth: -1 }, { row: 0, depth: 0 }, { row: 0, depth: 1 },
      { row: 1, depth: -1 }, { row: 1, depth: 0 }, { row: 1, depth: 1 },
    ],
    [{ row: 0, depth: -3 }, { row: 0, depth: 0 }, { row: 0, depth: 3 }],
  ];
  for (let row = 0; row < 3; row += 1) {
    for (let depth = 0; depth < 4; depth += 1) {
      for (const range of ranges) {
        const expected = new Set(range
          .map(offset => ({ row: row + offset.row, depth: depth + offset.depth }))
          .filter(cell => cell.row >= 0 && cell.row < 3 && cell.depth >= 0 && cell.depth < 4)
          .map(cell => `${cell.row},${cell.depth}`));
        assert.deepEqual(projectRangeCells(range, { row, depth }), expected);
      }
    }
  }
});

test("long mixed command-selection sequences never overspend or mutate rejected state", () => {
  let selections = new Map([[1, 0], [2, 0]]);
  const attempts = [[1, 1], [2, 1], [1, 0], [2, 0], [2, 1], [1, 1], [1, 0]];
  for (const [unitId, index] of attempts) {
    const before = new Map(selections);
    const result = selectCommand({ order: [1, 2], selections, legalById, costumeLookup, sp: 6 }, unitId, index);
    if (!result.accepted) assert.deepEqual(result.selections, before);
    selections = result.selections;
    assert.ok(plannedSpCost([1, 2], selections, legalById, costumeLookup) <= 6);
  }
});

for (const [mode, formation, expected] of [
  ["NORMAL", true, { formation: true, mctsOpponent: true, ruleBasedOpponent: false, twoPlayerParties: false, manualPlayer: true }],
  ["MIRROR_WAR", false, { formation: false, mctsOpponent: true, ruleBasedOpponent: false, twoPlayerParties: false, manualPlayer: true }],
  ["MONSTER_CHASER", true, { formation: true, mctsOpponent: false, ruleBasedOpponent: true, twoPlayerParties: true, manualPlayer: true }],
]) {
  test(`modeCapabilities describes ${mode}`, () => assert.deepEqual(modeCapabilities(mode, formation), expected));
}

for (const [key, expected] of [
  ["ArrowUp", { row: 0, depth: 2 }], ["ArrowDown", { row: 2, depth: 2 }],
  ["ArrowLeft", { row: 1, depth: 1 }], ["ArrowRight", { row: 1, depth: 3 }],
  ["Escape", { row: 1, depth: 2 }],
]) {
  test(`keyboardTarget handles ${key}`, () => assert.deepEqual(keyboardTarget({ row: 1, depth: 2 }, key), expected));
}

test("keyboardTarget clamps at all board edges", () => {
  assert.deepEqual(keyboardTarget({ row: 0, depth: 0 }, "ArrowUp"), { row: 0, depth: 0 });
  assert.deepEqual(keyboardTarget({ row: 2, depth: 3 }, "ArrowRight"), { row: 2, depth: 3 });
});

for (const [speed, expected] of [[1, 2], [2, 3], [3, 1], [99, 1]]) {
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
