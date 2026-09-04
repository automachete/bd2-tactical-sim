/**
 * Exhaustive, independent audit of the equipment catalog generated from the
 * current BD2DB payload. This intentionally reimplements the calculator math
 * instead of importing sync-bd2db.mjs, so a shared transform bug cannot make
 * both the output and its test pass.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(repositoryRoot, "data/generated/catalog.json");
const oraclePath = process.argv[3]
  ? resolve(process.argv[3])
  : resolve(repositoryRoot, "docs/validation/bd2db-current-equipment-oracle.json");
const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
const oracle = JSON.parse(await readFile(oraclePath, "utf8"));

const statNames = {
  HP: "MAX_HP_FLAT",
  "HP%": "MAX_HP_PERCENT",
  ATK: "ATTACK_FLAT",
  "ATK%": "ATTACK_PERCENT",
  MATK: "MAGIC_FLAT",
  "MATK%": "MAGIC_PERCENT",
  DEF: "DEFENSE",
  MDEF: "MAGIC_RESIST",
  CR: "CRIT_RATE",
  CDMG: "CRIT_DAMAGE",
};
const slots = { Weapon: "WEAPON", Armor: "ARMOR", Helmet: "HELMET", Jewelry: "JEWELRY", Gloves: "GLOVES" };
const substatProfiles = {
  atk: ["CDMG", "ATK%", "ATK", "HP%", "HP", "DEF", "MDEF", "CR"],
  matk: ["CDMG", "MATK%", "MATK", "HP%", "HP", "DEF", "MDEF", "CR"],
  jewelry: ["CDMG", "ATK%", "ATK", "MATK%", "MATK", "HP%", "HP", "DEF", "MDEF", "CR"],
};
const scores = [18, 19, 20, 21, 22, 23, 24];

function numberFromTable(value) {
  const parsed = Number(String(value).replace("%", ""));
  assert.ok(Number.isFinite(parsed), `non-numeric BD2DB table value: ${value}`);
  return parsed;
}

function rounded(value) {
  return Math.round(Number((Math.abs(value) * 100).toPrecision(15))) / 100 * Math.sign(value);
}

function modifier(stat, value) {
  const flat = Math.round(value);
  const bp = Math.round(rounded(value) * 100);
  return ({
    HP: { max_hp_flat: flat },
    "HP%": { max_hp_bp: bp },
    ATK: { attack_flat: flat },
    "ATK%": { attack_bp: bp },
    MATK: { magic_flat: flat },
    "MATK%": { magic_bp: bp },
    DEF: { defense_bp: bp },
    MDEF: { magic_resist_bp: bp },
    CR: { crit_rate_bp: bp },
    CDMG: { crit_damage_bp: bp },
  })[stat];
}

function abilityStats(text) {
  const result = [...String(text).matchAll(/\{([A-Z%]+)\}/g)].map((match) => match[1]);
  assert.ok(result.length > 0, `no stat placeholder in ability: ${text}`);
  assert.ok(result.every((key) => statNames[key]), `unknown stat placeholder in ability: ${text}`);
  return [...new Set(result)];
}

function add(target, source) {
  for (const [key, value] of Object.entries(source)) target[key] = (target[key] || 0) + value;
  return target;
}

function withoutFetchMetadata(equipment) {
  return Object.fromEntries(Object.entries(equipment).map(([id, definition]) => {
    const clone = structuredClone(definition);
    delete clone.source?.observed_at;
    delete clone.source?.source_digest;
    return [id, clone];
  }));
}

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
  }
  return value;
}

function equal(actual, expected, message) {
  assert.deepEqual(sorted(actual), sorted(expected), message);
}

const expectedDefaults = {
  refinement_score: 18,
  refinement_grades: ["B", "B", "S"],
  collection: { max_hp_bp: 8000, attack_bp: 8000, magic_bp: 8000, crit_rate_bp: 5000 },
  external_buffs: {
    attack_bonus_bp: 0,
    crit_rate_bp: 0,
    crit_damage_bp: 0,
    property_damage_bp: 0,
    shield_percent_bp: 0,
    shield_flat: 0,
  },
  calculator: {
    damage_type: "NORMAL",
    elemental_advantage: true,
    defense_type: "NONE",
    target_condition: { min_hp: 0, min_defense_bp: 0, min_magic_resist_bp: 0 },
    option_count: 15,
    gear_filters: { exclusive: true, ur4: true, ur3: true, monster: true },
    world_buff_enabled: false,
  },
};
equal(oracle.calculator_defaults, expectedDefaults, "BD2DB calculator defaults drifted");

const definitions = Object.values(catalog.equipment);
assert.equal(definitions.length, 91, "supported equipment count");
assert.equal(definitions.filter((item) => item.kind === "CRAFTED_LEGENDARY").length, 30, "UR IV count");
assert.equal(definitions.filter((item) => item.kind === "EXCLUSIVE").length, 61, "five-star exclusive count");
assert.equal(new Set(definitions.map((item) => item.id)).size, definitions.length, "equipment IDs must be unique");

const fiveStarCharacters = new Set(Object.values(catalog.characters)
  .filter((character) => character.rarity === 5 && !character.id.includes(":"))
  .map((character) => character.id));
const exclusiveOwners = new Set(definitions.filter((item) => item.kind === "EXCLUSIVE").map((item) => item.owner_character_id));
equal([...exclusiveOwners].sort(), [...fiveStarCharacters].sort(), "every current five-star character must have exactly one exclusive item");

const computedCases = [];
for (const definition of definitions) {
  const payload = definition.source?.raw_payload;
  assert.ok(payload, `${definition.id}: missing original BD2DB payload`);
  const raw = payload.equipment;
  const localized = payload.localization;
  const tables = payload.ur4_tables;
  const exclusive = raw.category === "Exclusive";
  assert.equal(definition.kind, exclusive ? "EXCLUSIVE" : "CRAFTED_LEGENDARY", `${definition.id}: kind`);
  assert.equal(definition.tier, exclusive ? "EX UR" : "UR4", `${definition.id}: tier`);
  assert.equal(definition.slot, slots[raw.part], `${definition.id}: slot`);
  assert.equal(definition.owner_character_id, exclusive ? raw.characterId : null, `${definition.id}: owner`);
  assert.equal(definition.names.ja, localized.name_ja, `${definition.id}: official Japanese name`);
  assert.ok(definition.names.ja, `${definition.id}: official Japanese name is empty`);
  assert.equal(definition.source.source_url, "https://browndust2-db.souseha.com/ja/option-calculator");

  const first = abilityStats(raw.firstAbility);
  const second = abilityStats(raw.secondAbility);
  const expectedPrimary = exclusive ? first.map((key) => statNames[key]) : [];
  const expectedSecondary = exclusive ? second.map((key) => statNames[key]) : [];
  equal(definition.primary_stat_options, expectedPrimary, `${definition.id}: primary options`);
  equal(definition.secondary_stat_options, expectedSecondary, `${definition.id}: secondary options`);

  const expectedSubstats = substatProfiles[raw.substatType];
  assert.ok(expectedSubstats, `${definition.id}: unsupported substat profile`);
  equal(definition.allowed_substats, expectedSubstats.map((key) => statNames[key]), `${definition.id}: legal substats`);
  const expectedSubstatModifiers = Object.fromEntries(expectedSubstats.map((key) => [
    statNames[key], modifier(key, numberFromTable(tables.sub[key])),
  ]));
  equal(definition.substat_modifiers, expectedSubstatModifiers, `${definition.id}: substat values`);

  let fixed = {};
  if (exclusive) {
    assert.ok(tables.extra, `${definition.id}: missing 5UR extra-ability source table`);
    const key = abilityStats(raw.extraAbility)[0];
    fixed = modifier(key, numberFromTable(tables.extra[key]));
  }
  for (const score of scores) {
    const refined = (key) => {
      const base = numberFromTable(tables.main[key]);
      let refinement = numberFromTable(tables.refinement[key]) * (score + 6);
      if (key === "ATK" || key === "MATK") refinement = Math.floor(refinement);
      return modifier(key, rounded(base + refinement));
    };
    if (exclusive) {
      equal(definition.modifiers_by_refinement_score[score], fixed, `${definition.id}/${score}: fixed exclusive stat`);
      const primary = Object.fromEntries(first.map((key) => [statNames[key], refined(key)]));
      const secondary = Object.fromEntries(second.map((key) => [statNames[key], refined(key)]));
      equal(definition.primary_modifiers_by_refinement_score[score], primary, `${definition.id}/${score}: primary table`);
      equal(definition.secondary_modifiers_by_refinement_score[score], secondary, `${definition.id}/${score}: secondary table`);
      for (const firstKey of first) {
        for (const secondKey of second) {
          computedCases.push({
            equipment_id: definition.id,
            kind: definition.kind,
            owner_character_id: definition.owner_character_id,
            slot: definition.slot,
            refinement_score: score,
            primary_stat: statNames[firstKey],
            secondary_stat: statNames[secondKey],
            modifiers: add(add({ ...fixed }, refined(firstKey)), refined(secondKey)),
          });
        }
      }
    } else {
      const expected = add(refined(first[0]), modifier(second[0], numberFromTable(tables.main[second[0]])));
      equal(definition.modifiers_by_refinement_score[score], expected, `${definition.id}/${score}: crafted main abilities`);
      computedCases.push({
        equipment_id: definition.id,
        kind: definition.kind,
        owner_character_id: null,
        slot: definition.slot,
        refinement_score: score,
        primary_stat: null,
        secondary_stat: null,
        modifiers: expected,
      });
    }
  }
}

assert.equal(computedCases.length, 3626, "equipment/refinement/main-ability case count");
equal(
  withoutFetchMetadata(oracle.equipment),
  withoutFetchMetadata(catalog.equipment),
  "oracle and imported catalog definitions differ",
);
equal(oracle.cases, computedCases, "exhaustive BD2DB equipment cases differ");
assert.equal(oracle.scope.equipment_count, definitions.length);
assert.equal(oracle.scope.case_count, computedCases.length);

console.log(JSON.stringify({
  equipment: definitions.length,
  craftedLegendary: 30,
  exclusive: 61,
  exhaustiveCases: computedCases.length,
  result: "PASS",
}, null, 2));
