import { describe, expect, test } from "vitest";

import { eventCell, eventNumber, eventString, eventUnitIds } from "../src/lib/playback-model";
import type { BattleEvent } from "../src/lib/types";

const event = (kind: BattleEvent["kind"]): BattleEvent => ({ sequence: 1, kind });

describe("playback event decoding", () => {
  test("normalizes numeric engine payload fields", () => {
    expect(eventNumber(event({ type: "DAMAGE_APPLIED", amount: "42" }), "amount")).toBe(42);
    expect(eventNumber(event({ type: "DAMAGE_APPLIED" }), "amount", 7)).toBe(7);
  });

  test("accepts displayable strings and numbers only", () => {
    expect(eventString(event({ type: "ACTION_DECLARED", skill_name: "Strike" }), "skill_name")).toBe("Strike");
    expect(eventString(event({ type: "ACTION_DECLARED", skill_name: 12 }), "skill_name")).toBe("12");
    expect(eventString(event({ type: "ACTION_DECLARED", skill_name: { nested: true } }), "skill_name")).toBe("");
  });

  test("decodes complete numeric cells and rejects malformed cells", () => {
    expect(eventCell(event({ type: "UNIT_MOVED", to: { row: 1, depth: 2 } }), "to")).toEqual({ row: 1, depth: 2 });
    expect(eventCell(event({ type: "UNIT_MOVED", to: { row: "1", depth: 2 } }), "to")).toBeNull();
    expect(eventCell(event({ type: "UNIT_MOVED", to: null }), "to")).toBeNull();
  });

  test("keeps only numeric ids in engine arrays", () => {
    expect(eventUnitIds(event({ type: "MONSTER_PARTY_ACTIVATED", unit_ids: [1, "2", null, 3] }), "unit_ids")).toEqual([1, 3]);
    expect(eventUnitIds(event({ type: "MONSTER_PARTY_ACTIVATED", unit_ids: "1" }), "unit_ids")).toEqual([]);
  });
});
