import { describe, expect, test } from "vitest";

import {
  addSetupCharacter,
  applyProfileToUnit,
  createStartRequest,
  moveSetupUnit,
  normalizeSetupDraft,
  usedCostumeIds,
} from "../src/lib/setup-model";
import type {
  BattleSetup,
  BuildSettings,
  Catalog,
  CharacterDefinition,
  CharacterProfile,
  SetupUnit,
} from "../src/lib/types";

const buildSettings: BuildSettings = {
  awakening_enabled: true,
  engraving_enabled: true,
  collection: { attack_bp: 0, magic_bp: 0, max_hp_bp: 0, crit_rate_bp: 0 },
  external_buffs: {
    attack_bonus_bp: 0,
    crit_rate_bp: 0,
    crit_damage_bp: 0,
    property_damage_bp: 0,
    shield_flat: 0,
    shield_percent_bp: 0,
  },
  calculator: {
    damage_type: "NORMAL",
    defense_type: "DEFENSE",
    elemental_advantage: false,
    world_buff_enabled: false,
    target_condition: { min_hp: 0, min_defense_bp: 0, min_magic_resist_bp: 0 },
    option_count: 0,
    gear_filters: {},
  },
};

const character: CharacterDefinition = {
  id: "hero",
  name: "Hero",
  rarity: 5,
  element: "FIRE",
  attack_type: "PHYSICAL",
  knockback_direction: "BACK",
  level_100: {
    max_hp: 100,
    attack: 10,
    magic: 0,
    defense_bp: 0,
    magic_resist_bp: 0,
    crit_rate_bp: 0,
    crit_damage_bp: 0,
    property_damage_bp: 0,
    amplification_bp: 0,
    incoming_damage_bp: 0,
    outgoing_damage_bp: 0,
  },
  costumes: [
    {
      id: "hero-a",
      character_id: "hero",
      name: "A",
      skill_name: "A",
      description_ja: "",
      operation_summary: "",
      sp_cost: 1,
      cooldown: 1,
      selector: "FRONT",
      target_all: false,
      range: [{ row: 0, depth: 0 }],
      max_enhancement: 5,
      max_burst_level: 2,
      max_potential_mask: 7,
      goddess_tear_nodes: [],
      bonding_modifiers: {},
      permanent_potential_modifiers: {},
    },
    {
      id: "hero-b",
      character_id: "hero",
      name: "B",
      skill_name: "B",
      description_ja: "",
      operation_summary: "",
      sp_cost: 2,
      cooldown: 2,
      selector: "FRONT",
      target_all: false,
      range: [{ row: 0, depth: 0 }],
      max_enhancement: 5,
      max_burst_level: 2,
      max_potential_mask: 7,
      goddess_tear_nodes: [],
      bonding_modifiers: {},
      permanent_potential_modifiers: {},
    },
  ],
  awakening_modifiers: {},
  engraving_modifiers: {},
};

const profile: CharacterProfile = {
  character_id: "hero",
  awakening_enabled: false,
  costumes: [
    { costume_id: "hero-a", enhancement: 1, burst_level: 0, potential_mask: 1 },
    { costume_id: "hero-b", enhancement: 2, burst_level: 1, potential_mask: 3 },
  ],
  equipment: {},
};

const unit = (characterId = "hero", row = 0, depth = 0): SetupUnit => ({
  character_id: characterId,
  row,
  depth,
  party_no: 1,
  costumes: [
    { costume_id: "hero-a", enhancement: 5, burst_level: 2, potential_mask: 7, permanent_potential_enabled: true, enabled: true },
    { costume_id: "hero-b", enhancement: 5, burst_level: 2, potential_mask: 7, permanent_potential_enabled: true, enabled: false },
  ],
  costume_link_target: "hero-a",
  equipment: {},
  build_settings: structuredClone(buildSettings),
});

const setup = (): BattleSetup => ({
  mode: "NORMAL",
  player_units: [unit()],
  enemy_units: [unit("hero", 1, 1)],
  grid: { rows: 3, depths: 4, deployment_limit: 5, blocked: [] },
});

const catalog: Catalog = {
  ruleset_id: "rules",
  characters: [character],
  entities: [],
  equipment: [],
  blessings: [],
  monster_skills: [],
  system_costumes: [],
  build_settings_default: buildSettings,
  presets: {
    NORMAL: setup(),
    MIRROR_WAR: { ...setup(), mode: "MIRROR_WAR" },
    MONSTER_CHASER: { ...setup(), mode: "MONSTER_CHASER" },
    GOLDEN_COLOSSEUM: { ...setup(), mode: "GOLDEN_COLOSSEUM" },
  },
};

describe("pure setup transformations", () => {
  test("applies durable profile values while preserving per-setup costume enablement", () => {
    const original = unit();
    const result = applyProfileToUnit(original, character, profile, buildSettings);
    expect(result.costumes.map((item) => [item.costume_id, item.enhancement, item.enabled])).toEqual([
      ["hero-a", 1, true],
      ["hero-b", 2, false],
    ]);
    expect(result.build_settings.awakening_enabled).toBe(false);
    expect(original.costumes[0]?.enhancement).toBe(5);
    expect(original.build_settings.awakening_enabled).toBe(true);
  });

  test("normalizes player profiles without applying them to enemies", () => {
    const result = normalizeSetupDraft(setup(), catalog, () => profile);
    expect(result.player_units[0]?.costumes[0]?.enhancement).toBe(1);
    expect(result.enemy_units[0]?.costumes[0]?.enhancement).toBe(5);
  });

  test("moves and swaps draft units without mutating the source setup", () => {
    const source = setup();
    source.player_units.push(unit("hero", 2, 2));
    const result = moveSetupUnit(source, "player_units", 0, 2, 2);
    expect(result.draft.player_units.map((item) => [item.row, item.depth])).toEqual([[2, 2], [0, 0]]);
    expect(result.swapped).not.toBeNull();
    expect(source.player_units.map((item) => [item.row, item.depth])).toEqual([[0, 0], [2, 2]]);
  });

  test("collects only enabled costumes outside the ignored unit", () => {
    const source = setup();
    source.player_units.push(unit("hero", 2, 2));
    expect([...usedCostumeIds(source, "player_units", 0)].sort()).toEqual(["hero-a"]);
  });

  test("adds a profiled character through validated immutable setup editing", () => {
    const source = setup();
    source.player_units = [];
    const result = addSetupCharacter(source, catalog, "PLAYER", 1, "hero", profile, {
      partyLimit: "limit",
      noFormationCell: "no cell",
      unknownCharacter: "unknown",
      duplicateCharacter: "duplicate character",
      duplicateCostume: "duplicate costume",
    });
    expect(result.index).toBe(0);
    expect(result.draft.player_units[0]).toMatchObject({ character_id: "hero", row: 0, depth: 0 });
    expect(result.draft.player_units[0]?.costumes[0]?.enhancement).toBe(1);
    expect(source.player_units).toEqual([]);
    expect(() => addSetupCharacter(result.draft, catalog, "PLAYER", 1, "hero", profile, {
      partyLimit: "limit",
      noFormationCell: "no cell",
      unknownCharacter: "unknown",
      duplicateCharacter: "duplicate character",
      duplicateCostume: "duplicate costume",
    })).toThrow("duplicate character");
  });

  test("serializes a clean request and rejects invalid numeric controls", () => {
    const source = setup();
    const result = createStartRequest(source, 42, 6, 48, "invalid");
    expect(result.player_units[0]?.costumes.map((item) => item.costume_id)).toEqual(["hero-a"]);
    expect(result.seed).toBe(42);
    expect(result.monster_level).toBe(6);
    expect(result.mcts_simulations).toBe(48);
    expect(() => createStartRequest(source, 1.5, 6, 48, "invalid")).toThrow("invalid");
  });
});
