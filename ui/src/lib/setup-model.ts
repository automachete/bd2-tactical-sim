import { cellKey } from "./battle-ui-model";
import type {
  BattleSetup,
  BuildSettings,
  Catalog,
  CharacterDefinition,
  CharacterProfile,
  CostumeLoadout,
  SetupSide,
  SetupUnit,
  Side,
} from "./types";

const clone = <T>(value: T): T => structuredClone(value);

export type PartyUnit = { unit: SetupUnit; index: number };

export const applyProfileToUnit = (
  unit: SetupUnit,
  character: CharacterDefinition,
  profile: CharacterProfile,
  buildSettingsDefault: BuildSettings,
): SetupUnit => {
  if (character.id !== unit.character_id || profile.character_id !== unit.character_id) {
    throw new Error(`profile/catalog mismatch for ${unit.character_id}`);
  }
  const existing = new Map(unit.costumes.map((item) => [item.costume_id, item] as const));
  const buildSettings = clone(unit.build_settings ?? buildSettingsDefault);
  buildSettings.awakening_enabled = profile.awakening_enabled;
  return {
    ...clone(unit),
    costumes: profile.costumes.map((fixed) => ({
      ...fixed,
      permanent_potential_enabled: true,
      enabled: existing.get(fixed.costume_id)?.enabled !== false && existing.has(fixed.costume_id),
    })),
    equipment: clone(profile.equipment),
    build_settings: buildSettings,
  };
};

export const normalizeSetupDraft = (
  preset: BattleSetup,
  catalog: Catalog,
  profileFor: (characterId: string) => CharacterProfile,
): BattleSetup => {
  const value = clone(preset);
  const playable = new Set(catalog.characters.map((character) => character.id));
  const characters = new Map(catalog.characters.map((character) => [character.id, character] as const));
  for (const side of ["player_units", "enemy_units"] as const) {
    value[side] = value[side]
      .filter((unit) => playable.has(unit.character_id))
      .map((unit) => {
        const normalized: SetupUnit = {
          ...unit,
          equipment: clone(unit.equipment ?? {}),
          build_settings: clone(unit.build_settings ?? catalog.build_settings_default),
          costumes: unit.costumes.map((costume) => ({ ...costume, enabled: costume.enabled !== false })),
        };
        if (side === "enemy_units") return normalized;
        const character = characters.get(unit.character_id);
        if (!character) throw new Error(`catalog character is missing for ${unit.character_id}`);
        return applyProfileToUnit(normalized, character, profileFor(unit.character_id), catalog.build_settings_default);
      });
  }
  return value;
};

export const partyUnits = (draft: BattleSetup | null, sideKey: SetupSide, editorParty: number): PartyUnit[] => {
  if (!draft) return [];
  return draft[sideKey]
    .map((unit, index) => ({ unit, index }))
    .filter(({ unit }) => sideKey === "enemy_units" || draft.mode !== "MONSTER_CHASER" || Number(unit.party_no) === editorParty);
};

export const moveSetupUnit = (
  draft: BattleSetup,
  sideKey: SetupSide,
  index: number,
  row: number,
  depth: number,
): { draft: BattleSetup; swapped: SetupUnit | null } => {
  const next = clone(draft);
  const focused = next[sideKey][index];
  if (!focused) return { draft: next, swapped: null };
  const source = { row: focused.row, depth: focused.depth };
  const occupiedIndex = next[sideKey].findIndex((unit, candidate) => candidate !== index
    && unit.party_no === focused.party_no && unit.row === row && unit.depth === depth);
  focused.row = row;
  focused.depth = depth;
  const occupied = occupiedIndex >= 0 ? next[sideKey][occupiedIndex] : undefined;
  if (occupied) {
    occupied.row = source.row;
    occupied.depth = source.depth;
  }
  return { draft: next, swapped: occupied ?? null };
};

export const usedCostumeIds = (draft: BattleSetup | null, sideKey: SetupSide, ignoredIndex = -1): Set<string> => (
  new Set((draft?.[sideKey] ?? [])
    .filter((_unit, index) => index !== ignoredIndex)
    .flatMap((unit) => unit.costumes.filter((item) => item.enabled !== false).map((item) => item.costume_id)))
);

export const defaultCostumes = (
  draft: BattleSetup,
  character: CharacterDefinition,
  single: boolean,
  excluded: ReadonlySet<string>,
  profile?: CharacterProfile,
): CostumeLoadout[] => {
  const unavailable = new Set([...excluded, ...(single ? draft.golden_colosseum?.banned_costume_ids ?? [] : [])]);
  const firstAvailable = character.costumes.findIndex((item) => !unavailable.has(item.id));
  const fixed = new Map((profile?.costumes ?? []).map((item) => [item.costume_id, item] as const));
  return character.costumes.map((costume, index) => ({
    costume_id: costume.id,
    enhancement: Number(fixed.get(costume.id)?.enhancement ?? costume.max_enhancement),
    burst_level: Number(fixed.get(costume.id)?.burst_level ?? costume.max_burst_level),
    potential_mask: Number(fixed.get(costume.id)?.potential_mask ?? costume.max_potential_mask),
    permanent_potential_enabled: true,
    enabled: single ? index === firstAvailable : true,
  }));
};

export type AddCharacterMessages = {
  partyLimit: string;
  noFormationCell: string;
  unknownCharacter: string;
  duplicateCharacter: string;
  duplicateCostume: string;
};

export const addSetupCharacter = (
  draft: BattleSetup,
  catalog: Catalog,
  side: Side,
  party: number,
  characterId: string,
  profile: CharacterProfile | undefined,
  messages: AddCharacterMessages,
): { draft: BattleSetup; index: number } => {
  const sideKey: SetupSide = side === "PLAYER" ? "player_units" : "enemy_units";
  const inParty = draft[sideKey].filter((unit) => unit.party_no === party);
  if (inParty.length >= draft.grid.deployment_limit) throw new Error(messages.partyLimit);
  const occupied = new Set(inParty.map((unit) => cellKey(unit.row, unit.depth)));
  const cell = Array.from({ length: draft.grid.rows * draft.grid.depths }, (_, index) => ({
    row: Math.floor(index / draft.grid.depths), depth: index % draft.grid.depths,
  })).find((candidate) => !draft.grid.blocked.some(([row, depth]) => row === candidate.row && depth === candidate.depth)
    && !occupied.has(cellKey(candidate.row, candidate.depth)));
  const character = catalog.characters.find((item) => item.id === characterId);
  if (!cell) throw new Error(messages.noFormationCell);
  if (!character) throw new Error(messages.unknownCharacter);
  if (draft.mode !== "GOLDEN_COLOSSEUM" && inParty.some((unit) => unit.character_id === character.id)) {
    throw new Error(messages.duplicateCharacter);
  }
  const excluded = usedCostumeIds(draft, sideKey);
  const banned = new Set(draft.golden_colosseum?.banned_costume_ids ?? []);
  if (draft.mode === "GOLDEN_COLOSSEUM"
    && character.costumes.every((item) => excluded.has(item.id) || banned.has(item.id))) {
    throw new Error(messages.duplicateCostume);
  }
  const next = clone(draft);
  next[sideKey].push({
    character_id: character.id,
    row: cell.row,
    depth: cell.depth,
    party_no: party,
    costumes: defaultCostumes(draft, character, draft.mode === "GOLDEN_COLOSSEUM", excluded, profile),
    costume_link_target: null,
    equipment: side === "PLAYER" ? clone(profile?.equipment ?? {}) : {},
    build_settings: {
      ...clone(catalog.build_settings_default),
      awakening_enabled: side === "PLAYER" ? Boolean(profile?.awakening_enabled) : catalog.build_settings_default.awakening_enabled,
    },
  });
  return { draft: next, index: next[sideKey].length - 1 };
};

export const cleanSetupUnit = (unit: SetupUnit, golden: boolean): SetupUnit => ({
  character_id: unit.character_id,
  row: Number(unit.row),
  depth: Number(unit.depth),
  party_no: Number(unit.party_no || 1),
  costumes: unit.costumes.filter((item) => item.enabled !== false).map((item) => ({
    costume_id: item.costume_id,
    enhancement: Number(item.enhancement),
    burst_level: Number(item.burst_level),
    potential_mask: Number(item.potential_mask),
    permanent_potential_enabled: true,
  })),
  costume_link_target: golden ? null : unit.costume_link_target,
  equipment: golden ? {} : clone(unit.equipment),
  build_settings: clone(unit.build_settings),
});

export const createStartRequest = (
  draft: BattleSetup,
  setupSeed: number,
  monsterLevel: number,
  mctsSimulations: number,
  invalidNumberMessage: string,
): BattleSetup => {
  if (!Number.isInteger(setupSeed)
    || !Number.isInteger(monsterLevel) || monsterLevel < 1 || monsterLevel > 25
    || !Number.isInteger(mctsSimulations) || mctsSimulations < 1 || mctsSimulations > 2048) {
    throw new Error(invalidNumberMessage);
  }
  const golden = draft.mode === "GOLDEN_COLOSSEUM";
  return {
    ...clone(draft),
    player_units: draft.player_units.map((unit) => cleanSetupUnit(unit, golden)),
    enemy_units: draft.enemy_units.map((unit) => cleanSetupUnit(unit, golden)),
    monster_level: monsterLevel,
    seed: setupSeed,
    mcts_simulations: mctsSimulations,
  };
};
