/**
 * Synchronize factual BrownDust2 catalog records from the continuously updated
 * BD2DB static data bundle without executing third-party JavaScript.
 *
 * The Acorn AST is interpreted by a strict literal-only evaluator. Unknown AST
 * nodes fail closed. Original records and SHA-256 provenance are retained.
 */
import { parse } from "acorn";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ORIGIN = "https://browndust2-db.souseha.com";
const tokyoDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());
const RULESET = process.env.BD2_RULESET_ID ?? `bd2-current-${tokyoDate}`;
const outputIndex = process.argv.indexOf("--out");
const outputPath = resolve(outputIndex >= 0 ? process.argv[outputIndex + 1] : "data/generated/catalog.json");
const equipmentOracleIndex = process.argv.indexOf("--equipment-oracle");
const equipmentOraclePath = equipmentOracleIndex >= 0
  ? resolve(process.argv[equipmentOracleIndex + 1])
  : null;
const toolDirectory = dirname(fileURLToPath(import.meta.url));
const localizationPath = resolve(toolDirectory, "../data/localization/ja-JP.json");

async function getText(url) {
  const response = await fetch(url, { headers: { "user-agent": "pcg-rpg-research-sync/0.1" } });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.text();
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function moduleAst(text) {
  return parse(text, { ecmaVersion: "latest", sourceType: "module" });
}

function propertyName(property) {
  if (!property.computed && property.key.type === "Identifier") return property.key.name;
  if (property.key.type === "Literal") return String(property.key.value);
  throw new Error(`unsupported property key: ${property.key.type}`);
}

function literal(node) {
  switch (node.type) {
    case "Literal": return node.value;
    case "ArrayExpression": return node.elements.map((item) => item === null ? null : literal(item));
    case "ObjectExpression": {
      const value = {};
      for (const property of node.properties) {
        if (property.type !== "Property" || property.kind !== "init" || property.method || property.computed) {
          throw new Error(`unsupported object member: ${property.type}`);
        }
        value[propertyName(property)] = literal(property.value);
      }
      return value;
    }
    case "UnaryExpression": {
      const value = literal(node.argument);
      if (node.operator === "!") return !value;
      if (node.operator === "-") return -value;
      if (node.operator === "+") return +value;
      throw new Error(`unsupported unary operator: ${node.operator}`);
    }
    case "TemplateLiteral":
      if (node.expressions.length === 0) return node.quasis[0].value.cooked;
      throw new Error("template expressions are not data literals");
    default:
      throw new Error(`non-literal AST node rejected: ${node.type}`);
  }
}

function staticCandidates(text) {
  const candidates = [];
  for (const statement of moduleAst(text).body) {
    if (statement.type !== "VariableDeclaration") continue;
    for (const declaration of statement.declarations) {
      if (declaration.id.type !== "Identifier" || !declaration.init) continue;
      try {
        candidates.push({ name: declaration.id.name, value: literal(declaration.init) });
      } catch {
        // Executable declarations are deliberately ignored.
      }
    }
  }
  return candidates;
}

function resolvedStaticCandidates(text) {
  const candidates = [];
  const environment = new Map();
  const resolveLiteral = (node) => {
    if (node.type === "Identifier") {
      if (!environment.has(node.name)) throw new Error(`unknown literal identifier: ${node.name}`);
      return environment.get(node.name);
    }
    if (node.type === "ObjectExpression") {
      const value = {};
      for (const property of node.properties) {
        if (property.type === "SpreadElement") {
          Object.assign(value, resolveLiteral(property.argument));
          continue;
        }
        if (property.type !== "Property" || property.kind !== "init" || property.method || property.computed) {
          throw new Error(`unsupported resolved object member: ${property.type}`);
        }
        value[propertyName(property)] = resolveLiteral(property.value);
      }
      return value;
    }
    if (node.type === "ArrayExpression") {
      return node.elements.map((item) => item === null ? null : resolveLiteral(item));
    }
    return literal(node);
  };
  for (const statement of moduleAst(text).body) {
    if (statement.type !== "VariableDeclaration") continue;
    for (const declaration of statement.declarations) {
      if (declaration.id.type !== "Identifier" || !declaration.init) continue;
      try {
        const value = resolveLiteral(declaration.init);
        environment.set(declaration.id.name, value);
        candidates.push({ name: declaration.id.name, value });
      } catch {
        // Only already-resolved literal references are accepted.
      }
    }
  }
  return candidates;
}

function findCharacterData(text) {
  const result = staticCandidates(text).find(({ value }) =>
    Array.isArray(value)
    && value.length > 20
    && value[0]?.characterId
    && Array.isArray(value[0]?.costumes),
  );
  if (!result) throw new Error("character data array was not found");
  return result.value;
}

function findCostumeI18n(text) {
  const result = resolvedStaticCandidates(text).find(({ value }) => {
    if (!value || Array.isArray(value) || typeof value !== "object") return false;
    const entries = Object.values(value);
    return entries.length >= 100
      && entries.every((entry) => entry?.costumeId && Array.isArray(entry?.skill_ja));
  });
  if (!result) throw new Error("costume localization map was not found");
  return result.value;
}

function findRangeData(text) {
  const result = staticCandidates(text).find(({ value }) =>
    value && !Array.isArray(value) && Array.isArray(value.all) && Array.isArray(value["001"]),
  );
  if (!result) throw new Error("range offset map was not found");
  return result.value;
}

function findFiendData(text) {
  const result = staticCandidates(text).find(({ value }) =>
    value?.schemaVersion && value?.source?.kind === "monster-hunt" && value?.environment?.fiend,
  );
  return result?.value ?? null;
}

function findSummonData(text) {
  const result = staticCandidates(text).find(({ value }) => Array.isArray(value) && value.length >= 4 && value.every((entry) => entry?.summonId && Array.isArray(entry?.level)));
  if (!result) throw new Error("summon data array was not found");
  return result.value;
}

function findEquipmentData(text) {
  const result = staticCandidates(text).find(({ value }) =>
    Array.isArray(value)
    && value.length >= 30
    && value.every((entry) => entry?.weaponId && entry?.part && entry?.tier),
  );
  if (!result) throw new Error("equipment data array was not found");
  return result.value;
}

function findEquipmentI18n(text) {
  const result = resolvedStaticCandidates(text).find(({ value }) => {
    if (!value || Array.isArray(value) || typeof value !== "object") return false;
    const entries = Object.values(value);
    return entries.length >= 30
      && entries.every((entry) => entry?.weaponId && entry?.name_ja && entry?.name_ko);
  });
  if (!result) throw new Error("equipment localization map was not found");
  return result.value;
}

function findEquipmentStatTables(text) {
  const result = staticCandidates(text).find(({ value }) => {
    if (!Array.isArray(value)) return false;
    const types = new Set(value.map((entry) => entry?.type));
    return types.has("Main") && types.has("Sub") && types.has("Refinements");
  });
  if (!result) throw new Error("equipment calculator stat tables were not found");
  return Object.fromEntries(result.value.map((entry) => [entry.type, entry.list]));
}

function findBlessingI18n(text) {
  const result = resolvedStaticCandidates(text).find(({ value }) => {
    if (!value || Array.isArray(value) || typeof value !== "object") return false;
    const entries = Object.values(value);
    return entries.length === 47
      && entries.every((entry) => entry?.blessingId && entry?.name_ja && entry?.name_ko && Array.isArray(entry?.level));
  });
  if (!result) throw new Error("Gladiator's Blessing localization map was not found");
  return result.value;
}

const emptyEffectSpec = (effectId, { polarity = "BENEFICIAL", duration = 1, durationClock = "ALL_TURN", modifiers = {}, tags = [], barrier = null, charges = null, operations = [] } = {}) => ({
  effect_id: effectId,
  polarity,
  recipient: "ACTOR_SIDE",
  duration,
  duration_clock: durationClock,
  modifiers,
  tags,
  stack_rule: "INDEPENDENT",
  barrier,
  periodic: null,
  charges,
  evasion_decay_bp: 0,
  counter: null,
  revive_hp_bp: null,
  max_stacks: null,
  conditional_outgoing: [],
  on_hit_received_allies: null,
  on_hit_received_operations: [],
  on_turn_end_operations: operations,
  aura_allies: null,
  aura_opponents: null,
  on_chain_dealt: null,
});

const teamStats = (modifiers, element = null, attackType = null) => ({
  type: "TEAM_STATS", modifiers, element, attack_type: attackType,
});

function blessingEffect(id, level, values) {
  const bp = key => Number(values[key]) * 100;
  const timed = (start, target, effect, every = false) => ({
    type: "TIMED_EFFECT", start_all_turn: start, every_all_turn: every, target, effect,
  });
  const elements = ["FIRE", "WATER", "WIND", "LIGHT", "DARK"];
  if (id === "blessing_001") return teamStats({ attack_bp: bp("VALUE1") });
  if (id === "blessing_002") return teamStats({ magic_bp: bp("VALUE1") });
  if (/^blessing_00[3-7]$/.test(id)) return teamStats({ attack_bp: bp("VALUE1"), magic_bp: bp("VALUE1") }, elements[Number(id.slice(-1)) - 3]);
  if (id === "blessing_008") return teamStats({ crit_rate_bp: bp("VALUE1") });
  if (id === "blessing_009") return teamStats({ crit_damage_bp: bp("VALUE1") });
  if (id === "blessing_010") return { type: "COUNTER_DAMAGE", amount_bp: bp("VALUE1") };
  if (id === "blessing_011") return { type: "EXTRA_CHAIN", stacks: Number(values.VALUE1) };
  if (id === "blessing_012") return { type: "CHAIN_DAMAGE", amount_bp_per_stack: bp("VALUE1") };
  if (/^blessing_01[3-7]$/.test(id)) return teamStats({ max_hp_bp: bp("VALUE1") }, elements[Number(id.slice(-2)) - 13]);
  if (id === "blessing_018") return teamStats({ max_hp_bp: bp("VALUE1") }, null, "PHYSICAL");
  if (id === "blessing_019") return teamStats({ max_hp_bp: bp("VALUE1") }, null, "MAGICAL");
  if (id === "blessing_020") return teamStats({ defense_bp: bp("VALUE1") });
  if (id === "blessing_021") return teamStats({ magic_resist_bp: bp("VALUE1") });
  if (id === "blessing_022") return { type: "PROPERTY_BALANCE", property_damage_bp: bp("VALUE1"), property_resistance_bp: bp("VALUE2") };
  if (id === "blessing_023") return timed(1, "ALL_ALLIES", emptyEffectSpec(`${id}[${level}]`, { durationClock: "PERMANENT", modifiers: { damage_reduction_bp: bp("VALUE1") } }));
  if (id === "blessing_024") return timed(1, "ALL_ALLIES", emptyEffectSpec(`${id}[${level}]`, { modifiers: { evasion_bp: 10000 }, tags: ["EVASION"], charges: Number(values.VALUE1) }));
  if (id === "blessing_025") return timed(1, "ALL_ALLIES", emptyEffectSpec(`${id}[${level}]`, { barrier: { coefficient_bp: bp("VALUE1"), reference: "MAX_HP" } }));
  if (id === "blessing_026") return timed(1, "ALL_ALLIES", emptyEffectSpec(`${id}[${level}]`, {
    duration: Number(values.VALUE2),
    operations: [{ op: "HEAL", coefficient_bp: bp("VALUE1"), reference: "MAX_HP", can_crit: false, recipient: "ACTOR_SIDE" }],
  }));
  if (id === "blessing_027") return { type: "IMMUNITY", tags: ["SILENCE", "KNOCKBACK", "WEAKENING"] };
  if (id === "blessing_028") return { type: "BUFF_REMOVAL_IMMUNITY" };
  if (id === "blessing_029") return { type: "FORCE_FIXED_DAMAGE" };
  if (id === "blessing_030") return timed(1, "FIRST_ALLY", emptyEffectSpec(`${id}[${level}]`, { tags: ["TAUNT"] }));
  if (id === "blessing_031") return timed(1, "ALL_ALLIES", emptyEffectSpec(`${id}[${level}]`, { modifiers: { damage_reduction_bp: bp("VALUE1") } }));
  if (id === "blessing_032") return timed(2, "ALL_ENEMIES", emptyEffectSpec(`${id}[${level}]`, { polarity: "HARMFUL", duration: Number(values.VALUE2), modifiers: { incoming_damage_bp: bp("VALUE1") }, tags: ["WEAKENING"] }));
  if (id === "blessing_033") return { type: "CONDITIONAL_DAMAGE", condition: "TARGET_HP_AT_LEAST90", amount_bp: bp("VALUE2") };
  if (id === "blessing_034") return { type: "CONDITIONAL_DAMAGE", condition: "TARGET_HP_AT_MOST90", amount_bp: bp("VALUE2") };
  if (id === "blessing_035") return { type: "STAT_BOOST_PRESSURE", amount_bp: bp("VALUE1") };
  if (id === "blessing_036") return timed(1, "ALL_ENEMIES", emptyEffectSpec(`${id}[${level}]`, { polarity: "HARMFUL", duration: Number(values.VALUE2), modifiers: { physical_incoming_damage_bp: bp("VALUE1") }, tags: ["WEAKENING"] }));
  if (id === "blessing_037") return timed(1, "ALL_ENEMIES", emptyEffectSpec(`${id}[${level}]`, { polarity: "HARMFUL", duration: Number(values.VALUE2), modifiers: { magical_incoming_damage_bp: bp("VALUE1") }, tags: ["WEAKENING"] }));
  if (id === "blessing_038" || id === "blessing_039") return timed(2, "ALL_ALLIES", emptyEffectSpec(`${id}[${level}]`, { durationClock: "PERMANENT", modifiers: { attack_bp: bp("VALUE1"), magic_bp: bp("VALUE1") } }));
  if (id === "blessing_040") return timed(1, "FIRST_ENEMY", emptyEffectSpec(`${id}[${level}]`, { polarity: "HARMFUL", duration: Number(values.VALUE1), tags: ["SILENCE"] }));
  if (id === "blessing_041") return timed(1, "ALL_ALLIES", emptyEffectSpec(`${id}[${level}]`, { modifiers: { attack_bp: bp("VALUE1") } }));
  if (id === "blessing_042") return timed(1, "ALL_ALLIES", emptyEffectSpec(`${id}[${level}]`, { modifiers: { magic_bp: bp("VALUE1") } }));
  if (id === "blessing_043") return { type: "CONDITIONAL_DAMAGE", condition: "TARGET_TAUNTED", amount_bp: bp("VALUE1") };
  if (id === "blessing_044") return timed(1, "FIRST_ENEMY", emptyEffectSpec(`${id}[${level}]`, { polarity: "HARMFUL", modifiers: { incoming_damage_bp: bp("VALUE1") }, tags: ["FOCUS", "WEAKENING"] }), true);
  // The official August 27, 2026 balance notice supersedes the still-stale
  // percentages in BD2DB's blessing bundle. Keep the upstream raw payload in
  // SourceRecord and fail a regression test if these overrides disappear.
  if (id === "blessing_045") return timed(1, "THIRD_ALLY", emptyEffectSpec(`${id}[${level}]`, { duration: 4, modifiers: { attack_bp: 30000, magic_bp: 30000 }, tags: ["EVADE_TARGET"] }));
  if (id === "blessing_046") return { type: "CONDITIONAL_DAMAGE", condition: "TARGET_CHAIN_AT_MOST5", amount_bp: 15000 };
  if (id === "blessing_047") return { type: "CHAIN_CAP", maximum: 2 };
  throw new Error(`unmapped Gladiator's Blessing: ${id}`);
}

function transformBlessings(rawBlessings, source) {
  return Object.fromEntries(Object.values(rawBlessings).map((raw) => {
    const id = raw.blessingId;
    const levels = raw.level.slice(0, Number(raw.levelLength)).map((values, index) => ({
      level: index + 1,
      point_cost: Number(values.cost),
      effect: blessingEffect(id, index + 1, values),
    }));
    if (levels.some((entry) => !Number.isInteger(entry.point_cost) || entry.point_cost <= 0)) throw new Error(`${id} has invalid point cost`);
    const officialOverride = id === "blessing_045" || id === "blessing_046" ? {
      announced_at: "2026-08-25T08:00:15Z",
      effective_at: "2026-08-27T00:00:00Z",
      source_url: "https://www.browndust2.com/ko-kr/news/view?id=01M0VS18PHZJ35515STZGQ56YJ",
      rule_image_url: "https://www.browndust2.com/web-assets/2026-08/01M0VS10706JR29DNZ7M304GBW/%ED%99%A9%EA%B8%88%20%ED%88%AC%EA%B8%B0%EC%9E%A5%20%EA%B7%9C%EC%B9%99.png",
    } : null;
    const currentDescriptions = {
      "zh-TW": raw.desc,
      "zh-CN": raw.desc_CN,
      en: raw.desc_en,
      ja: raw.desc_ja,
      ko: raw.desc_ko,
    };
    if (officialOverride) {
      const replacement = id === "blessing_045" ? "300%" : "150%";
      for (const [locale, lines] of Object.entries(currentDescriptions)) {
        currentDescriptions[locale] = lines.map(line => String(line).replace(/100[%％]/g, replacement));
      }
    }
    const record = {
      id,
      names: { "zh-TW": raw.name, "zh-CN": raw.name_CN, en: raw.name_en, ja: raw.name_ja, ko: raw.name_ko },
      descriptions: currentDescriptions,
      category: raw.category,
      levels,
      source: { ...source, raw_payload: officialOverride ? { ...raw, official_override: officialOverride } : raw },
    };
    return [id, record];
  }));
}

const EQUIPMENT_STAT_KEYS = {
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

const SUBSTATS_BY_PROFILE = {
  atk: ["CDMG", "ATK%", "ATK", "HP%", "HP", "DEF", "MDEF", "CR"],
  matk: ["CDMG", "MATK%", "MATK", "HP%", "HP", "DEF", "MDEF", "CR"],
  jewelry: ["CDMG", "ATK%", "ATK", "MATK%", "MATK", "HP%", "HP", "DEF", "MDEF", "CR"],
};

const EQUIPMENT_SLOTS = {
  Weapon: "WEAPON",
  Armor: "ARMOR",
  Helmet: "HELMET",
  Jewelry: "JEWELRY",
  Gloves: "GLOVES",
};

function numberFromGearTable(value) {
  const parsed = Number(String(value ?? "").replace("%", ""));
  if (!Number.isFinite(parsed)) throw new Error(`invalid equipment calculator value: ${value}`);
  return parsed;
}

function roundGearValue(value) {
  return Math.round(Number((Math.abs(value) * 100).toPrecision(15))) / 100 * Math.sign(value);
}

function modifierForEquipmentStat(key, value) {
  const modifier = {};
  const integerValue = Math.round(value);
  const basisPoints = Math.round(roundGearValue(value) * 100);
  switch (key) {
    case "HP": modifier.max_hp_flat = integerValue; break;
    case "HP%": modifier.max_hp_bp = basisPoints; break;
    case "ATK": modifier.attack_flat = integerValue; break;
    case "ATK%": modifier.attack_bp = basisPoints; break;
    case "MATK": modifier.magic_flat = integerValue; break;
    case "MATK%": modifier.magic_bp = basisPoints; break;
    case "DEF": modifier.defense_bp = basisPoints; break;
    case "MDEF": modifier.magic_resist_bp = basisPoints; break;
    case "CR": modifier.crit_rate_bp = basisPoints; break;
    case "CDMG": modifier.crit_damage_bp = basisPoints; break;
    default: throw new Error(`unsupported equipment stat key: ${key}`);
  }
  return modifier;
}

function mergeModifier(target, value) {
  for (const [key, amount] of Object.entries(value)) target[key] = (target[key] ?? 0) + amount;
  return target;
}

function abilityKeys(value) {
  const keys = [...String(value).matchAll(/\{([A-Z%]+)\}/g)].map((match) => match[1]);
  if (keys.length === 0 || keys.some((key) => !EQUIPMENT_STAT_KEYS[key])) {
    throw new Error(`equipment ability key was not found: ${value}`);
  }
  return [...new Set(keys)];
}

function transformEquipment(rawEquipment, equipmentI18n, tables, source, fiveStarCharacterIds) {
  const namesById = new Map(Object.values(equipmentI18n).map((entry) => [entry.weaponId, entry]));
  const definitions = {};
  const oracleCases = [];
  const selected = rawEquipment.filter((entry) =>
    (entry.category === "UR" && entry.tier === "UR4")
    || (entry.category === "Exclusive"
      && entry.tier === "EX UR"
      && fiveStarCharacterIds.has(entry.characterId)));
  for (const raw of selected) {
    const exclusive = raw.category === "Exclusive";
    const tableTier = exclusive ? "EX UR" : "UR4";
    const main = tables.Main.find((entry) => entry.tier === tableTier);
    const sub = tables.Sub.find((entry) => entry.tier === tableTier);
    const refinement = tables.Refinements.find((entry) => entry.tier === tableTier);
    if (!main || !sub || !refinement) throw new Error(`${tableTier} calculator tables are incomplete`);
    const firstKeys = abilityKeys(raw.firstAbility);
    const secondKeys = abilityKeys(raw.secondAbility);
    const i18n = namesById.get(raw.weaponId) ?? {};
    const modifiersByScore = {};
    const primaryModifiersByScore = {};
    const secondaryModifiersByScore = {};
    const exclusiveFixed = {};
    let exclusiveExtra = null;
    if (exclusive) {
      const extra = tables.Extra.find((entry) => entry.tier === "5UR");
      if (!extra) throw new Error("5-star EX UR extra-ability table is incomplete");
      exclusiveExtra = extra;
      const extraKey = abilityKeys(raw.extraAbility)[0];
      mergeModifier(exclusiveFixed, modifierForEquipmentStat(extraKey, numberFromGearTable(extra[extraKey])));
    }
    for (let score = 18; score <= 24; score += 1) {
      const statModifier = (key) => {
        const baseValue = numberFromGearTable(main[key]);
        let refinementValue = numberFromGearTable(refinement[key]) * (score + 6);
        if (["ATK", "MATK"].includes(key)) refinementValue = Math.floor(refinementValue);
        return modifierForEquipmentStat(key, roundGearValue(baseValue + refinementValue));
      };
      if (exclusive) {
        modifiersByScore[score] = { ...exclusiveFixed };
        primaryModifiersByScore[score] = Object.fromEntries(firstKeys.map((key) => [
          EQUIPMENT_STAT_KEYS[key], statModifier(key),
        ]));
        secondaryModifiersByScore[score] = Object.fromEntries(secondKeys.map((key) => [
          EQUIPMENT_STAT_KEYS[key], statModifier(key),
        ]));
        for (const primaryKey of firstKeys) {
          for (const secondaryKey of secondKeys) {
            const modifiers = {};
            mergeModifier(modifiers, exclusiveFixed);
            mergeModifier(modifiers, statModifier(primaryKey));
            mergeModifier(modifiers, statModifier(secondaryKey));
            oracleCases.push({
              equipment_id: raw.weaponId,
              kind: "EXCLUSIVE",
              owner_character_id: raw.characterId,
              slot: EQUIPMENT_SLOTS[raw.part],
              refinement_score: score,
              primary_stat: EQUIPMENT_STAT_KEYS[primaryKey],
              secondary_stat: EQUIPMENT_STAT_KEYS[secondaryKey],
              modifiers,
            });
          }
        }
      } else {
        const firstKey = firstKeys[0];
        const secondKey = secondKeys[0];
        const modifiers = {};
        mergeModifier(modifiers, statModifier(firstKey));
        mergeModifier(modifiers, modifierForEquipmentStat(secondKey, numberFromGearTable(main[secondKey])));
        modifiersByScore[score] = modifiers;
        oracleCases.push({
          equipment_id: raw.weaponId,
          kind: "CRAFTED_LEGENDARY",
          owner_character_id: null,
          slot: EQUIPMENT_SLOTS[raw.part],
          refinement_score: score,
          primary_stat: null,
          secondary_stat: null,
          modifiers,
        });
      }
    }
    const allowedKeys = SUBSTATS_BY_PROFILE[raw.substatType];
    if (!allowedKeys) throw new Error(`unknown equipment substat profile: ${raw.substatType}`);
    const substatModifiers = Object.fromEntries(allowedKeys.map((key) => [
      EQUIPMENT_STAT_KEYS[key],
      modifierForEquipmentStat(key, numberFromGearTable(sub[key])),
    ]));
    definitions[raw.weaponId] = {
      id: raw.weaponId,
      names: {
        "zh-TW": i18n.name ?? raw.name,
        "zh-CN": i18n.name_CN ?? raw.name,
        en: i18n.name_en ?? raw.name,
        ja: i18n.name_ja ?? raw.name,
        ko: i18n.name_ko ?? raw.name,
      },
      kind: exclusive ? "EXCLUSIVE" : "CRAFTED_LEGENDARY",
      tier: tableTier,
      slot: EQUIPMENT_SLOTS[raw.part],
      owner_character_id: exclusive ? raw.characterId : null,
      modifiers_by_refinement_score: modifiersByScore,
      primary_stat_options: exclusive ? firstKeys.map((key) => EQUIPMENT_STAT_KEYS[key]) : [],
      secondary_stat_options: exclusive ? secondKeys.map((key) => EQUIPMENT_STAT_KEYS[key]) : [],
      primary_modifiers_by_refinement_score: primaryModifiersByScore,
      secondary_modifiers_by_refinement_score: secondaryModifiersByScore,
      allowed_substats: allowedKeys.map((key) => EQUIPMENT_STAT_KEYS[key]),
      substat_modifiers: substatModifiers,
      source: {
        ...source,
        raw_payload: {
          equipment: raw,
          localization: i18n,
          ur4_tables: { main, sub, refinement, extra: exclusiveExtra },
        },
      },
    };
  }
  return { definitions, oracleCases };
}

function finiteNumber(value, label) {
  if (value === undefined || value === null || value === "") {
    throw new Error(`missing ${label}`);
  }
  const parsed = Number(String(value).replace(/[％%,]/g, ""));
  if (!Number.isFinite(parsed)) throw new Error(`invalid ${label}: ${value}`);
  return parsed;
}

function percent(value, label = "percentage") {
  return Math.round(finiteNumber(value, label) * 100);
}

function integer(value, label = "integer") {
  const parsed = finiteNumber(value, label);
  if (!Number.isInteger(parsed)) throw new Error(`non-integer ${label}: ${value}`);
  return parsed;
}

function requiredText(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`missing or invalid ${label}`);
  }
  return value;
}

function optionalLocalizedText(locale, value, label) {
  if (value === undefined || value === null || value === "") return {};
  return { [locale]: requiredText(value, label) };
}

function assertSerializableData(value, path = "$") {
  if (value === undefined) throw new Error(`${path} is undefined`);
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error(`${path} is not a finite number`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSerializableData(item, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      assertSerializableData(item, `${path}.${key}`);
    }
  }
}

function element(value) {
  const values = { "火": "FIRE", "水": "WATER", "風": "WIND", "光": "LIGHT", "闇": "DARK", "暗": "DARK" };
  const resolved = Object.hasOwn(values, value) ? values[value] : undefined;
  if (!resolved) throw new Error(`unsupported character element: ${value}`);
  return resolved;
}

function attackType(value) {
  const values = { "物": "PHYSICAL", "魔": "MAGICAL" };
  const resolved = Object.hasOwn(values, value) ? values[value] : undefined;
  if (!resolved) throw new Error(`unsupported character attack type: ${value}`);
  return resolved;
}

function selector(value) {
  const label = String(value ?? "").trim();
  const values = {
    "跳過": "SKIP",
    "過人": "SKIP",
    "自身": "SELF_UNIT",
    "自己": "SELF_UNIT",
    "戰場": "SELF_UNIT",
    "我方": "ALLY_FRONT",
    "最前": "FRONT",
    "最前方": "FRONT",
    "直擊": "FRONT",
  };
  if (Object.hasOwn(values, label)) return values[label];
  throw new Error(`unsupported target selector: ${label}`);
}

// Source labels describe direction from the target's point of view. Both
// battle boards use local coordinates with their front edge at depth 0.
function knockbackDirection(value) {
  const normalized = String(value ?? "").trim();
  const directions = {
    "後": "BACK",
    "前": "FRONT",
    "右": "UP",
    "左": "DOWN",
    "右後": "UP_BACK",
    "左後": "DOWN_BACK",
    "右前": "UP_FRONT",
    "左前": "DOWN_FRONT",
  };
  if (!Object.hasOwn(directions, normalized)) throw new Error(`unsupported character knockback direction: ${normalized}`);
  return directions[normalized];
}

function fiendAttackType(value) {
  const values = { ATK: "PHYSICAL", MATK: "MAGICAL" };
  const resolved = Object.hasOwn(values, value) ? values[value] : undefined;
  if (!resolved) throw new Error(`unsupported fiend attack type: ${value}`);
  return resolved;
}

function fiendTargeting(value) {
  const type = value?.type;
  if (type === "main") {
    if (value.mainTargetMode !== "front") throw new Error(`unsupported fiend main-target mode: ${value.mainTargetMode}`);
    return { selector: "FRONT", fixed_target_cell: null, target_all: false };
  }
  if (type === "all") return { selector: "EXPLICIT", fixed_target_cell: null, target_all: true };
  if (type === "fixed") {
    const sourceCoordinates = String(value.fixedTargetCellId ?? "").trim();
    if (!/^-?\d+,-?\d+$/.test(sourceCoordinates)) {
      throw new Error(`invalid fiend fixed-target cell: ${value.fixedTargetCellId}`);
    }
    const coordinates = sourceCoordinates.split(",").map(Number);
    const [depth, row] = coordinates;
    return { selector: "EXPLICIT", fixed_target_cell: { row, depth }, target_all: false };
  }
  throw new Error(`unsupported fiend targeting type: ${type}`);
}

function fiendRange(skill, targeting) {
  const offsets = skill.gameFacingRangeOffsets;
  if (targeting.target_all && Array.isArray(offsets) && offsets.length === 0) return [];
  if (!Array.isArray(offsets) || offsets.length === 0) {
    throw new Error(`missing fiend range offsets: ${skill.skillId}`);
  }
  return offsets.map((offset) => {
    if (!Number.isInteger(offset?.x) || !Number.isInteger(offset?.y)) {
      throw new Error(`invalid fiend range offset: ${skill.skillId}`);
    }
    return { row: offset.x, depth: offset.y };
  });
}

function fiendEffectPolarity(value) {
  const values = { Buff: "BENEFICIAL", Debuff: "HARMFUL" };
  if (!Object.hasOwn(values, value)) throw new Error(`unsupported fiend state type: ${value}`);
  return values[value];
}

function rangeCode(raw) {
  const match = String(raw ?? "").match(/(?:^|_)(all|\d{3})$/);
  if (!match) throw new Error(`unsupported skill range code: ${raw}`);
  return match[1];
}

// BD2DB stores range tuples in the rendered board's [depth, row] order.
// The simulator deliberately names its axes [row, depth] (3 rows x 4 depths),
// so keeping the source tuple order here transposes every non-symmetric skill.
function rangeOffsets(ranges, code) {
  if (!Array.isArray(ranges[code])) throw new Error(`skill range '${code}' is missing from the source range table`);
  return ranges[code].map(([depth, row]) => ({ row, depth }));
}

function scalar(level, token) {
  const key = String(token ?? "").replace(/[{}]/g, "");
  if (/^[A-Z]+\d+$/.test(key)) {
    if (!Object.hasOwn(level, key)) throw new Error(`missing skill scalar: ${key}`);
    return finiteNumber(level[key], `skill scalar ${key}`);
  }
  return finiteNumber(key, "literal skill scalar");
}

function applyScalarSwitches(level, switches, label) {
  if (!Array.isArray(switches)) throw new Error(`${label} switches must be an array`);
  for (const item of switches) {
    const target = String(item?.target ?? "");
    if (!target) throw new Error(`${label} contains a switch without a target`);
    // CD switches encode a cooldown reduction, not an additive skill scalar.
    if (target === "CD") continue;
    if (!Object.hasOwn(level, target)) {
      throw new Error(`${label} references missing skill scalar ${target}`);
    }
    level[target] = finiteNumber(level[target], `${label} ${target}`)
      + finiteNumber(item.value, `${label} ${target} delta`);
  }
}

function effect(effectId, polarity, recipient, duration, modifiers = {}, tags = [], extra = {}) {
  return {
    op: "APPLY_EFFECT",
    effect: {
      effect_id: effectId,
      polarity,
      recipient,
      duration: Math.max(1, integer(duration)),
      duration_clock: "GAME_TURN",
      modifiers,
      tags,
      stack_rule: "REPLACE_SAME_SOURCE",
      barrier: null,
      periodic: null,
      charges: null,
      evasion_decay_bp: 0,
      counter: null,
      revive_hp_bp: null,
      max_stacks: null,
      conditional_outgoing: [],
      on_hit_received_allies: null,
      on_hit_received_operations: [],
      on_turn_end_operations: [],
      aura_allies: null,
      aura_opponents: null,
      on_chain_dealt: null,
      ...extra,
    },
  };
}

function splitSentences(lines) {
  const raw = lines.flatMap((line) => String(line).split(/[。\n]/)).map((line) => line.trim()).filter(Boolean);
  const merged = [];
  for (let index = 0; index < raw.length; index += 1) {
    if (/^若/.test(raw[index]) && index + 1 < raw.length && /^則/.test(raw[index + 1])) {
      merged.push(`${raw[index]} ${raw[index + 1]}`);
      index += 1;
    } else merged.push(raw[index]);
  }
  return merged;
}

function statReference(label) {
  if (label.includes("能量防衛")) return "ENERGY_GUARD";
  if (label.includes("敵人最大生命力")) return "TARGET_MAX_HP";
  if (label.includes("敵人目前生命力")) return "TARGET_CURRENT_HP";
  if (label.includes("敵人攻擊力")) return "TARGET_ATTACK";
  if (label.includes("敵人魔法力")) return "TARGET_MAGIC";
  if (label.includes("最大生命力") || label.includes("最大生命")) return "MAX_HP";
  if (label.includes("目前生命力")) return "CURRENT_HP";
  if (label.includes("魔法力")) return "MAGIC";
  return "ATTACK";
}

function durationFrom(sentence, level, fallback = 1) {
  const match = sentence.match(/(\{VALUE\d+\}|\d+)回合期間/);
  return match ? scalar(level, match[1]) : fallback;
}

function directDamage(sentence, character, costume, level) {
  if (/套用.*(?:出血|燒傷|中毒|腐敗|凍傷|惡夢)效果/.test(sentence)) return null;
  if (/反擊時/.test(sentence)) return null;
  if (!/(?:對敵人造成|攻擊敵人|每次攻擊(?:時)?，?造成|造成(?:相當於)?(?:自身|敵人)|造成\s*\{)/.test(sentence)) return null;
  const referenceMatch = sentence.match(/((?:自身|敵人)?(?:攻擊力|魔法力|最大生命力|目前生命力)|自身持有的能量防衛)\s*(?:的)?\s*(\{(?:VALUE|HIT)\d+\}|\d+(?:\.\d+)?)%/);
  const coefficientFirstMatch = sentence.match(/(\{(?:VALUE|HIT)\d+\}|\d+(?:\.\d+)?)%\s*((?:自身|敵人)?(?:攻擊力|魔法力|最大生命力|目前生命力))/);
  let coefficientBp = 0;
  let reference = null;
  if (referenceMatch) {
    coefficientBp = Math.round(scalar(level, referenceMatch[2]) * 100);
    reference = statReference(referenceMatch[1]);
  } else if (coefficientFirstMatch) {
    coefficientBp = Math.round(scalar(level, coefficientFirstMatch[1]) * 100);
    reference = statReference(coefficientFirstMatch[2]);
  } else if (/造成1的物理傷害/.test(sentence)) {
    coefficientBp = 1;
    reference = "FIXED";
  } else {
    return null;
  }
  const kind = /固定傷害|純粹傷害/.test(sentence)
    ? "FIXED"
    : /魔法傷害/.test(sentence) ? "MAGICAL" : /物理傷害/.test(sentence) ? "PHYSICAL" : attackType(character.atkType);
  const hits = Math.max(1, integer(level.HIT1 ?? costume.chain ?? 1));
  return { op: "DEAL_DAMAGE", kind, coefficient_bp: coefficientBp, reference, scaling: null, hits, can_crit: kind !== "FIXED", can_evade: true, chain_per_hit: 1, main_target_bonus_bp: 0 };
}

function conditionalDamageRule(sentence, level, hits) {
  let match = sentence.match(/連鎖(?:數)?(?:疊加為|是)(\d+)或以上/);
  if (match) {
    const threshold = Math.max(0, integer(match[1]) - hits);
    return { when: { type: "TARGET_CHAIN_AT_LEAST", value: threshold }, otherwise: { type: "TARGET_CHAIN_AT_MOST", value: Math.max(0, threshold - 1) } };
  }
  match = sentence.match(/連鎖(?:數)?(?:疊加為|是)(\d+)或以下/);
  if (match) {
    const threshold = Math.max(0, integer(match[1]) - hits);
    return { when: { type: "TARGET_CHAIN_AT_MOST", value: threshold }, otherwise: { type: "TARGET_CHAIN_AT_LEAST", value: threshold + 1 } };
  }
  match = sentence.match(/連鎖為(\d+)的倍數/);
  if (match) return { when: { type: "TARGET_CHAIN_MULTIPLE_OF", value: integer(match[1]) }, otherwise: { type: "TARGET_CHAIN_NOT_MULTIPLE_OF", value: integer(match[1]) } };
  if (/敵人為主要目標/.test(sentence)) return { when: { type: "IS_MAIN_TARGET" }, otherwise: { type: "IS_NOT_MAIN_TARGET" } };
  if (/處於持續傷害/.test(sentence)) return { when: { type: "TARGET_HAS_TAG", tag: "DOT" }, otherwise: { type: "TARGET_LACKS_TAG", tag: "DOT" } };
  if (/處於脆弱/.test(sentence)) return { when: { type: "TARGET_HAS_TAG", tag: "VULNERABLE" }, otherwise: { type: "TARGET_LACKS_TAG", tag: "VULNERABLE" } };
  if (/處於挑釁或集中攻擊/.test(sentence)) return {
    when: { type: "ANY", conditions: [{ type: "TARGET_HAS_TAG", tag: "TAUNT" }, { type: "TARGET_HAS_TAG", tag: "FOCUS" }] },
    otherwise: { type: "ALL", conditions: [{ type: "TARGET_LACKS_TAG", tag: "TAUNT" }, { type: "TARGET_LACKS_TAG", tag: "FOCUS" }] },
  };
  if (/敵人為物理類型/.test(sentence)) return { when: { type: "TARGET_ATTACK_TYPE", attack_type: "PHYSICAL" }, otherwise: { type: "TARGET_NOT_ATTACK_TYPE", attack_type: "PHYSICAL" } };
  match = sentence.match(/有害效果數量為(\d+)個或以上/);
  if (match) return { when: { type: "TARGET_EFFECT_COUNT_AT_LEAST", polarity: "HARMFUL", value: integer(match[1]) }, otherwise: { type: "TARGET_EFFECT_COUNT_AT_MOST", polarity: "HARMFUL", value: integer(match[1]) - 1 } };
  return null;
}

function compileOperations(character, costume, level, burstExtras = [], enhancement = 5) {
  const additionalExtras = burstExtras.flatMap((stage) => [
    ...(stage.type === "Plus" ? [stage] : []),
    ...(stage.extraEffects ?? []).filter((extra) => extra.type === "Plus").map((extra) => ({
      ...extra,
      value: extra.value ?? (String(stage.value ?? "").includes("[追加能力]") ? String(stage.value).split("[追加能力]").slice(1).join("[追加能力]") : null),
    })),
  ]);
  const burstLines = additionalExtras.map((stage) => stage.value).filter(Boolean);
  const lines = [...(costume.skill ?? []), ...burstLines].map((line) => String(line).replaceAll("％", "%"));
  const joined = lines.join(" ");
  const sentences = splitSentences(lines);
  const operations = [];
  const postDamageOperations = [];
  const diagnostics = [];
  const firstDamageSentenceIndex = sentences.findIndex((sentence) => directDamage(sentence, character, costume, level));
  let postDamageFlushed = false;
  const containsDamage = operation => operation?.op === "DEAL_DAMAGE"
    || (operation?.operations ?? []).some(containsDamage);
  const queueAtSourcePosition = (operation, sentenceIndex) => {
    const beforeDamage = firstDamageSentenceIndex < 0 || sentenceIndex < firstDamageSentenceIndex;
    if (!beforeDamage && !postDamageFlushed) {
      postDamageOperations.push(operation);
      return;
    }
    if (beforeDamage) {
      const damageIndex = operations.findIndex(containsDamage);
      if (damageIndex >= 0) {
        operations.splice(damageIndex, 0, operation);
        return;
      }
    }
    operations.push(operation);
  };
  const removeStatOperations = () => {
    for (const list of [operations, postDamageOperations]) {
      for (let index = list.length - 1; index >= 0; index -= 1) {
        if (list[index].effect?.effect_id?.startsWith(`${costume.costumeId}:STAT:`)) list.splice(index, 1);
      }
    }
  };

  const hpCost = joined.match(/受到(?:相當於)?自身目前生命力(\{VALUE\d+\}|\d+(?:\.\d+)?)%的傷害/);
  if (hpCost) {
    operations.push({ op: "CONSUME_HP", coefficient_bp: Math.round(scalar(level, hpCost[1]) * 100), reference: "CURRENT_HP", can_kill: false });
  }

  const evasionCharges = joined.match(/成功迴避(\{VALUE\d+\}|\d+)次前，?以(\{VALUE\d+\}|\d+(?:\.\d+)?)%的機率迴避/);
  const timedEvasion = joined.match(/(\{VALUE\d+\}|\d+)回合期間，?自身有(\{VALUE\d+\}|\d+(?:\.\d+)?)%的機率迴避/);
  const evasionDecay = joined.match(/成功迴避後續攻擊的機率將減少(\{VALUE\d+\}|\d+(?:\.\d+)?)%/);
  const evasionExtra = { evasion_decay_bp: evasionDecay ? Math.round(scalar(level, evasionDecay[1]) * 100) : 0 };
  if (evasionCharges) {
    operations.push(effect(`${costume.costumeId}:EVASION`, "BENEFICIAL", "ACTOR_SIDE", 1, { evasion_bp: Math.round(scalar(level, evasionCharges[2]) * 100) }, ["EVASION"], { duration_clock: "PERMANENT", charges: integer(scalar(level, evasionCharges[1])), ...evasionExtra }));
  } else if (timedEvasion) {
    operations.push(effect(`${costume.costumeId}:EVASION`, "BENEFICIAL", "ACTOR_SIDE", scalar(level, timedEvasion[1]), { evasion_bp: Math.round(scalar(level, timedEvasion[2]) * 100) }, ["EVASION"], evasionExtra));
  }

  // Self/allied stat modifiers that explicitly happen before direct damage.
  let conditionalEffectCompiled = false;
  for (const [sentenceIndex, sentence] of sentences.entries()) {
    if (!/(增加|減少)/.test(sentence) || !/(攻擊力|魔法力|致命率|致命傷害|屬性傷害|防禦力|魔法抵抗)/.test(sentence)) continue;
    if (/光環效果內/.test(sentence)) continue;
    if (String(costume.tags ?? "").includes("領域") && /我軍.*(?:攻擊力|魔法力)/.test(sentence)) continue;
    if (/若敵人為魔法類型|若目標為光屬性|若自身套用能力值強化效果|若自身正套用增強效果|攻擊力增加疊加數達24/.test(sentence)) continue;
    const beneficialThreshold = sentence.match(/若持有的有益效果數量達(\d+)個或以上時.*?(\{VALUE\d+\}|\d+)回合期間.*?對自身套用致命傷害增加(\{VALUE\d+\}|\d+(?:\.\d+)?)%/);
    if (beneficialThreshold) {
      const conditionalCrit = effect(`${costume.costumeId}:CONDITIONAL_CRIT_DAMAGE`, "BENEFICIAL", "ACTOR_SIDE", scalar(level, beneficialThreshold[2]), { crit_damage_bp: Math.round(scalar(level, beneficialThreshold[3]) * 100) }, ["STAT_REINFORCEMENT"]);
      operations.push({ op: "CONDITIONAL", condition: { type: "ACTOR_EFFECT_COUNT_AT_LEAST", polarity: "BENEFICIAL", value: integer(beneficialThreshold[1]) }, operations: [conditionalCrit] });
      conditionalEffectCompiled = true;
      continue;
    }
    if (/受到攻擊時|每當自身受到攻擊/.test(sentence)) continue;
    if (/若|每有|依.*數量|疊加數|進入加速狀態|累積連鎖時/.test(sentence)) {
      if (/進入加速狀態|累積連鎖時/.test(sentence)) continue;
      diagnostics.push(`conditional stat effect requires reviewed condition: ${sentence}`);
      continue;
    }
    const amountMatch = sentence.match(/(增加|減少)\s*(\{VALUE\d+\}|\d+(?:\.\d+)?)%/);
    if (!amountMatch) continue;
    const sign = amountMatch[1] === "減少" ? -1 : 1;
    const amount = Math.round(scalar(level, amountMatch[2]) * 100) * sign;
    const modifiers = {};
    if (sentence.includes("攻擊力或魔法力") || sentence.includes("防禦力和魔法抵抗")) {
      if (sentence.includes("攻擊力")) { modifiers.attack_bp = amount; modifiers.magic_bp = amount; }
      else { modifiers.defense_bp = amount; modifiers.magic_resist_bp = amount; }
    } else if (sentence.includes("致命傷害")) modifiers.crit_damage_bp = amount;
    else if (sentence.includes("致命率")) modifiers.crit_rate_bp = amount;
    else if (sentence.includes("屬性傷害")) modifiers.property_damage_bp = amount;
    else if (sentence.includes("魔法抵抗")) modifiers.magic_resist_bp = amount;
    else if (sentence.includes("防禦力")) modifiers.defense_bp = amount;
    else if (sentence.includes("魔法力")) modifiers.magic_bp = amount;
    else if (sentence.includes("攻擊力")) modifiers.attack_bp = amount;
    const actorSide = /自身/.test(sentence) || (sign > 0 && !/我軍/.test(sentence));
    const recipient = actorSide ? "ACTOR_SIDE" : /我軍/.test(sentence) ? "ACTOR_TEAM" : "TARGET_SIDE";
    const stackLead = sentences[sentenceIndex + 1] ?? "";
    const stackTail = /疊加/.test(stackLead) ? (sentences[sentenceIndex + 2] ?? "") : "";
    const stackSentence = `${stackLead} ${stackTail}`;
    const stackCap = /疊加/.test(stackLead) ? stackSentence.match(/最多可(?:賦予)?疊加至(\{VALUE\d+\}|\d+)/) : null;
    const applicationCountMatch = /疊加/.test(stackLead)
      ? stackLead.match(/(?:可)?疊加(?:至)?\s*(\{VALUE\d+\}|\d+)(?:次|層)?/)
      : null;
    const chargeSentence = stackCap
      ? (stackTail.includes("最多可") ? (sentences[sentenceIndex + 3] ?? "") : (sentences[sentenceIndex + 2] ?? ""))
      : stackLead;
    const receivedHitCharge = chargeSentence.match(/此效果將在受到(\{VALUE\d+\}|\d+)次攻擊後消失/);
    const extra = {};
    if (stackCap) {
      extra.stack_rule = "INDEPENDENT";
      extra.max_stacks = integer(scalar(level, stackCap[1]));
    }
    if (receivedHitCharge) {
      extra.duration_clock = "PERMANENT";
      extra.charges = integer(scalar(level, receivedHitCharge[1]));
      extra.tags = [sign > 0 ? "STAT_REINFORCEMENT" : "STAT_WEAKENING", "RECEIVED_HIT_CHARGE"];
    }
    const applicationCount = Math.max(1, integer(scalar(level, applicationCountMatch?.[1] ?? 1)));
    for (let application = 0; application < applicationCount; application += 1) {
      queueAtSourcePosition(
        effect(`${costume.costumeId}:STAT:${sentenceIndex}`, sign > 0 ? "BENEFICIAL" : "HARMFUL", recipient, durationFrom(sentence, level), modifiers, [sign > 0 ? "STAT_REINFORCEMENT" : "STAT_WEAKENING"], extra),
        sentenceIndex,
      );
    }
  }

  for (const sentence of sentences) {
    const enhancement = sentence.match(/(\{VALUE\d+\}|\d+)回合期間.*?(?:我軍|自身).*?施加(?:的)?傷害增加(\{VALUE\d+\}|\d+(?:\.\d+)?)%/);
    if (enhancement && !/若|每有|連鎖/.test(sentence)) operations.push(effect(`${costume.costumeId}:AMPLIFICATION`, "BENEFICIAL", sentence.includes("自身") ? "ACTOR_SIDE" : "ACTOR_TEAM", scalar(level, enhancement[1]), { outgoing_damage_bp: Math.round(scalar(level, enhancement[2]) * 100) }, ["AUGMENTATION"]));
    const wrappedEnhancement = sentence.match(/對(我軍|自身)套用在(\{VALUE\d+\}|\d+)回合期間，施加(?:的)?傷害增加(\{VALUE\d+\}|\d+(?:\.\d+)?)%/);
    if (wrappedEnhancement) operations.push(effect(`${costume.costumeId}:AMPLIFICATION`, "BENEFICIAL", wrappedEnhancement[1] === "自身" ? "ACTOR_SIDE" : "ACTOR_TEAM", scalar(level, wrappedEnhancement[2]), { outgoing_damage_bp: Math.round(scalar(level, wrappedEnhancement[3]) * 100) }, ["AUGMENTATION"]));
    const leadingEnhancement = sentence.match(/對(我軍|自身)在(\{VALUE\d+\}|\d+)回合期間，套用施加(?:的)?傷害增加(\{VALUE\d+\}|\d+(?:\.\d+)?)%/);
    if (leadingEnhancement) operations.push(effect(`${costume.costumeId}:AMPLIFICATION`, "BENEFICIAL", leadingEnhancement[1] === "自身" ? "ACTOR_SIDE" : "ACTOR_TEAM", scalar(level, leadingEnhancement[2]), { outgoing_damage_bp: Math.round(scalar(level, leadingEnhancement[3]) * 100) }, ["AUGMENTATION"]));
    const nextAllyEnhancement = sentence.match(/對下一個攻擊順序的我軍，?在(\{VALUE\d+\}|\d+)回合期間，套用施加(?:的)?傷害增加(\{VALUE\d+\}|\d+(?:\.\d+)?)%/);
    if (nextAllyEnhancement) operations.push(effect(`${costume.costumeId}:AMPLIFICATION`, "BENEFICIAL", "TARGET_SIDE", scalar(level, nextAllyEnhancement[1]), { outgoing_damage_bp: Math.round(scalar(level, nextAllyEnhancement[2]) * 100) }, ["AUGMENTATION"]));
    const basic = sentence.match(/一般攻擊施加的傷害增加(\{VALUE\d+\}|\d+(?:\.\d+)?)%/);
    if (basic) operations.push(effect(`${costume.costumeId}:BASIC_ATTACK`, "BENEFICIAL", "ACTOR_SIDE", 1, { normal_attack_damage_bp: Math.round(scalar(level, basic[1]) * 100) }, ["BASIC_ATTACK_AUGMENT"], { duration_clock: "PERMANENT", charges: 1 }));
  }

  const conditionalMagicDebuff = joined.match(/(\{VALUE\d+\}|\d+)回合期間，敵人的攻擊力減少(\{VALUE\d+\}|\d+(?:\.\d+)?)%.*若敵人為魔法類型.*?(\{VALUE\d+\}|\d+)回合期間，魔法力減少(\{VALUE\d+\}|\d+(?:\.\d+)?)%/);
  if (conditionalMagicDebuff) {
    removeStatOperations();
    const physical = effect(`${costume.costumeId}:ATK_DOWN`, "HARMFUL", "TARGET_SIDE", scalar(level, conditionalMagicDebuff[1]), { attack_bp: -Math.round(scalar(level, conditionalMagicDebuff[2]) * 100) }, ["STAT_WEAKENING"]);
    const magical = effect(`${costume.costumeId}:MATK_DOWN`, "HARMFUL", "TARGET_SIDE", scalar(level, conditionalMagicDebuff[3]), { magic_bp: -Math.round(scalar(level, conditionalMagicDebuff[4]) * 100) }, ["STAT_WEAKENING"]);
    const sourceIndex = sentences.findIndex((sentence) => /敵人的攻擊力減少/.test(sentence));
    queueAtSourcePosition({ op: "CONDITIONAL", condition: { type: "TARGET_ATTACK_TYPE", attack_type: "MAGICAL" }, operations: [magical] }, sourceIndex);
    queueAtSourcePosition({ op: "CONDITIONAL", condition: { type: "TARGET_NOT_ATTACK_TYPE", attack_type: "MAGICAL" }, operations: [physical] }, sourceIndex);
  }
  const lightProperty = joined.match(/(\{VALUE\d+\}|\d+)回合期間，我軍的屬性傷害增加(\{VALUE\d+\}|\d+(?:\.\d+)?)%.*若目標為光屬性.*?屬性傷害變為增加(\{VALUE\d+\}|\d+(?:\.\d+)?)%/);
  if (lightProperty) {
    removeStatOperations();
    const normal = effect(`${costume.costumeId}:PROPERTY`, "BENEFICIAL", "ACTOR_TEAM", scalar(level, lightProperty[1]), { property_damage_bp: Math.round(scalar(level, lightProperty[2]) * 100) }, ["STAT_REINFORCEMENT"]);
    const light = effect(`${costume.costumeId}:PROPERTY_LIGHT`, "BENEFICIAL", "ACTOR_TEAM", scalar(level, lightProperty[1]), { property_damage_bp: Math.round(scalar(level, lightProperty[3]) * 100) }, ["STAT_REINFORCEMENT"]);
    operations.push({ op: "CONDITIONAL", condition: { type: "TARGET_ELEMENT", element: "LIGHT" }, operations: [light] });
    operations.push({ op: "CONDITIONAL", condition: { type: "TARGET_NOT_ELEMENT", element: "LIGHT" }, operations: [normal] });
  }
  const actorStatAlternative = joined.match(/(\{VALUE\d+\}|\d+)回合期間，自身的攻擊力增加(\{VALUE\d+\}|\d+(?:\.\d+)?)%.*若自身套用能力值強化效果.*?(\{VALUE\d+\}|\d+)回合期間，屬性傷害增加(\{VALUE\d+\}|\d+(?:\.\d+)?)%/);
  if (actorStatAlternative) {
    removeStatOperations();
    const attackBuff = effect(`${costume.costumeId}:ATK`, "BENEFICIAL", "ACTOR_SIDE", scalar(level, actorStatAlternative[1]), { attack_bp: Math.round(scalar(level, actorStatAlternative[2]) * 100) }, ["STAT_REINFORCEMENT"]);
    const propertyBuff = effect(`${costume.costumeId}:PROPERTY`, "BENEFICIAL", "ACTOR_SIDE", scalar(level, actorStatAlternative[3]), { property_damage_bp: Math.round(scalar(level, actorStatAlternative[4]) * 100) }, ["STAT_REINFORCEMENT"]);
    operations.push({ op: "CONDITIONAL", condition: { type: "ACTOR_HAS_TAG", tag: "STAT_REINFORCEMENT" }, operations: [propertyBuff] });
    operations.push({ op: "CONDITIONAL", condition: { type: "ACTOR_LACKS_TAG", tag: "STAT_REINFORCEMENT" }, operations: [attackBuff] });
  }

  let customHookCompiled = false;
  const conditionalAllyDamage = joined.match(/(\{VALUE\d+\}|\d+)回合期間，攻擊連鎖疊加(\d+)或以下的敵人時，.*?我軍.*?傷害增加(\{VALUE\d+\}|\d+(?:\.\d+)?)%/);
  if (conditionalAllyDamage) {
    operations.push(effect(`${costume.costumeId}:CONDITIONAL_DAMAGE`, "BENEFICIAL", "ACTOR_TEAM", scalar(level, conditionalAllyDamage[1]), {}, ["AUGMENTATION"], { conditional_outgoing: [{ condition: { type: "TARGET_CHAIN_AT_MOST", value: integer(conditionalAllyDamage[2]) }, amount_bp: Math.round(scalar(level, conditionalAllyDamage[3]) * 100) }] }));
    customHookCompiled = true;
  }
  const conditionalAllyDamageAtLeast = joined.match(/(\{VALUE\d+\}|\d+)回合期間，攻擊連鎖疊加(\d+)或以上的敵人時，.*?我軍.*?傷害增加(\{VALUE\d+\}|\d+(?:\.\d+)?)%/);
  if (conditionalAllyDamageAtLeast) {
    operations.push(effect(`${costume.costumeId}:CONDITIONAL_DAMAGE`, "BENEFICIAL", "ACTOR_TEAM", scalar(level, conditionalAllyDamageAtLeast[1]), {}, ["AUGMENTATION"], { conditional_outgoing: [{ condition: { type: "TARGET_CHAIN_AT_LEAST", value: integer(conditionalAllyDamageAtLeast[2]) }, amount_bp: Math.round(scalar(level, conditionalAllyDamageAtLeast[3]) * 100) }] }));
    customHookCompiled = true;
  }
  const actorAugmentAlternative = joined.match(/對自身在(\{VALUE\d+\}|\d+)回合期間，套用施加(?:的)?傷害增加(\{VALUE\d+\}|\d+(?:\.\d+)?)%的增強效果.*?若自身正套用增強效果.*?(\{VALUE\d+\}|\d+)回合期間，致命傷害增加(\{VALUE\d+\}|\d+(?:\.\d+)?)%/);
  if (actorAugmentAlternative) {
    const augment = effect(`${costume.costumeId}:AUGMENTATION`, "BENEFICIAL", "ACTOR_SIDE", scalar(level, actorAugmentAlternative[1]), { outgoing_damage_bp: Math.round(scalar(level, actorAugmentAlternative[2]) * 100) }, ["AUGMENTATION"]);
    const critical = effect(`${costume.costumeId}:CONDITIONAL_CRIT_DAMAGE`, "BENEFICIAL", "ACTOR_SIDE", scalar(level, actorAugmentAlternative[3]), { crit_damage_bp: Math.round(scalar(level, actorAugmentAlternative[4]) * 100) }, ["STAT_REINFORCEMENT"]);
    operations.push({ op: "CONDITIONAL", condition: { type: "ACTOR_HAS_TAG", tag: "AUGMENTATION" }, operations: [critical] });
    operations.push({ op: "CONDITIONAL", condition: { type: "ACTOR_LACKS_TAG", tag: "AUGMENTATION" }, operations: [augment] });
    conditionalEffectCompiled = true;
    customHookCompiled = true;
  }
  const onHitAlly = joined.match(/(\{VALUE\d+\}|\d+)回合期間，自身每次受到攻擊時，對我軍套用(\{VALUE\d+\}|\d+(?:\.\d+)?)%的增強效果.*?維持(\{VALUE\d+\}|\d+)回合/);
  if (onHitAlly) {
    const nested = effect(`${costume.costumeId}:HIT_AUGMENT`, "BENEFICIAL", "TARGET_SIDE", scalar(level, onHitAlly[3]), { outgoing_damage_bp: Math.round(scalar(level, onHitAlly[2]) * 100) }, ["AUGMENTATION"], { stack_rule: "INDEPENDENT", max_stacks: 99 }).effect;
    operations.push(effect(`${costume.costumeId}:ON_HIT`, "BENEFICIAL", "ACTOR_SIDE", scalar(level, onHitAlly[1]), {}, ["ON_HIT"], { on_hit_received_allies: nested }));
    customHookCompiled = true;
  }
  const onHitHeal = joined.match(/(\{VALUE\d+\}|\d+)回合期間，每次受到攻擊時，恢復相當於自身最大生命力(\{VALUE\d+\}|\d+(?:\.\d+)?)%/);
  if (onHitHeal) {
    operations.push(effect(`${costume.costumeId}:ON_HIT_HEAL`, "BENEFICIAL", "ACTOR_SIDE", scalar(level, onHitHeal[1]), {}, ["ON_HIT"], {
      on_hit_received_operations: [{ op: "HEAL", coefficient_bp: Math.round(scalar(level, onHitHeal[2]) * 100), reference: "MAX_HP", can_crit: false, recipient: "ACTOR_SIDE" }],
    }));
    customHookCompiled = true;
  }
  const onHitSp = joined.match(/(\{VALUE\d+\}|\d+)回合期間，自身受到攻擊時，我軍[的の]?SP(?:恢復|增加)(\{VALUE\d+\}|\d+)點/);
  if (onHitSp) {
    operations.push(effect(`${costume.costumeId}:ON_HIT_SP`, "BENEFICIAL", "ACTOR_SIDE", scalar(level, onHitSp[1]), {}, ["ON_HIT"], {
      on_hit_received_operations: [{ op: "CHANGE_SP", amount: integer(scalar(level, onHitSp[2])), side: "ACTOR_SIDE" }],
    }));
    customHookCompiled = true;
  }
  const onHitAttack = joined.match(/(\{VALUE\d+\}|\d+)回合期間，自身受到攻擊時，則在(\{VALUE\d+\}|\d+)回合期間，套用自身[的の]?攻擊力增加(\{VALUE\d+\}|\d+(?:\.\d+)?)%[的の]?效果/);
  if (onHitAttack) {
    const nested = effect(`${costume.costumeId}:ON_HIT_ATTACK_STACK`, "BENEFICIAL", "ACTOR_SIDE", scalar(level, onHitAttack[2]), { attack_bp: Math.round(scalar(level, onHitAttack[3]) * 100) }, ["STAT_REINFORCEMENT"], { stack_rule: "INDEPENDENT", max_stacks: 99 }).effect;
    operations.push(effect(`${costume.costumeId}:ON_HIT_ATTACK`, "BENEFICIAL", "ACTOR_SIDE", scalar(level, onHitAttack[1]), {}, ["ON_HIT"], {
      on_hit_received_operations: [{ op: "APPLY_EFFECT", effect: nested }],
    }));
    customHookCompiled = true;
  }
  const onHitCooldown = joined.match(/(\{VALUE\d+\}|\d+)回合期間，自身受到攻擊時，當前服裝[的の]?冷卻時間減少(\{VALUE\d+\}|\d+)/);
  if (onHitCooldown) {
    operations.push(effect(`${costume.costumeId}:ON_HIT_COOLDOWN`, "BENEFICIAL", "ACTOR_SIDE", scalar(level, onHitCooldown[1]), {}, ["ON_HIT"], {
      on_hit_received_operations: [{ op: "CHANGE_COSTUME_COOLDOWN", amount: -integer(scalar(level, onHitCooldown[2])), costume_id: costume.costumeId }],
    }));
    customHookCompiled = true;
  }
  const onHitVulnerability = joined.match(/每當自身受到攻擊時，對敵人套用(\{VALUE\d+\}|\d+(?:\.\d+)?)%[的の]?脆弱效果.*?受到(\{VALUE\d+\}|\d+)次攻擊時消失.*?脆弱效果[的の]?(\{VALUE\d+\}|\d+)回合期間.*?最多可賦予疊加至(\{VALUE\d+\}|\d+)/);
  if (onHitVulnerability) {
    const nested = effect(`${costume.costumeId}:ON_HIT_VULNERABILITY_STACK`, "HARMFUL", "TARGET_SIDE", scalar(level, onHitVulnerability[3]), { incoming_damage_bp: Math.round(scalar(level, onHitVulnerability[1]) * 100) }, ["VULNERABLE"], { stack_rule: "INDEPENDENT", max_stacks: integer(scalar(level, onHitVulnerability[4])) }).effect;
    operations.push(effect(`${costume.costumeId}:ON_HIT_VULNERABILITY`, "BENEFICIAL", "ACTOR_SIDE", 1, {}, ["ON_HIT"], {
      duration_clock: "PERMANENT",
      charges: integer(scalar(level, onHitVulnerability[2])),
      on_hit_received_operations: [{ op: "APPLY_EFFECT", effect: nested }],
    }));
    customHookCompiled = true;
  }
  const turnEndSp = joined.match(/(\{VALUE\d+\}|\d+)回合期間，每回合結束時，恢復我軍SP(\{VALUE\d+\}|\d+)點/);
  if (turnEndSp) {
    operations.push(effect(`${costume.costumeId}:TURN_END_SP`, "BENEFICIAL", "ACTOR_SIDE", scalar(level, turnEndSp[1]), {}, ["TURN_END"], {
      on_turn_end_operations: [{ op: "CHANGE_SP", amount: integer(scalar(level, turnEndSp[2])), side: "ACTOR_SIDE" }],
    }));
    customHookCompiled = true;
  }
  const turnEndHeal = joined.match(/(\{VALUE\d+\}|\d+)回合期間，每回合結束時，恢復我軍相當於自身(?:各自)?(最大生命力|目前生命力|攻擊力|魔法力)(\{VALUE\d+\}|\d+(?:\.\d+)?)%的生命力/);
  if (turnEndHeal) {
    const reference = turnEndHeal[2] === "最大生命力" ? "TARGET_MAX_HP"
      : turnEndHeal[2] === "目前生命力" ? "TARGET_CURRENT_HP"
        : statReference(turnEndHeal[2]);
    operations.push(effect(`${costume.costumeId}:TURN_END_HEAL`, "BENEFICIAL", "ACTOR_SIDE", scalar(level, turnEndHeal[1]), {}, ["TURN_END", "RECOVERY"], {
      on_turn_end_operations: [{ op: "HEAL", coefficient_bp: Math.round(scalar(level, turnEndHeal[3]) * 100), reference, can_crit: false, recipient: "ACTOR_TEAM" }],
    }));
    customHookCompiled = true;
  }
  const absorbDebuffs = joined.match(/吸收套用至我軍的有害效果.*?(\{VALUE\d+\}|\d+)回合期間，每吸收1個有害效果，賦予我軍1層(\{VALUE\d+\}|\d+(?:\.\d+)?)%的增強效果.*?最多可賦予疊加至(\{VALUE\d+\}|\d+)/);
  if (absorbDebuffs) {
    const absorbedStack = effect(`${costume.costumeId}:ABSORBED_AUGMENTATION`, "BENEFICIAL", "TARGET_SIDE", scalar(level, absorbDebuffs[1]), { outgoing_damage_bp: Math.round(scalar(level, absorbDebuffs[2]) * 100) }, ["AUGMENTATION"], { stack_rule: "INDEPENDENT", max_stacks: integer(scalar(level, absorbDebuffs[3])) }).effect;
    operations.push({ op: "ABSORB_EFFECTS_AND_APPLY_STACKS", polarity: "HARMFUL", recipient: "ACTOR_TEAM", effect: absorbedStack, max_stacks: integer(scalar(level, absorbDebuffs[3])) });
    customHookCompiled = true;
  }
  const resonance = joined.match(/每有1名目標，便對自身疊加(\{VALUE\d+\}|\d+)層(\{VALUE\d+\}|\d+(?:\.\d+)?)%的增強效果/);
  if (resonance) {
    const nested = effect(`${costume.costumeId}:RESONANCE`, "BENEFICIAL", "ACTOR_SIDE", 6, { outgoing_damage_bp: Math.round(scalar(level, resonance[2]) * 100) }, ["AUGMENTATION", "RESONANCE"], { stack_rule: "INDEPENDENT", max_stacks: 30 }).effect;
    operations.push({ op: "APPLY_EFFECT_PER_MATCHING_ENEMY", effect: nested, tag: "STAT_WEAKENING", stacks_per_unit: integer(scalar(level, resonance[1])), max_stacks: 30 });
    customHookCompiled = true;
  }
  const renewingAura = joined.match(/(\{VALUE\d+\}|\d+)回合期間，對自身套用光環效果.*?我軍將套用自身魔法力(\{VALUE\d+\}|\d+(?:\.\d+)?)%的能量防衛效果.*?每回合恢復/);
  if (renewingAura) {
    const nested = effect(`${costume.costumeId}:AURA_GUARD`, "BENEFICIAL", "TARGET_SIDE", 1, {}, ["ENERGY_GUARD"], { barrier: { coefficient_bp: Math.round(scalar(level, renewingAura[2]) * 100), reference: "MAGIC" } }).effect;
    operations.push(effect(`${costume.costumeId}:AURA`, "BENEFICIAL", "ACTOR_SIDE", scalar(level, renewingAura[1]), {}, ["AURA"], { aura_allies: nested }));
    customHookCompiled = true;
  }
  const genericAuraDuration = joined.match(/(\{VALUE\d+\}|\d+)回合期間，對自身套用光環效果/);
  if (genericAuraDuration && !renewingAura) {
    const auraSentence = sentences.find((sentence) => /光環效果內/.test(sentence)) ?? "";
    const modifiers = {};
    const property = auraSentence.match(/屬性傷害增加(\{VALUE\d+\}|\d+(?:\.\d+)?)%/);
    const critRate = auraSentence.match(/致命率增加(\{VALUE\d+\}|\d+(?:\.\d+)?)%/);
    const critDamage = auraSentence.match(/致命傷害增加(\{VALUE\d+\}|\d+(?:\.\d+)?)%/);
    const reduction = auraSentence.match(/(\{VALUE\d+\}|\d+(?:\.\d+)?)%的減傷效果/);
    if (property) modifiers.property_damage_bp = Math.round(scalar(level, property[1]) * 100);
    if (critRate) modifiers.crit_rate_bp = Math.round(scalar(level, critRate[1]) * 100);
    if (critDamage) modifiers.crit_damage_bp = Math.round(scalar(level, critDamage[1]) * 100);
    if (reduction) modifiers.damage_reduction_bp = Math.round(scalar(level, reduction[1]) * 100);
    if (Object.keys(modifiers).length > 0) {
      const nestedTags = ["AURA_EFFECT", ...(reduction ? ["BARRIER"] : ["STAT_REINFORCEMENT"])];
      const nested = effect(`${costume.costumeId}:AURA_EFFECT`, "BENEFICIAL", "TARGET_SIDE", 1, modifiers, nestedTags).effect;
      operations.push(effect(`${costume.costumeId}:AURA`, "BENEFICIAL", "ACTOR_SIDE", scalar(level, genericAuraDuration[1]), {}, ["AURA"], { aura_allies: nested }));
      customHookCompiled = true;
    } else {
      diagnostics.push(`aura body requires reviewed typed operation: ${auraSentence || joined}`);
    }
  }
  const acceleration = joined.match(/(\{VALUE\d+\}|\d+)回合期間，進入加速狀態.*?攻擊力增加(\{VALUE\d+\}|\d+(?:\.\d+)?)%.*?攻擊力增加疊加數達(\d+)或以上時.*?(\{VALUE\d+\}|\d+)回合期間.*?連鎖傷害增加(\{VALUE\d+\}|\d+(?:\.\d+)?)%/);
  if (acceleration) {
    const stackEffect = effect(`${costume.costumeId}:ACCELERATION_ATK`, "BENEFICIAL", "ACTOR_SIDE", 3, { attack_bp: Math.round(scalar(level, acceleration[2]) * 100) }, ["STAT_REINFORCEMENT", "ACCELERATION_STACK"], { stack_rule: "INDEPENDENT", max_stacks: 60 }).effect;
    const thresholdEffect = effect(`${costume.costumeId}:CHAIN_DAMAGE`, "BENEFICIAL", "ACTOR_SIDE", scalar(level, acceleration[4]), { chain_damage_outgoing_bp: Math.round(scalar(level, acceleration[5]) * 100) }, ["CHAIN_DAMAGE"], { stack_rule: "REPLACE_SAME_SOURCE" }).effect;
    operations.push(effect(`${costume.costumeId}:ACCELERATION`, "BENEFICIAL", "ACTOR_SIDE", scalar(level, acceleration[1]), {}, ["ACCELERATION"], { on_chain_dealt: { stack_effect: stackEffect, threshold: integer(acceleration[3]), threshold_effect: thresholdEffect } }));
    customHookCompiled = true;
  }
  const field = joined.match(/戰場上施加領域效果.*?(\{VALUE\d+\}|\d+)回合期間.*?我軍攻擊力或魔法力.*?提升(\{VALUE\d+\}|\d+(?:\.\d+)?)%.*?敵人套用(\{VALUE\d+\}|\d+(?:\.\d+)?)%的脆弱效果/);
  if (field) {
    const allyField = effect(`${costume.costumeId}:FIELD_ALLY_STAT`, "BENEFICIAL", "TARGET_SIDE", 1, { attack_bp: Math.round(scalar(level, field[2]) * 100), magic_bp: Math.round(scalar(level, field[2]) * 100) }, ["STAT_REINFORCEMENT", "FIELD"]).effect;
    const opponentField = effect(`${costume.costumeId}:FIELD_VULNERABILITY`, "HARMFUL", "TARGET_SIDE", 1, { incoming_damage_bp: Math.round(scalar(level, field[3]) * 100) }, ["VULNERABLE", "FIELD"]).effect;
    operations.push(effect(`${costume.costumeId}:FIELD`, "BENEFICIAL", "ACTOR_SIDE", scalar(level, field[1]), {}, ["FIELD"], { aura_allies: allyField, aura_opponents: opponentField }));
    customHookCompiled = true;
  }
  const allyOnlyField = joined.match(/戰場上施加領域效果.*?(\{VALUE\d+\}|\d+)回合期間，我軍的?(攻擊力|魔法力)增加(\{VALUE\d+\}|\d+(?:\.\d+)?)%/);
  if (allyOnlyField && !field) {
    const fieldModifiers = allyOnlyField[2] === "攻擊力"
      ? { attack_bp: Math.round(scalar(level, allyOnlyField[3]) * 100) }
      : { magic_bp: Math.round(scalar(level, allyOnlyField[3]) * 100) };
    const allyField = effect(`${costume.costumeId}:FIELD_ALLY_STAT`, "BENEFICIAL", "TARGET_SIDE", 1, fieldModifiers, ["STAT_REINFORCEMENT", "FIELD"]).effect;
    operations.push(effect(`${costume.costumeId}:FIELD`, "BENEFICIAL", "ACTOR_SIDE", scalar(level, allyOnlyField[1]), {}, ["FIELD"], { aura_allies: allyField }));
    customHookCompiled = true;
  }

  const mark = joined.match(/(\{VALUE\d+\}|\d+)回合期間，?對敵人套用標記效果/);
  if (mark) {
    operations.push(effect(`${costume.costumeId}:MARK`, "HARMFUL", "TARGET_SIDE", scalar(level, mark[1]), {}, ["MARK"]));
    customHookCompiled = true;
  }
  const transformation = joined.match(/(\{VALUE\d+\}|\d+)回合期間，.*?變身/);
  if (transformation) {
    operations.push(effect(`${costume.costumeId}:TRANSFORMATION`, "BENEFICIAL", "ACTOR_SIDE", scalar(level, transformation[1]), {}, ["TRANSFORMATION"]));
    customHookCompiled = true;
  }

  let primaryVulnerabilityEffectId = null;
  for (const [sentenceIndex, sentence] of sentences.entries()) {
    if (!/套用.*(?:脆弱|受到的連鎖傷害增加)/.test(sentence) || /每當自身受到攻擊/.test(sentence) || (String(costume.tags).includes("領域") && field)) continue;
    const amountMatch = sentence.match(/(\{VALUE\d+\}|\d+(?:\.\d+)?)%/);
    if (!amountMatch) continue;
    const amount = Math.round(scalar(level, amountMatch[1]) * 100);
    const modifiers = {};
    if (sentence.includes("召喚獸脆弱")) modifiers.summon_incoming_damage_bp = amount;
    else if (sentence.includes("物理脆弱")) modifiers.physical_incoming_damage_bp = amount;
    else if (sentence.includes("魔法脆弱")) modifiers.magical_incoming_damage_bp = amount;
    else if (sentence.includes("火屬性脆弱")) modifiers.fire_incoming_damage_bp = amount;
    else if (sentence.includes("水屬性脆弱")) modifiers.water_incoming_damage_bp = amount;
    else if (sentence.includes("風屬性脆弱")) modifiers.wind_incoming_damage_bp = amount;
    else if (sentence.includes("光屬性脆弱")) modifiers.light_incoming_damage_bp = amount;
    else if (sentence.includes("闇屬性脆弱") || sentence.includes("暗屬性脆弱")) modifiers.dark_incoming_damage_bp = amount;
    else if (sentence.includes("持續傷害脆弱")) modifiers.dot_incoming_damage_bp = amount;
    else if (sentence.includes("連鎖傷害")) modifiers.chain_damage_incoming_bp = amount;
    else modifiers.incoming_damage_bp = amount;
    const isBaseSkillSentence = sentenceIndex < (costume.skill ?? []).length;
    let vulnerabilityEffectId;
    if (/變為/.test(sentence) && primaryVulnerabilityEffectId) {
      vulnerabilityEffectId = primaryVulnerabilityEffectId;
    } else if (isBaseSkillSentence && primaryVulnerabilityEffectId === null) {
      vulnerabilityEffectId = `${costume.costumeId}:VULNERABILITY`;
      primaryVulnerabilityEffectId = vulnerabilityEffectId;
    } else {
      vulnerabilityEffectId = `${costume.costumeId}:VULNERABILITY:${sentenceIndex}`;
    }
    const vulnerability = effect(vulnerabilityEffectId, "HARMFUL", "TARGET_SIDE", durationFrom(sentence, level, 4), modifiers, ["VULNERABLE"]);
    let resolvedVulnerability = vulnerability;
    if (/若敵人處於挑釁或集中攻擊/.test(sentence)) {
      resolvedVulnerability = { op: "CONDITIONAL", condition: { type: "ANY", conditions: [{ type: "TARGET_HAS_TAG", tag: "TAUNT" }, { type: "TARGET_HAS_TAG", tag: "FOCUS" }] }, operations: [vulnerability] };
      conditionalEffectCompiled = true;
    } else if (/若敵人為主要目標/.test(sentence)) {
      resolvedVulnerability = { op: "CONDITIONAL", condition: { type: "IS_MAIN_TARGET" }, operations: [vulnerability] };
      conditionalEffectCompiled = true;
    } else if (/主要目標/.test(sentence)) {
      resolvedVulnerability = { op: "CONDITIONAL", condition: { type: "IS_MAIN_TARGET" }, operations: [vulnerability] };
      conditionalEffectCompiled = true;
    } else {
      const chainCondition = sentence.match(/若此攻擊.*?連鎖數是(\d+)或以上/);
      if (chainCondition) {
        resolvedVulnerability = { op: "CONDITIONAL", condition: { type: "TARGET_CHAIN_AT_LEAST", value: integer(chainCondition[1]) }, operations: [vulnerability] };
        conditionalEffectCompiled = true;
      }
    }
    const isPreHit = /\[前置效果\]/.test(sentence) || (firstDamageSentenceIndex >= 0 && sentenceIndex < firstDamageSentenceIndex);
    (isPreHit ? operations : postDamageOperations).push(resolvedVulnerability);
  }

  const chargedGuard = joined.match(/對自身套用相當於(?:自身)?(最大生命力|攻擊力|魔法力)(\{VALUE\d+\}|\d+(?:\.\d+)?)%的能量防衛效果.*?受到(\{VALUE\d+\}|\d+)次攻擊後消失/);
  if (chargedGuard) {
    operations.push(effect(`${costume.costumeId}:ENERGY_GUARD`, "BENEFICIAL", "ACTOR_SIDE", 1, {}, ["ENERGY_GUARD", "RECEIVED_HIT_CHARGE"], {
      duration_clock: "PERMANENT",
      charges: integer(scalar(level, chargedGuard[3])),
      barrier: { coefficient_bp: Math.round(scalar(level, chargedGuard[2]) * 100), reference: statReference(chargedGuard[1]) },
    }));
  }

  for (const [sentenceIndex, sentence] of sentences.entries()) {
    const guard = sentence.match(/(\{VALUE\d+\}|\d+)回合期間.*?(下一(?:個|位)攻擊順序的我軍|自身|我軍).*?(?:相當於)?(?:各自)?(?:自身)?(最大生命力|攻擊力|魔法力)(\{VALUE\d+\}|\d+(?:\.\d+)?)%的能量防衛/)
      ?? sentence.match(/(\{VALUE\d+\}|\d+)回合期間.*?(?:相當於)?(?:自身)?(最大生命力|攻擊力|魔法力)(\{VALUE\d+\}|\d+(?:\.\d+)?)%的能量防衛/);
    if (guard) {
      const hasExplicitRecipient = guard.length === 5;
      const recipientLabel = hasExplicitRecipient ? guard[2] : "自身";
      const referenceLabel = hasExplicitRecipient ? guard[3] : guard[2];
      const coefficient = hasExplicitRecipient ? guard[4] : guard[3];
      const recipient = recipientLabel === "自身" ? "ACTOR_SIDE" : recipientLabel.includes("下一") ? "TARGET_SIDE" : "ACTOR_TEAM";
      const allyOwnStat = recipient === "ACTOR_TEAM" && /各自/.test(sentence);
      const reference = allyOwnStat && referenceLabel === "最大生命力" ? "TARGET_MAX_HP"
        : allyOwnStat && referenceLabel === "目前生命力" ? "TARGET_CURRENT_HP"
          : statReference(referenceLabel);
      const guardOperation = effect(`${costume.costumeId}:ENERGY_GUARD`, "BENEFICIAL", recipient, scalar(level, guard[1]), {}, ["ENERGY_GUARD"], { barrier: { coefficient_bp: Math.round(scalar(level, coefficient) * 100), reference } });
      const isPreHit = /\[前置效果\]/.test(sentence) || (firstDamageSentenceIndex >= 0 && sentenceIndex < firstDamageSentenceIndex);
      (firstDamageSentenceIndex < 0 || isPreHit ? operations : postDamageOperations).push(guardOperation);
    }
    const reduction = sentence.match(/(\{VALUE\d+\}|\d+)回合期間.*?(自身|我軍).*?(\{VALUE\d+\}|\d+(?:\.\d+)?)%的(物理|魔法)?(?:減傷|防護罩)效果/);
    if (reduction) {
      const amount = Math.round(scalar(level, reduction[3]) * 100);
      const modifiers = reduction[4] === "物理" ? { physical_damage_reduction_bp: amount } : reduction[4] === "魔法" ? { magical_damage_reduction_bp: amount } : { damage_reduction_bp: amount };
      operations.push(effect(`${costume.costumeId}:BARRIER`, "BENEFICIAL", reduction[2] === "自身" ? "ACTOR_SIDE" : "ACTOR_TEAM", scalar(level, reduction[1]), modifiers, ["BARRIER"]));
    }
    const implicitSelfReduction = sentence.match(/(\{VALUE\d+\}|\d+)回合期間.*?(?:受到的傷害減少|減傷)(\{VALUE\d+\}|\d+(?:\.\d+)?)%/);
    if (implicitSelfReduction && !reduction) {
      operations.push(effect(`${costume.costumeId}:BARRIER`, "BENEFICIAL", "ACTOR_SIDE", scalar(level, implicitSelfReduction[1]), { damage_reduction_bp: Math.round(scalar(level, implicitSelfReduction[2]) * 100) }, ["BARRIER"]));
    }
    const selfShield = sentence.match(/(\{VALUE\d+\}|\d+)回合期間.*?生成自己(最大生命力?|攻擊力|魔法力)(\{VALUE\d+\}|\d+(?:\.\d+)?)%的護盾/);
    if (selfShield) {
      operations.push(effect(`${costume.costumeId}:ENERGY_GUARD`, "BENEFICIAL", "ACTOR_SIDE", scalar(level, selfShield[1]), {}, ["ENERGY_GUARD"], { barrier: { coefficient_bp: Math.round(scalar(level, selfShield[3]) * 100), reference: statReference(selfShield[2]) } }));
    }
  }

  for (const sentence of sentences) {
    if (/每回合結束時/.test(sentence)) continue;
    const heal = sentence.match(/恢復(自身|我軍).*?(?:自身|各自)?(最大生命力|目前生命力|攻擊力|魔法力)(\{VALUE\d+\}|\d+(?:\.\d+)?)%/);
    if (heal) {
      const allyOwnStat = heal[1] === "我軍" && /各自/.test(sentence);
      const reference = allyOwnStat && heal[2] === "最大生命力" ? "TARGET_MAX_HP"
        : allyOwnStat && heal[2] === "目前生命力" ? "TARGET_CURRENT_HP"
          : statReference(heal[2]);
      operations.push({ op: "HEAL", coefficient_bp: Math.round(scalar(level, heal[3]) * 100), reference, can_crit: false, recipient: heal[1] === "自身" ? "ACTOR_SIDE" : "ACTOR_TEAM" });
    }
  }

  // Effects explicitly labelled 前置效果 must be present before the first hit.
  const chainWeaken = joined.match(/(\{VALUE\d+\}|\d+)回合期間，?對敵人套用(\{VALUE\d+\}|\d+)連鎖弱化效果/);
  if (chainWeaken) operations.push(effect(`${costume.costumeId}:CHAIN_WEAKEN`, "HARMFUL", "TARGET_SIDE", scalar(level, chainWeaken[1]), { chain_received_delta: -integer(scalar(level, chainWeaken[2])) }, ["CHAIN_WEAKEN"]));

  let conditionalDamageCompiled = false;
  let scalingDamageCompiled = false;
  const parsedDamage = sentences.map((sentence) => ({ sentence, damage: directDamage(sentence, character, costume, level) })).filter((entry) => entry.damage);
  if (parsedDamage.length > 0) {
    const baseEntry = parsedDamage.find(({ sentence }) => !/若|此時/.test(sentence)) ?? parsedDamage[0];
    let scaling = null;
    let scalingMatch = joined.match(/每命中一個目標，?傷害量(?:額外)?增加\s*(\{VALUE\d+\}|\d+(?:\.\d+)?)%/);
    if (scalingMatch) scaling = { source: { type: "TARGET_COUNT" }, coefficient_bp_per_unit: Math.round(scalar(level, scalingMatch[1]) * 100) };
    scalingMatch = joined.match(/每攻擊一個目標，?傷害量將減少\s*(\{VALUE\d+\}|\d+(?:\.\d+)?)%/);
    if (scalingMatch) scaling = { source: { type: "TARGET_COUNT_MINUS_ONE" }, coefficient_bp_per_unit: -Math.round(scalar(level, scalingMatch[1]) * 100) };
    scalingMatch = joined.match(/自身持有的有益效果數量，每增加1個時，?額外增加相當於攻擊力(\{VALUE\d+\}|\d+(?:\.\d+)?)%/);
    if (scalingMatch) scaling = { source: { type: "ACTOR_EFFECT_COUNT", polarity: "BENEFICIAL" }, coefficient_bp_per_unit: Math.round(scalar(level, scalingMatch[1]) * 100) };
    scalingMatch = joined.match(/敵人持有的有害效果數量，每個效果會使傷害量額外提高相當於攻擊力的(\{VALUE\d+\}|\d+(?:\.\d+)?)%/);
    if (scalingMatch) scaling = { source: { type: "TARGET_EFFECT_COUNT", polarity: "HARMFUL" }, coefficient_bp_per_unit: Math.round(scalar(level, scalingMatch[1]) * 100) };
    scalingMatch = joined.match(/每1層出血額外造成相當於自身魔法力(\{VALUE\d+\}|\d+(?:\.\d+)?)%/);
    if (scalingMatch) scaling = { source: { type: "TARGET_TAG_STACKS", tag: "BLEED" }, coefficient_bp_per_unit: Math.round(scalar(level, scalingMatch[1]) * 100) };
    scalingMatch = joined.match(/每(額外)?消耗SP1點，?傷害量(?:將)?增加(\{VALUE\d+\}|\d+(?:\.\d+)?)%/);
    if (scalingMatch) scaling = { source: { type: scalingMatch[1] ? "EXTRA_SP_CONSUMED" : "SKILL_SP_COST" }, coefficient_bp_per_unit: Math.round(scalar(level, scalingMatch[2]) * 100) };
    const bleedScalingCondition = /若敵人處於出血狀態/.test(joined) && scaling?.source?.type === "TARGET_TAG_STACKS";
    if (scaling) scalingDamageCompiled = true;
    const alternateEntry = parsedDamage.find(({ sentence }) => /若|此時/.test(sentence) && conditionalDamageRule(sentence, level, baseEntry.damage.hits));
    if (bleedScalingCondition) {
      operations.push({ op: "CONDITIONAL", condition: { type: "TARGET_HAS_TAG", tag: "BLEED" }, operations: [{ ...baseEntry.damage, scaling }] });
      operations.push({ op: "CONDITIONAL", condition: { type: "TARGET_LACKS_TAG", tag: "BLEED" }, operations: [{ ...baseEntry.damage, scaling: null }] });
      conditionalDamageCompiled = true;
    } else if (alternateEntry) {
      const rule = conditionalDamageRule(alternateEntry.sentence, level, baseEntry.damage.hits);
      if (scaling) alternateEntry.damage.scaling = scaling;
      if (scaling) baseEntry.damage.scaling = scaling;
      operations.push({ op: "CONDITIONAL", condition: rule.when, operations: [alternateEntry.damage] });
      operations.push({ op: "CONDITIONAL", condition: rule.otherwise, operations: [baseEntry.damage] });
      conditionalDamageCompiled = true;
    } else {
      if (scaling) baseEntry.damage.scaling = scaling;
      operations.push(baseEntry.damage);
    }
    if (!bleedScalingCondition) for (const extraEntry of parsedDamage.filter((entry) => entry !== baseEntry && entry !== alternateEntry && /額外造成/.test(entry.sentence))) operations.push(extraEntry.damage);
  }
  operations.push(...postDamageOperations);
  postDamageFlushed = true;
  if (/解除對敵人套用的出血效果/.test(joined)) operations.push({ op: "REMOVE_EFFECTS_BY_TAG", tag: "BLEED" });
  if (/解除對敵人套用的脆弱效果/.test(joined)) operations.push({ op: "REMOVE_EFFECTS_BY_TAG", tag: "VULNERABLE" });

  for (const sentence of sentences) {
    const dot = sentence.match(/(\{VALUE\d+\}|\d+)回合期間.*?套用.*?相當於((?:自身|敵人)?(?:攻擊力|魔法力|最大生命力))(\{VALUE\d+\}|\d+(?:\.\d+)?)%[的]?(?:物理|魔法)傷害(?:的)?(中毒|出血|燒傷|腐敗|凍傷|惡夢)/);
    if (!dot) continue;
    const status = ({ 中毒: "POISON", 出血: "BLEED", 燒傷: "BURN", 腐敗: "CORRUPTION", 凍傷: "FROSTBITE", 惡夢: "NIGHTMARE" })[dot[4]];
    const maxStacks = integer(scalar(level, joined.match(/最多可(?:賦予)?疊加至(\{VALUE\d+\}|\d+)(?:層)?/)?.[1] ?? 1));
    const stacks = /每層疊加/.test(sentence) ? Math.max(1, integer(level.HIT1 ?? costume.chain ?? 1)) : 1;
    operations.push(effect(`${costume.costumeId}:${status}`, "HARMFUL", "TARGET_SIDE", scalar(level, dot[1]), {}, ["DOT", status], {
      periodic: { kind: "DOT", coefficient_bp: Math.round(scalar(level, dot[3]) * 100), reference: statReference(dot[2]), stacks },
      stack_rule: maxStacks > 1 ? "ACCUMULATE" : "REPLACE_SAME_SOURCE",
      max_stacks: maxStacks,
    }));
  }

  for (const sentence of sentences) {
    const allySpPrefix = sentence.match(/(?:我軍的SP(?:恢復|增加)|我軍增加|恢復SP)\s*(\{VALUE\d+\}|\d+)\s*(?:點?SP|點)?/);
    const allySpSuffix = sentence.match(/恢復\s*(\{VALUE\d+\}|\d+)\s*點SP/);
    const allySpValue = allySpPrefix?.[1] ?? allySpSuffix?.[1];
    const enemySp = sentence.match(/敵人的SP減少(\{VALUE\d+\}|\d+)點/);
    const ownLoss = sentence.match(/我軍的SP減少(\{VALUE\d+\}|\d+)點/);
    const perHit = sentence.includes("每次攻擊命中");
    if (/受到攻擊時|每回合結束時/.test(sentence)) continue;
    if (allySpValue) operations.push(perHit ? { op: "CHANGE_SP_PER_SUCCESSFUL_HIT", amount: integer(scalar(level, allySpValue)), side: "ACTOR_SIDE" } : { op: "CHANGE_SP", amount: integer(scalar(level, allySpValue)), side: "ACTOR_SIDE" });
    if (enemySp) operations.push(perHit ? { op: "CHANGE_SP_PER_SUCCESSFUL_HIT", amount: -integer(scalar(level, enemySp[1])), side: "TARGET_SIDE" } : { op: "CHANGE_SP", amount: -integer(scalar(level, enemySp[1])), side: "TARGET_SIDE" });
    if (ownLoss) operations.push({ op: "CHANGE_SP", amount: -integer(scalar(level, ownLoss[1])), side: "ACTOR_SIDE" });
  }

  const beneficialRemovalIndex = sentences.findIndex((sentence) => /解除套用於敵人的有益效果/.test(sentence));
  if (beneficialRemovalIndex >= 0) queueAtSourcePosition({ op: "REMOVE_EFFECTS", polarity: "BENEFICIAL", count: 65535 }, beneficialRemovalIndex);
  const reinforcementRemovalIndex = sentences.findIndex((sentence) => /解除套用於敵人的能力值強化效果/.test(sentence));
  if (reinforcementRemovalIndex >= 0) queueAtSourcePosition({ op: "REMOVE_EFFECTS_BY_TAG", tag: "STAT_REINFORCEMENT" }, reinforcementRemovalIndex);
  const guardRemovalIndex = sentences.findIndex((sentence) => /解除套用於敵人的減傷和能量防衛效果/.test(sentence));
  if (guardRemovalIndex >= 0) {
    queueAtSourcePosition({ op: "REMOVE_EFFECTS_BY_TAG", tag: "BARRIER" }, guardRemovalIndex);
    queueAtSourcePosition({ op: "REMOVE_EFFECTS_BY_TAG", tag: "ENERGY_GUARD" }, guardRemovalIndex);
  }
  if (/\[前置效果\].*解除敵方主要目標套用的防護罩、能量防衛/.test(joined)) {
    operations.unshift({ op: "REMOVE_EFFECTS_BY_TAG", tag: "ENERGY_GUARD" });
    operations.unshift({ op: "REMOVE_EFFECTS_BY_TAG", tag: "BARRIER" });
  }
  const silence = joined.match(/(\{VALUE\d+\}|\d+)回合期間，?對敵人套用沉默效果/);
  if (silence) operations.push(effect(`${costume.costumeId}:SILENCE`, "HARMFUL", "TARGET_SIDE", scalar(level, silence[1]), {}, ["SILENCE"]));
  const taunt = joined.match(/(\{VALUE\d+\}|\d+)回合(?:期間，?對自身套用)?挑釁(?:效果)?/);
  if (taunt) operations.push(effect(`${costume.costumeId}:TAUNT`, "BENEFICIAL", "ACTOR_SIDE", scalar(level, taunt[1]), {}, ["TAUNT"]));
  const focus = joined.match(/(\{VALUE\d+\}|\d+)回合期間，?對(?:主要目標的)?敵人套用集中攻擊效果/);
  if (focus) operations.push(effect(`${costume.costumeId}:FOCUS`, "HARMFUL", "TARGET_SIDE", scalar(level, focus[1]), {}, ["FOCUS"]));
  const chainEnhance = joined.match(/(\{VALUE\d+\}|\d+)回合期間，?.*?套用\s*(\{VALUE\d+\}|\d+)\s*(?:層)?連鎖強化效果/);
  if (chainEnhance) operations.push(effect(`${costume.costumeId}:CHAIN_PLUS`, "BENEFICIAL", /自身/.test(chainEnhance[0]) ? "ACTOR_SIDE" : /我軍/.test(chainEnhance[0]) ? "ACTOR_TEAM" : "TARGET_SIDE", scalar(level, chainEnhance[1]), { chain_dealt_delta: integer(scalar(level, chainEnhance[2])) }, ["CHAIN_ENHANCE"]));
  const chainRetention = joined.match(/(\{VALUE\d+\}|\d+)回合期間，?對敵人套用(\{VALUE\d+\}|\d+)的維持連鎖效果/);
  if (chainRetention) operations.push(effect(`${costume.costumeId}:CHAIN_RETENTION`, "HARMFUL", "TARGET_SIDE", scalar(level, chainRetention[1]), { chain_retention: integer(scalar(level, chainRetention[2])) }, ["CHAIN_RETENTION"]));
  const spCost = joined.match(/(\{VALUE\d+\}|\d+)回合期間，?.*?SP消耗(增加|減少)(\{VALUE\d+\}|\d+)/);
  if (spCost) operations.push(effect(`${costume.costumeId}:SP_COST`, spCost[2] === "增加" ? "HARMFUL" : "BENEFICIAL", /自身/.test(spCost[0]) ? "ACTOR_SIDE" : /我軍/.test(spCost[0]) ? "ACTOR_TEAM" : "TARGET_SIDE", scalar(level, spCost[1]), { sp_cost_delta: (spCost[2] === "增加" ? 1 : -1) * integer(scalar(level, spCost[3])) }, ["SP_COST"]));
  const evadeTarget = joined.match(/(\{VALUE\d+\}|\d+)回合期間，?對自身套用迴避目標效果/);
  if (evadeTarget) operations.push(effect(`${costume.costumeId}:EVADE_TARGET`, "BENEFICIAL", "ACTOR_SIDE", scalar(level, evadeTarget[1]), {}, ["EVADE_TARGET"]));
  const conditionalExtendBuff = joined.match(/持有的有益效果數量為(\d+)個以上時，所有有益效果的持續回合數將延長(\{VALUE\d+\}|\d+)回合/);
  if (conditionalExtendBuff) operations.push({
    op: "CONDITIONAL",
    condition: { type: "ACTOR_EFFECT_COUNT_AT_LEAST", polarity: "BENEFICIAL", value: integer(conditionalExtendBuff[1]) },
    operations: [{ op: "EXTEND_EFFECTS", polarity: "BENEFICIAL", duration: integer(scalar(level, conditionalExtendBuff[2])), recipient: "ACTOR_SIDE" }],
  });
  const extendBuff = joined.match(/所有增益效果持續回合數將延長(\{VALUE\d+\}|\d+)回合/);
  if (extendBuff) operations.push({ op: "EXTEND_EFFECTS", polarity: "BENEFICIAL", duration: integer(scalar(level, extendBuff[1])), recipient: "ACTOR_SIDE" });
  const extendDebuff = joined.match(/所有有害效果持續回合數延長(\{VALUE\d+\}|\d+)回合/);
  if (extendDebuff) operations.push({ op: "EXTEND_EFFECTS", polarity: "HARMFUL", duration: integer(scalar(level, extendDebuff[1])), recipient: "TARGET_SIDE" });
  const cooldownReduction = joined.match(/(?:所有正在冷卻中的服裝冷卻時間|技能的冷卻時間)\s*減少\s*(\{VALUE\d+\}|\d+)\s*(?:回合|次|。)/);
  if (cooldownReduction) {
    const nextAlly = (costume.skill ?? []).join(" ").includes("下一個攻擊順序");
    operations.push({ op: "CHANGE_COOLDOWN", amount: -integer(scalar(level, cooldownReduction[1])), recipient: nextAlly ? "TARGET_SIDE" : /自身/.test(cooldownReduction[0]) ? "ACTOR_SIDE" : /我軍/.test(cooldownReduction[0]) ? "ACTOR_TEAM" : "TARGET_SIDE" });
  }
  const harmfulRemovalIndex = sentences.findIndex((sentence) => /解除減益/.test(sentence));
  if (harmfulRemovalIndex >= 0) queueAtSourcePosition({ op: "REMOVE_EFFECTS", polarity: "HARMFUL", count: 65535 }, harmfulRemovalIndex);

  const counterDuration = joined.match(/(\{VALUE\d+\}|\d+)回合期間，?自身受到攻擊時將反擊/);
  const counterCharges = joined.match(/此效果將在受到(\{VALUE\d+\}|\d+)次攻擊後消失/);
  const counterDamage = joined.match(/每次反擊時，?對(全體敵人|敵人)造成相當於自身(攻擊力|最大生命力|魔法力)(\{VALUE\d+\}|\d+(?:\.\d+)?)%的(物理|魔法)傷害/);
  const receivedCounter = joined.match(/每次反擊時，?對敵人造成受到的傷害(\{VALUE\d+\}|\d+(?:\.\d+)?)%的物理傷害/);
  if (counterDamage || receivedCounter) {
    const resolvedCounter = counterDamage ? { target: counterDamage[1], reference: statReference(counterDamage[2]), coefficient: scalar(level, counterDamage[3]), kind: counterDamage[4] === "魔法" ? "MAGICAL" : "PHYSICAL" } : { target: "敵人", reference: "RECEIVED_DAMAGE", coefficient: scalar(level, receivedCounter[1]), kind: "PHYSICAL" };
    operations.push(effect(`${costume.costumeId}:COUNTER`, "BENEFICIAL", "ACTOR_SIDE", counterDuration ? scalar(level, counterDuration[1]) : 1, {}, ["COUNTER"], {
      duration_clock: counterDuration ? "GAME_TURN" : "PERMANENT",
      charges: counterCharges ? integer(scalar(level, counterCharges[1])) : null,
      counter: { kind: resolvedCounter.kind, coefficient_bp: Math.round(resolvedCounter.coefficient * 100), reference: resolvedCounter.reference, target_all: resolvedCounter.target === "全體敵人" },
    }));
  }
  const revive = joined.match(/(\{VALUE\d+\}|\d+)回合期間，?對自身套用復活效果.*?以(\{VALUE\d+\}|\d+(?:\.\d+)?)%的生命力復活/);
  if (revive) operations.push(effect(`${costume.costumeId}:REVIVE`, "BENEFICIAL", "ACTOR_SIDE", scalar(level, revive[1]), {}, ["REVIVE"], { revive_hp_bp: Math.round(scalar(level, revive[2]) * 100) }));
  const knockback = joined.match(/目標向後擊退(\d+)格/);
  const knockbackMetadata = costume.knockback;
  if (knockback || knockbackMetadata) {
    const collision = joined.match(/對被撞擊的敵人造成被推開目標最大生命力(\{VALUE\d+\}|\d+(?:\.\d+)?)%的物理傷害/);
    operations.push({
      op: "KNOCKBACK",
      direction: knockbackDirection(knockbackMetadata?.postion ?? "後"),
      distance: integer(knockbackMetadata?.cells ?? knockback?.[1]),
      collision_coefficient_bp: collision ? Math.round(scalar(level, collision[1]) * 100) : 2_500,
    });
  }
  const summonNames = { "崇拜假面": "PersonaOfWorship", "誹謗假面": "PersonaOfSlander", "兔女郎之魂": "BunnySpectre", "魔法增幅器ET001": "MagicAmplifierET001" };
  for (const [name, summonId] of Object.entries(summonNames)) {
    const summoned = joined.match(new RegExp(`生成${name}\\s*(\\d+)\\s*個`));
    if (summoned) operations.push({ op: "SUMMON", character_id: `summon:${summonId}`, costume_id: `summon:${summonId}:skill`, count: integer(summoned[1]), enhancement, inherit_summoner_stats: true });
  }

  for (const extra of additionalExtras) {
    if (extra.type === "Plus" && !/(恢復SP|增加\d+SP|恢復.*點SP|連鎖強化|連鎖弱化|能量防衛|護盾|防護罩|減傷|受到的傷害減少|挑釁|脆弱|(?:防禦力|魔法抵抗)減少|解除.*(?:防護罩|能量防衛)|致命傷害增加|屬性傷害增加|魔法力增加|受到的連鎖傷害增加)/.test(extra.value ?? "")) diagnostics.push(`additional effect requires reviewed typed operation: ${extra.value ?? "Plus"}`);
  }

  const semanticTags = String(costume.tags ?? "").split(",").filter(Boolean);
  const supportedTags = new Set([
    "物理傷害", "魔法傷害", "固定傷害", "純粹傷害", "攻擊力增益", "魔法力增益", "致命率增益", "致命傷害增益", "屬性傷害增益",
    "降物/魔防", "降物/魔攻", "脆弱", "持續傷害脆弱", "回復生命", "增加SP", "失去SP", "解除增益", "沉默", "技能擊退",
    "持續傷害", "中毒", "流血", "燒傷", "腐敗", "凍傷", "惡夢", "能量防衛", "防護罩", "輔助",
    "迴避", "百分比傷害", "生命傷害", "挑釁", "集中", "連鎖強化", "連鎖弱化", "維持連鎖", "連鎖傷害增益", "普攻傷害增強", "SP消耗增加", "SP消耗減少", "增強效果",
    "反擊", "復活", "增益延長", "減益延長", "冷卻減少", "迴避目標", "解除減益", "召喚", "召喚物脆弱",
    "先發制人", "疊加", "變身", "光環", "領域", "加速", "標記",
    "限定服裝", "本家限定", "聯動限定", "免費服裝",
  ]);
  for (const tag of semanticTags) {
    if (tag === "條件增傷" && (conditionalDamageCompiled || conditionalEffectCompiled || scalingDamageCompiled)) continue;
    if (tag === "總量" && scalingDamageCompiled) continue;
    if (tag === "能量防衛傷害" && parsedDamage.some((entry) => /能量防衛/.test(entry.sentence))) continue;
    if (tag === "暴走" && scalingDamageCompiled) continue;
    if ((tag === "共鳴" || tag === "加速") && customHookCompiled) continue;
    if (!supportedTags.has(tag)) diagnostics.push(`uncompiled effect tag: ${tag}`);
  }
  if (operations.length === 0) diagnostics.push("no lossless executable operation was derived");
  return { operations, diagnostics: [...new Set(diagnostics)] };
}

function level100Stats(character) {
  const base = character.maxlevel ?? {};
  return {
    max_hp: integer(base.hp),
    attack: attackType(character.atkType) === "PHYSICAL" ? integer(base.atk) : 0,
    magic: attackType(character.atkType) === "MAGICAL" ? integer(base.atk) : 0,
    crit_rate_bp: percent(base.cr),
    crit_damage_bp: percent(base.cdmg),
    defense_bp: percent(base.def),
    magic_resist_bp: percent(base.mr),
    // BD2DB's current base-value function initializes ADMG to 50 for every
    // character; awakening and external ADMG are additive on top.
    property_damage_bp: 5_000,
    outgoing_damage_bp: 0,
    incoming_damage_bp: 0,
    amplification_bp: 0,
  };
}

function statModifiers(entries) {
  const modifiers = {};
  const add = (key, value) => { modifiers[key] = (modifiers[key] ?? 0) + value; };
  for (const entry of entries ?? []) {
    switch (entry.key) {
      case "HP": add("max_hp_flat", integer(entry.value)); break;
      case "HP%": add("max_hp_bp", percent(entry.value)); break;
      case "ATK": add("attack_flat", integer(entry.value)); break;
      case "ATK%": add("attack_bp", percent(entry.value)); break;
      case "MATK": add("magic_flat", integer(entry.value)); break;
      case "MATK%": add("magic_bp", percent(entry.value)); break;
      case "DEF": add("defense_bp", percent(entry.value)); break;
      case "MDEF":
      case "MR": add("magic_resist_bp", percent(entry.value)); break;
      case "CR": add("crit_rate_bp", percent(entry.value)); break;
      case "CDMG": add("crit_damage_bp", percent(entry.value)); break;
      case "ADMG": add("property_damage_bp", percent(entry.value)); break;
      default: throw new Error(`unsupported permanent stat key: ${entry.key}`);
    }
  }
  return modifiers;
}

function resolvedJapaneseDescription(localized, level, burstLevel, potentialMask) {
  const substitute = (line) => String(line).replace(/\{([A-Z][A-Z0-9_]*)\}/g, (token, key) => {
    if (level[key] === undefined || level[key] === null) return token;
    const numeric = Number(level[key]);
    return Number.isFinite(numeric) ? String(numeric) : String(level[key]);
  });
  const lines = [...(localized.skill_ja ?? [])];
  for (const stage of localized.burst_ja ?? []) {
    if (integer(stage.level) <= burstLevel && stage.type === "Plus" && stage.value) {
      lines.push(String(stage.value).replace(/^\s*\[追加能力\]\s*/, ""));
    }
  }
  for (const [index, potential] of (localized.skillPotential_ja ?? []).entries()) {
    if ((potentialMask & (1 << index)) !== 0 && potential.type === "Plus" && potential.value) {
      lines.push(potential.value);
    }
  }
  return lines.map(substitute).filter(Boolean).join("\n");
}

function transformCharacters(rawCharacters, costumeI18n, ranges, source) {
  const characters = {};
  const costumes = {};
  for (const raw of rawCharacters.filter((character) => String(character.star) === "5")) {
    const costumeIds = (raw.costumes ?? []).map((costume) => costume.costumeId);
    characters[raw.characterId] = {
      id: raw.characterId,
      names: { en: raw.enName ?? raw.characterId, "zh-TW": raw.character ?? raw.characterId },
      rarity: 5,
      element: element(raw.attribute),
      attack_type: attackType(raw.atkType),
      target_selector: selector(raw.atkPosition),
      knockback_direction: knockbackDirection(raw.knockback),
      level_100: level100Stats(raw),
      engraving_modifiers: statModifiers(raw.evgraving),
      awakening_modifiers: statModifiers(raw.awakening),
      costume_ids: costumeIds,
      source: { ...source, raw_payload: raw },
    };
    for (const costume of raw.costumes ?? []) {
      const localized = costumeI18n[costume.costumeId] ?? {};
      const variants = [];
      const allDiagnostics = [];
      for (const [enhancement, level] of (costume.level ?? []).entries()) {
        const burstStages = costume.burst ?? [];
        for (let burstLevel = 0; burstLevel <= burstStages.length; burstLevel += 1) {
          const burstResolvedLevel = { ...level };
          let extraSp = 0;
          let burstRange = rangeCode(costume.range);
          let burstCooldown = integer(level.CD);
          const appliedStages = [];
          for (const stage of burstStages.filter((stage) => stage.level <= burstLevel)) {
            appliedStages.push(stage);
            extraSp += integer(stage.spCost);
            applyScalarSwitches(
              burstResolvedLevel,
              [...(stage.switches ?? []), ...(stage.extraEffects ?? []).flatMap((extra) => extra.switches ?? [])],
              `${costume.costumeId} burst ${stage.level}`,
            );
            for (const extra of stage.extraEffects ?? []) {
              if (extra.type === "Range" && extra.value) burstRange = rangeCode(extra.value);
              if (extra.type === "Cooldown") {
                const switchReductions = (extra.switches ?? [])
                  .filter((item) => item.target === "CD")
                  .map((item) => integer(item.value, `${costume.costumeId} burst cooldown switch`));
                const reduction = switchReductions.length > 0
                  ? switchReductions.reduce((sum, value) => sum + value, 0)
                  : integer(extra.value, `${costume.costumeId} burst cooldown`);
                burstCooldown = Math.max(
                  0,
                  burstCooldown - reduction,
                );
              }
            }
            if (stage.type === "Cooldown") {
              const reduction = String(stage.value ?? "").match(/減少\s*(\d+)/);
              if (reduction) burstCooldown = Math.max(0, burstCooldown - integer(reduction[1]));
            }
          }
          for (let potentialMask = 0; potentialMask < 8; potentialMask += 1) {
            const resolvedLevel = { ...burstResolvedLevel };
            let resolvedRange = burstRange;
            let cooldown = burstCooldown;
            let potentialSpDelta = 0;
            const selectedPotentialExtras = [];
            for (const [potentialIndex, potential] of (costume.skillPotential ?? []).entries()) {
              if ((potentialMask & (1 << potentialIndex)) === 0) continue;
              applyScalarSwitches(
                resolvedLevel,
                potential.switches ?? [],
                `${costume.costumeId} potential ${potentialIndex}`,
              );
              if (potential.type === "Range") resolvedRange = rangeCode(potential.value);
              if (potential.type === "Rhombus") potentialSpDelta -= integer(String(potential.value ?? "").match(/減少\s*(\d+)/)?.[1]);
              if (potential.type === "Cooldown") cooldown = Math.max(0, cooldown - integer(String(potential.value ?? "").match(/減少\s*(\d+)/)?.[1]));
              if (potential.type === "Plus") selectedPotentialExtras.push(potential);
            }
            const compiled = compileOperations(raw, costume, resolvedLevel, [...appliedStages, ...selectedPotentialExtras], enhancement);
            const variantDiagnostics = [...new Set(compiled.diagnostics)];
            allDiagnostics.push(...variantDiagnostics.map((message) => `+${enhancement}/B${burstLevel}/P${potentialMask}: ${message}`));
            variants.push({
              enhancement,
              burst_level: burstLevel,
              potential_mask: potentialMask,
              sp_cost: Math.max(0, integer(level.SP) + extraSp + potentialSpDelta),
              cooldown,
              selector: (costume.skill ?? []).join(" ").includes("下一個攻擊順序") || (costume.skill ?? []).join(" ").includes("下一位攻擊順序") ? "NEXT_ALLY_IN_ORDER" : selector(costume.target),
              fixed_target_cell: null,
              target_all: resolvedRange === "all",
              range_override: resolvedRange === rangeCode(costume.range) ? null : rangeOffsets(ranges, resolvedRange),
              operations: compiled.operations,
              consume_remaining_sp: String(costume.tags ?? "").split(",").includes("暴走"),
              executable: variantDiagnostics.length === 0 && compiled.operations.length > 0,
              compile_diagnostics: variantDiagnostics,
              preemptive: String(costume.tags ?? "").split(",").includes("先發制人"),
              activation_condition: null,
              max_uses_per_party: null,
              ai_sequence_index: null,
              description_ja: resolvedJapaneseDescription(localized, resolvedLevel, burstLevel, potentialMask),
            });
          }
        }
      }
      const code = rangeCode(costume.range);
      const diagnostics = [...new Set(allDiagnostics)];
      costumes[costume.costumeId] = {
        id: costume.costumeId,
        character_id: raw.characterId,
        names: {
          "zh-TW": costume.costumeName ?? costume.costumeId,
          "zh-CN": localized.costumeName_CN ?? costume.costumeName,
          en: localized.costumeName_en,
          ja: localized.costumeName_ja,
          ko: localized.costumeName_ko,
        },
        skill_names: {
          "zh-TW": costume.skillName ?? costume.costumeId,
          "zh-CN": localized.skillName_CN ?? costume.skillName,
          en: localized.skillName_en,
          ja: localized.skillName_ja,
          ko: localized.skillName_ko,
        },
        range: rangeOffsets(ranges, code),
        variants,
        permanent_potential_modifiers: statModifiers(costume.permanentStats),
        bonding_modifiers: statModifiers(costume.bondingStat),
        executable: variants.some((variant) => variant.executable),
        compile_diagnostics: diagnostics,
        source: { ...source, raw_payload: { ...costume, _localization: localized } },
      };
    }
  }
  return { characters, costumes };
}

function transformFiend(raw, source) {
  if (!raw) return { monsters: {}, characters: {}, costumes: {} };
  const fiend = raw.environment.fiend;
  const damageKind = fiendAttackType(fiend.atkType);
  const id = String(raw.monsterId);
  const statsByLevel = {};
  for (const level of raw.levels ?? []) {
    const stats = level.baseStats;
    statsByLevel[level.level] = {
      max_hp: integer(stats.HP),
      attack: integer(stats.ATK),
      magic: integer(stats.MATK),
      crit_rate_bp: percent(stats.CR),
      crit_damage_bp: percent(stats.CDMG),
      defense_bp: percent(stats.DEF),
      magic_resist_bp: percent(stats.MDEF),
      property_damage_bp: percent(stats.ADMG),
      outgoing_damage_bp: 0,
      incoming_damage_bp: 0,
      amplification_bp: 0,
    };
  }
  const statePresets = new Map((raw.statePresets ?? []).map((preset) => [preset.customStateId, preset]));
  const costumeIds = [];
  const costumes = {};
  for (const skill of raw.skills ?? []) {
    if (skill.kind !== "normal" && skill.kind !== "conditional") {
      throw new Error(`unsupported fiend skill kind: ${skill.kind}`);
    }
    if (skill.turnEndMode !== "normal" && skill.turnEndMode !== "instantDeath") {
      throw new Error(`unsupported fiend turn-end mode: ${skill.turnEndMode}`);
    }
    const targeting = fiendTargeting(skill.targeting);
    const timedOperations = [];
    let operationSequence = 0;
    const diagnostics = [];
    const sourceBuffIds = (skill.source?.buffIds ?? []).map(Number);
    const sourceOrder = (identifier, fallback = sourceBuffIds.length) => {
      const match = String(identifier ?? "").match(/buff-(\d+)/);
      if (!match) return fallback;
      const rawId = Number(match[1]);
      const direct = sourceBuffIds.indexOf(rawId);
      if (direct >= 0) return direct;
      // Conditional custom states use an xx011 derivative for the source xx002 buff.
      const conditionalParent = sourceBuffIds.indexOf(rawId - 9);
      return conditionalParent >= 0 ? conditionalParent : fallback;
    };
    const schedule = (operation, identifier, fallback) => {
      timedOperations.push({ order: sourceOrder(identifier, fallback), sequence: operationSequence, operation });
      operationSequence += 1;
    };
    const localizedDescription = Object.values(skill.localizedDescription ?? {}).join(" ");
    let activationCondition = null;
    let maxUsesPerParty = null;
    if (skill.kind === "conditional") {
      const chainTrigger = localizedDescription.match(/任何部位.*?(\d+)以上連鎖/) ?? localizedDescription.match(/at least\s+(\d+)\s+Chains.*?any part/i);
      const useLimit = localizedDescription.match(/每個出戰隊伍最多可發動(\d+)次/) ?? localizedDescription.match(/maximum of\s+(\d+)\s+time.*?per team/i);
      if (chainTrigger) activationCondition = { type: "ANY_OPPONENT_CHAIN_AT_LEAST", value: integer(chainTrigger[1]) };
      else diagnostics.push(`unsupported monster conditional trigger ${skill.source?.conditionId ?? "unknown"}`);
      if (useLimit) maxUsesPerParty = integer(useLimit[1]);
      else diagnostics.push("monster conditional skill is missing a parsed per-party use limit");
    }
    for (const group of skill.damageGroups ?? []) {
      const hitDamage = group.hitDamageList ?? [];
      if (hitDamage.length === 0) continue;
      const coefficients = [...new Set(hitDamage.map((hit) => hit.damage))];
      if (coefficients.length === 1) {
        schedule({
          op: "DEAL_DAMAGE",
          kind: damageKind,
          coefficient_bp: percent(coefficients[0]),
          reference: damageKind === "MAGICAL" ? "MAGIC" : "ATTACK",
          scaling: null,
          hits: hitDamage.length,
          can_crit: false,
          can_evade: true,
          chain_per_hit: 1,
          main_target_bonus_bp: 0,
        }, group.groupId);
      } else {
        for (const hit of hitDamage) {
          schedule({ op: "DEAL_DAMAGE", kind: damageKind, coefficient_bp: percent(hit.damage), reference: damageKind === "MAGICAL" ? "MAGIC" : "ATTACK", scaling: null, hits: 1, can_crit: false, can_evade: true, chain_per_hit: 1, main_target_bonus_bp: 0 }, group.groupId);
        }
      }
    }
    for (const stateEffect of skill.stateEffects ?? []) {
      let operation = null;
      if (stateEffect.operation === "removeRecoveryStates") {
        operation = { op: "REMOVE_EFFECTS_BY_TAG", tag: "RECOVERY" };
      } else if (stateEffect.operation === "applyState") {
        const preset = statePresets.get(stateEffect.customStateId);
        if (!preset) {
          diagnostics.push(`missing state preset ${stateEffect.customStateId}`);
          continue;
        }
        const modifiers = {};
        const tags = [];
        if (preset.buffKey === "ADMG") modifiers.property_damage_bp = percent(preset.value);
        else if (preset.buffKey === "DMG") modifiers.outgoing_damage_bp = percent(preset.value);
        else if (preset.buffKey === "Chain") modifiers.chain_received_delta = integer(preset.value);
        else if (preset.stateKey === "ChainRetention") modifiers.chain_retention = integer(preset.value);
        else throw new Error(`unsupported fiend state preset: ${preset.customStateId}`);
        operation = effect(
          stateEffect.customStateId,
          fiendEffectPolarity(preset.stateType),
          "TARGET_SIDE",
          integer(preset.remainingDuration),
          modifiers,
          tags,
          { duration_clock: "GAME_TURN" },
        );
      } else {
        throw new Error(`unsupported fiend state operation: ${stateEffect.operation}`);
      }
      if (!operation) continue;
      if (stateEffect.condition && stateEffect.condition.type !== "targetChainAtLeast") {
        throw new Error(`unsupported fiend state condition: ${stateEffect.condition.type}`);
      }
      if (stateEffect.condition?.type === "targetChainAtLeast") {
        operation = { op: "CONDITIONAL", condition: { type: "TARGET_CHAIN_AT_LEAST", value: integer(stateEffect.condition.chainAtLeast) }, operations: [operation] };
      }
      schedule(operation, stateEffect.effectId);
    }
    if (skill.turnEndMode === "instantDeath") {
      schedule({ op: "INSTANT_DEATH", remove_beneficial_effects: true }, skill.source?.buffIds?.[0], 0);
    }
    const operations = timedOperations
      .sort((left, right) => left.order - right.order || left.sequence - right.sequence)
      .map((entry) => entry.operation);
    if (operations.length === 0) diagnostics.push("monster skill has no compiled operations");
    const costumeId = `fiend:${id}:${skill.skillId}`;
    costumeIds.push(costumeId);
    costumes[costumeId] = {
      id: costumeId,
      character_id: `fiend:${id}`,
      names: skill.localizedName ?? {},
      skill_names: skill.localizedName ?? {},
      range: fiendRange(skill, targeting),
      variants: [{
        enhancement: 0,
        burst_level: 0,
        potential_mask: 0,
        sp_cost: 0,
        cooldown: 0,
        selector: targeting.selector,
        fixed_target_cell: targeting.fixed_target_cell,
        target_all: targeting.target_all,
        range_override: null,
        operations,
        consume_remaining_sp: false,
        executable: diagnostics.length === 0 && operations.length > 0,
        compile_diagnostics: diagnostics,
        preemptive: false,
        activation_condition: activationCondition,
        max_uses_per_party: maxUsesPerParty,
        ai_sequence_index: skill.kind === "normal" ? integer(skill.sourceOrder) : null,
        description_ja: String(skill.localizedDescription?.ja ?? skill.localizedDescription?.["ja-JP"] ?? ""),
      }],
      permanent_potential_modifiers: {},
      bonding_modifiers: {},
      executable: diagnostics.length === 0,
      compile_diagnostics: diagnostics,
      source: { ...source, raw_payload: skill },
    };
  }
  const topLevel = statsByLevel[Math.min(...Object.keys(statsByLevel).map(Number))];
  const characters = {
    [`fiend:${id}`]: {
      id: `fiend:${id}`,
      names: raw.localizedName ?? {},
      rarity: 0,
      element: element(fiend.attribute),
      attack_type: damageKind,
      target_selector: "FRONT",
      knockback_direction: "BACK",
      level_100: topLevel,
      engraving_modifiers: {},
      awakening_modifiers: {},
      costume_ids: costumeIds,
      source: { ...source, raw_payload: raw },
    },
  };
  return {
    monsters: { [id]: {
      id,
      names: raw.localizedName ?? {},
      element: element(fiend.attribute),
      stats_by_level: statsByLevel,
      parts: (raw.environment.envCells ?? []).map((cell) => ({
        id: cell.cellId,
        position: { row: cell.y, depth: cell.x },
        attackable: Boolean(cell.canBeAttacked),
        weak_point_bonus_bp: integer(cell.weakPointBonus) * 100,
      })),
      skill_ids: costumeIds,
      immunities: [fiend.immunity?.knockback ? "KNOCKBACK" : null, fiend.immunity?.silence ? "SILENCE" : null].filter(Boolean),
      source: { ...source, raw_payload: raw },
    } },
    characters,
    costumes,
  };
}

function transformSummons(rawSummons, ranges, source) {
  const characters = {};
  const costumes = {};
  for (const raw of rawSummons) {
    const characterId = `summon:${raw.summonId}`;
    const costumeId = `${characterId}:skill`;
    characters[characterId] = {
      id: characterId,
      names: { en: raw.enName ?? raw.summonId, "zh-TW": raw.name ?? raw.summonId },
      rarity: 0,
      element: element(raw.attribute),
      attack_type: attackType(raw.atkType),
      target_selector: selector(raw.target),
      knockback_direction: knockbackDirection(raw.knockback),
      level_100: { max_hp: 1, attack: 1, magic: 1, crit_rate_bp: 0, crit_damage_bp: 0, defense_bp: 0, magic_resist_bp: 0, property_damage_bp: 0, outgoing_damage_bp: 0, incoming_damage_bp: 0, amplification_bp: 0 },
      engraving_modifiers: {},
      awakening_modifiers: {},
      costume_ids: [costumeId],
      source: { ...source, raw_payload: raw },
    };
    const variants = [];
    for (const [enhancement, level] of raw.level.entries()) {
      const costumeLike = { costumeId, skill: raw.skill, chain: "1", target: raw.target, tags: "" };
      const compiled = compileOperations(raw, costumeLike, level, [], enhancement);
      if (/自爆/.test((raw.skill ?? []).join(" "))) {
        for (const operation of compiled.operations) if (operation.op === "DEAL_DAMAGE") operation.can_evade = false;
        compiled.operations.push({ op: "SELF_DESTRUCT" });
      }
      variants.push({
        enhancement,
        burst_level: 0,
        potential_mask: 0,
        // Summon skills are triggered operations and never consume the team's
        // command SP or enter the costume cooldown cycle.
        sp_cost: 0,
        cooldown: 0,
        selector: selector(raw.target),
        fixed_target_cell: null,
        target_all: false,
        range_override: null,
        operations: compiled.operations,
        consume_remaining_sp: false,
        executable: compiled.diagnostics.length === 0 && compiled.operations.length > 0,
        compile_diagnostics: compiled.diagnostics,
        preemptive: false,
        activation_condition: null,
        max_uses_per_party: null,
        ai_sequence_index: null,
        description_ja: "",
      });
    }
    const code = rangeCode(raw.range);
    costumes[costumeId] = {
      id: costumeId, character_id: characterId,
      names: {
        "zh-TW": requiredText(raw.skillName, `${costumeId} skill name`),
        ...optionalLocalizedText("ja", raw.costumeName_ja, `${costumeId} Japanese costume name`),
      },
      skill_names: {
        "zh-TW": requiredText(raw.skillName, `${costumeId} skill name`),
        ...optionalLocalizedText("ja", raw.skillName_ja, `${costumeId} Japanese skill name`),
      },
      range: rangeOffsets(ranges, code), variants,
      permanent_potential_modifiers: {},
      bonding_modifiers: {},
      executable: variants.some((variant) => variant.executable), compile_diagnostics: [...new Set(variants.flatMap((variant) => variant.compile_diagnostics))],
      source: { ...source, raw_payload: raw },
    };
  }
  return { characters, costumes };
}

const page = await getText(`${ORIGIN}/en/costumes`);
const mainAsset = page.match(/\/assets\/main-[A-Za-z0-9_-]+\.js/)?.[0];
if (!mainAsset) throw new Error("main asset was not found");
const main = await getText(`${ORIGIN}${mainAsset}`);
const characterAsset = main.match(/assets\/db-characters-[A-Za-z0-9_-]+\.js/)?.[0];
const rangeAsset = main.match(/assets\/rangeOffsets-[A-Za-z0-9_-]+\.js/)?.[0];
const fiendAsset = main.match(/assets\/frcFiendTemplateConfigs-[A-Za-z0-9_-]+\.js/)?.[0];
const summonAsset = main.match(/assets\/db-summons-[A-Za-z0-9_-]+\.js/)?.[0];
const equipmentAsset = main.match(/assets\/db-weapons-[A-Za-z0-9_-]+\.js/)?.[0];
const equipmentCoreAsset = main.match(/assets\/core-[A-Za-z0-9_-]+\.js/)?.[0];
const blessingDetailAsset = main.match(/assets\/BlessingDetail[^"']+\.js/)?.[0];
if (!characterAsset || !rangeAsset || !summonAsset || !equipmentAsset || !equipmentCoreAsset || !blessingDetailAsset) {
  throw new Error("required data assets were not found");
}

const blessingDetailText = await getText(`${ORIGIN}/${blessingDetailAsset}`);
const blessingAsset = blessingDetailText.match(/assets\/blessings_i18n-[A-Za-z0-9_-]+\.js/)?.[0]
  ?? blessingDetailText.match(/\.\/blessings_i18n-[A-Za-z0-9_-]+\.js/)?.[0]?.replace("./", "assets/");
if (!blessingAsset) throw new Error("Gladiator's Blessing data asset was not found");
const [characterText, rangeText, fiendText, summonText, equipmentText, equipmentCoreText, blessingText] = await Promise.all([
  getText(`${ORIGIN}/${characterAsset}`),
  getText(`${ORIGIN}/${rangeAsset}`),
  fiendAsset ? getText(`${ORIGIN}/${fiendAsset}`) : Promise.resolve(""),
  getText(`${ORIGIN}/${summonAsset}`),
  getText(`${ORIGIN}/${equipmentAsset}`),
  getText(`${ORIGIN}/${equipmentCoreAsset}`),
  getText(`${ORIGIN}/${blessingAsset}`),
]);
const observedAt = new Date().toISOString();
const characterSource = {
  source_id: "BD2DB_CHARACTER_STATIC_BUNDLE",
  source_url: `${ORIGIN}/${characterAsset}`,
  observed_at: observedAt,
  source_digest: sha256(characterText),
};
const fiendSource = {
  source_id: "BD2DB_FIEND_TEMPLATE_BUNDLE",
  source_url: fiendAsset ? `${ORIGIN}/${fiendAsset}` : ORIGIN,
  observed_at: observedAt,
  source_digest: sha256(fiendText),
};
const summonSource = { source_id: "BD2DB_SUMMON_STATIC_BUNDLE", source_url: `${ORIGIN}/${summonAsset}`, observed_at: observedAt, source_digest: sha256(summonText) };
const equipmentSource = {
  source_id: "BD2DB_UR4_AND_EX_UR_EQUIPMENT_CALCULATORS",
  source_url: `${ORIGIN}/ja/option-calculator`,
  observed_at: observedAt,
  source_digest: sha256(`${equipmentText}\n${equipmentCoreText}`),
};
const blessingSource = {
  source_id: "BD2DB_GLADIATORS_BLESSINGS_STATIC_BUNDLE",
  source_url: `${ORIGIN}/${blessingAsset}`,
  observed_at: observedAt,
  source_digest: sha256(blessingText),
};
const rawCharacters = findCharacterData(characterText);
const transformed = transformCharacters(rawCharacters, findCostumeI18n(characterText), findRangeData(rangeText), characterSource);
const transformedFiend = transformFiend(findFiendData(fiendText), fiendSource);
const transformedSummons = transformSummons(findSummonData(summonText), findRangeData(rangeText), summonSource);
const transformedEquipment = transformEquipment(
  findEquipmentData(equipmentText),
  findEquipmentI18n(equipmentText),
  findEquipmentStatTables(equipmentCoreText),
  equipmentSource,
  new Set(rawCharacters.filter((character) => Number(character.star) === 5).map((character) => character.characterId)),
);
const transformedBlessings = transformBlessings(findBlessingI18n(blessingText), blessingSource);
Object.assign(transformed.characters, transformedFiend.characters);
Object.assign(transformed.costumes, transformedFiend.costumes);
Object.assign(transformed.characters, transformedSummons.characters);
Object.assign(transformed.costumes, transformedSummons.costumes);
const catalog = {
  ruleset_id: RULESET,
  characters: transformed.characters,
  costumes: transformed.costumes,
  monsters: transformedFiend.monsters,
  equipment: transformedEquipment.definitions,
  blessings: transformedBlessings,
  skills: {},
};

try {
  const localization = JSON.parse(await readFile(localizationPath, "utf8"));
  for (const [id, name] of Object.entries(localization.characters ?? {})) {
    if (catalog.characters[id]) catalog.characters[id].names.ja = name;
  }
  for (const [id, name] of Object.entries(localization.costumes ?? {})) {
    if (catalog.costumes[id]) catalog.costumes[id].names.ja = name;
  }
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

assertSerializableData(catalog);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
if (equipmentOraclePath) {
  const oracle = {
    schema_version: 2,
    observed_at: observedAt,
    source: {
      site: `${ORIGIN}/ja/`,
      equipment_list: `${ORIGIN}/ja/weapons`,
      option_calculator: `${ORIGIN}/ja/option-calculator`,
      stat_calculator: `${ORIGIN}/ja/stat-calculator`,
      gear_picker: `${ORIGIN}/ja/gear-picker`,
      equipment_bundle: `${ORIGIN}/${equipmentAsset}`,
      calculator_bundle: `${ORIGIN}/${equipmentCoreAsset}`,
      digest: equipmentSource.source_digest,
    },
    scope: {
      kinds: ["CRAFTED_LEGENDARY", "EXCLUSIVE"],
      tiers: ["UR4", "EX UR"],
      character_scope: "5_STAR",
      refinement_scores: [18, 19, 20, 21, 22, 23, 24],
      equipment_count: Object.keys(transformedEquipment.definitions).length,
      case_count: transformedEquipment.oracleCases.length,
      crafted_legendary_count: Object.values(transformedEquipment.definitions)
        .filter((entry) => entry.kind === "CRAFTED_LEGENDARY").length,
      exclusive_count: Object.values(transformedEquipment.definitions)
        .filter((entry) => entry.kind === "EXCLUSIVE").length,
    },
    calculator_defaults: {
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
    },
    equipment: transformedEquipment.definitions,
    cases: transformedEquipment.oracleCases,
  };
  assertSerializableData(oracle);
  await mkdir(dirname(equipmentOraclePath), { recursive: true });
  await writeFile(equipmentOraclePath, `${JSON.stringify(oracle, null, 2)}\n`, "utf8");
}
const costumeValues = Object.values(catalog.costumes);
const report = {
  output: outputPath,
  ruleset: RULESET,
  characters: Object.keys(catalog.characters).length,
  costumes: costumeValues.length,
  executableCostumes: costumeValues.filter((costume) => costume.executable).length,
  reviewRequiredCostumes: costumeValues.filter((costume) => !costume.executable).length,
  monsters: Object.keys(catalog.monsters).length,
  equipment: Object.keys(catalog.equipment).length,
  blessings: Object.keys(catalog.blessings).length,
  craftedLegendaryEquipment: Object.values(catalog.equipment)
    .filter((entry) => entry.kind === "CRAFTED_LEGENDARY").length,
  exclusiveEquipment: Object.values(catalog.equipment)
    .filter((entry) => entry.kind === "EXCLUSIVE").length,
  equipmentCases: transformedEquipment.oracleCases.length,
  equipmentOracle: equipmentOraclePath,
  sourceDigest: characterSource.source_digest,
};
console.log(JSON.stringify(report, null, 2));
