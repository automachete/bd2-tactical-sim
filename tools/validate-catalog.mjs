/**
 * Fail-fast semantic validation for the generated current-ruleset catalog.
 *
 * This complements schema deserialization: every source semantic tag must have
 * corresponding typed evidence in every costume's fully unlocked variant.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const catalogPath = resolve(process.argv[2] ?? "data/generated/catalog.json");
const catalog = JSON.parse(await readFile(catalogPath, "utf8"));

function fullVariant(costume) {
  return costume.variants.reduce((best, current) => {
    const score = [current.enhancement, current.burst_level, current.potential_mask];
    const bestScore = [best.enhancement, best.burst_level, best.potential_mask];
    for (let index = 0; index < score.length; index += 1) {
      if (score[index] !== bestScore[index]) return score[index] > bestScore[index] ? current : best;
    }
    return best;
  });
}

function collectEvidence(variant) {
  const evidence = {
    operations: [],
    effects: [],
    damage: [],
    modifiers: [],
    references: new Set(),
    tags: new Set(),
  };
  const visitEffect = (effect) => {
    if (!effect) return;
    evidence.effects.push(effect);
    evidence.modifiers.push(effect.modifiers ?? {});
    for (const tag of effect.tags ?? []) evidence.tags.add(tag);
    if (effect.periodic) {
      evidence.references.add(effect.periodic.reference);
      evidence.damage.push({ kind: effect.periodic.kind, reference: effect.periodic.reference });
    }
    if (effect.counter) {
      evidence.references.add(effect.counter.reference);
      evidence.damage.push(effect.counter);
    }
    if (effect.barrier) evidence.references.add(effect.barrier.reference);
    visitEffect(effect.aura_allies);
    visitEffect(effect.aura_opponents);
    visitEffect(effect.on_hit_received_allies);
    visitEffect(effect.on_chain_dealt?.stack_effect);
    visitEffect(effect.on_chain_dealt?.threshold_effect);
    visitOperations(effect.on_hit_received_operations ?? []);
    visitOperations(effect.on_turn_end_operations ?? []);
  };
  const visitOperations = (operations) => {
    for (const operation of operations) {
      evidence.operations.push(operation);
      if (operation.op === "DEAL_DAMAGE") {
        evidence.damage.push(operation);
        if (operation.reference) evidence.references.add(operation.reference);
      }
      visitEffect(operation.effect);
      visitOperations(operation.operations ?? []);
      if (operation.op === "SUMMON") {
        const summonCostume = catalog.costumes[operation.costume_id];
        if (summonCostume) visitOperations(fullVariant(summonCostume).operations);
      }
    }
  };
  visitOperations(variant.operations);
  return evidence;
}

function modifier(evidence, key, predicate = (value) => value !== 0) {
  return evidence.modifiers.some((entry) => predicate(Number(entry[key] ?? 0)));
}
function operation(evidence, name) {
  return evidence.operations.some((entry) => entry.op === name);
}
function damage(evidence, kind) {
  return evidence.damage.some((entry) => entry.kind === kind);
}
function tagged(evidence, tag) {
  return evidence.tags.has(tag);
}

function rawNumber(value, label) {
  if (value === undefined || value === null || String(value).trim() === "") {
    throw new Error(`missing ${label}`);
  }
  const parsed = Number(String(value).replace(/[％%,]/g, ""));
  if (!Number.isFinite(parsed)) throw new Error(`invalid ${label}: ${String(value)}`);
  return parsed;
}

function rawPercent(value, label = "percentage") {
  return Math.round(rawNumber(value, label) * 100);
}

function rawInteger(value, label = "integer") {
  const parsed = rawNumber(value, label);
  if (!Number.isInteger(parsed)) throw new Error(`non-integer ${label}: ${String(value)}`);
  return parsed;
}

function rawElement(value) {
  const values = { "火": "FIRE", "水": "WATER", "風": "WIND", "光": "LIGHT", "闇": "DARK", "暗": "DARK" };
  if (!Object.hasOwn(values, value)) throw new Error(`unknown element: ${String(value)}`);
  return values[value];
}

function rawAttackType(value) {
  const values = { "物": "PHYSICAL", "魔": "MAGICAL" };
  if (!Object.hasOwn(values, value)) throw new Error(`unknown attack type: ${String(value)}`);
  return values[value];
}

function rawSelector(value) {
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
  const label = String(value ?? "").trim();
  if (!Object.hasOwn(values, label)) throw new Error(`unknown target selector: ${label}`);
  return values[label];
}

function rawRangeCode(value) {
  const match = String(value ?? "").match(/(?:^|_)(all|\d{3})$/);
  if (!match) throw new Error(`unknown range code: ${String(value)}`);
  return match[1];
}

function resolvedSourceVariant(raw, enhancement, burstLevel, potentialMask) {
  if (!raw.level?.[enhancement]) throw new Error(`missing source enhancement ${enhancement}`);
  const level = { ...raw.level[enhancement] };
  let spCost = rawInteger(level.SP);
  let cooldown = rawInteger(level.CD);
  let range = rawRangeCode(raw.range);
  const activeText = [...(raw.skill ?? [])];
  for (const stage of (raw.burst ?? []).filter((entry) => Number(entry.level) <= burstLevel)) {
    spCost += rawInteger(stage.spCost);
    for (const item of [...(stage.switches ?? []), ...(stage.extraEffects ?? []).flatMap((extra) => extra.switches ?? [])]) {
      if (item.target === "CD") continue;
      if (!Object.hasOwn(level, item.target)) throw new Error(`missing switched scalar ${item.target}`);
      level[item.target] = rawNumber(level[item.target], `scalar ${item.target}`)
        + rawNumber(item.value, `switch ${item.target}`);
    }
    if (stage.type === "Plus" && stage.value) activeText.push(stage.value);
    for (const extra of stage.extraEffects ?? []) {
      if (extra.type === "Plus" && extra.value) activeText.push(extra.value);
      if (extra.type === "Range") range = rawRangeCode(extra.value);
      if (extra.type === "Cooldown") {
        const reductions = (extra.switches ?? [])
          .filter((item) => item.target === "CD")
          .map((item) => rawInteger(item.value, "burst cooldown switch"));
        const reduction = reductions.length > 0
          ? reductions.reduce((sum, value) => sum + value, 0)
          : rawInteger(extra.value, "burst cooldown");
        cooldown = Math.max(0, cooldown - reduction);
      }
    }
    if (stage.type === "Cooldown") cooldown = Math.max(0, cooldown - rawInteger(String(stage.value ?? "").match(/減少\s*(\d+)/)?.[1]));
  }
  for (const [index, potential] of (raw.skillPotential ?? []).entries()) {
    if ((potentialMask & (1 << index)) === 0) continue;
    for (const item of potential.switches ?? []) {
      if (item.target === "CD") continue;
      if (!Object.hasOwn(level, item.target)) throw new Error(`missing switched scalar ${item.target}`);
      level[item.target] = rawNumber(level[item.target], `scalar ${item.target}`)
        + rawNumber(item.value, `switch ${item.target}`);
    }
    if (potential.type === "Plus" && potential.value) activeText.push(potential.value);
    if (potential.type === "Range") range = rawRangeCode(potential.value);
    if (potential.type === "Rhombus") spCost -= rawInteger(String(potential.value ?? "").match(/減少\s*(\d+)/)?.[1]);
    if (potential.type === "Cooldown") cooldown = Math.max(0, cooldown - rawInteger(String(potential.value ?? "").match(/減少\s*(\d+)/)?.[1]));
  }
  return { level, spCost: Math.max(0, spCost), cooldown, range, activeText };
}

function rawKnockbackDirection(value) {
  const values = {
    "後": "BACK",
    "前": "FRONT",
    "右": "UP",
    "左": "DOWN",
    "右後": "UP_BACK",
    "左後": "DOWN_BACK",
    "右前": "UP_FRONT",
    "左前": "DOWN_FRONT",
  };
  const label = String(value ?? "").trim();
  if (!Object.hasOwn(values, label)) throw new Error(`unknown knockback direction: ${label}`);
  return values[label];
}

function rawStatModifiers(entries) {
  const result = {};
  const add = (key, amount) => { result[key] = (result[key] ?? 0) + amount; };
  for (const entry of entries ?? []) {
    const basisPoints = rawPercent(entry.value);
    switch (entry.key) {
      case "HP": add("max_hp_flat", rawInteger(entry.value)); break;
      case "HP%": add("max_hp_bp", basisPoints); break;
      case "ATK": add("attack_flat", rawInteger(entry.value)); break;
      case "ATK%": add("attack_bp", basisPoints); break;
      case "MATK": add("magic_flat", rawInteger(entry.value)); break;
      case "MATK%": add("magic_bp", basisPoints); break;
      case "DEF": add("defense_bp", basisPoints); break;
      case "MDEF":
      case "MR": add("magic_resist_bp", basisPoints); break;
      case "CR": add("crit_rate_bp", basisPoints); break;
      case "CDMG": add("crit_damage_bp", basisPoints); break;
      case "ADMG": add("property_damage_bp", basisPoints); break;
      default: result[`UNSUPPORTED:${entry.key}`] = 1;
    }
  }
  return result;
}

function variantMechanics(variant) {
  return JSON.stringify({
    sp_cost: variant.sp_cost,
    cooldown: variant.cooldown,
    selector: variant.selector,
    range_override: variant.range_override,
    operations: variant.operations,
    consume_remaining_sp: variant.consume_remaining_sp,
    preemptive: variant.preemptive,
  });
}

function variantAt(costume, enhancement, burstLevel, potentialMask) {
  return costume.variants.find((variant) =>
    variant.enhancement === enhancement
    && variant.burst_level === burstLevel
    && variant.potential_mask === potentialMask);
}

function numericMagnitudes(value, found = []) {
  if (typeof value === "number") found.push(Math.abs(value));
  else if (Array.isArray(value)) for (const entry of value) numericMagnitudes(entry, found);
  else if (value && typeof value === "object") for (const entry of Object.values(value)) numericMagnitudes(entry, found);
  return found;
}

function directDamageOperations(operations) {
  const found = [];
  for (const entry of operations ?? []) {
    if (entry.op === "DEAL_DAMAGE") found.push(entry);
    found.push(...directDamageOperations(entry.operations));
  }
  return found;
}

function sourceChainThresholds(operations) {
  const found = [];
  for (const entry of operations ?? []) {
    if (entry.op === "CONDITIONAL" && entry.condition?.type === "TARGET_CHAIN_AT_LEAST") {
      for (const damage of directDamageOperations(entry.operations)) {
        found.push(Number(entry.condition.value) + Number(damage.hits));
      }
    }
    found.push(...sourceChainThresholds(entry.operations));
  }
  return found;
}

function hasImmediateDamageSentence(skill) {
  return (skill ?? []).some((line) => {
    const sentence = String(line);
    if (/反擊時|每回合結束時|受到攻擊時/.test(sentence)) return false;
    if (/套用.*(?:出血|燒傷|中毒|腐敗|凍傷|惡夢)效果/.test(sentence)) return false;
    return /(?:對敵人造成|攻擊敵人|每次攻擊(?:時)?，?造成|造成\s*(?:\{|\d)|造成(?:相當於)?(?:自身|敵人))/.test(sentence);
  });
}

function duplicateUnconditionalEffectIds(operations) {
  const grouped = new Map();
  for (const entry of operations ?? []) {
    if (entry.op !== "APPLY_EFFECT" || !entry.effect?.effect_id) continue;
    const effects = grouped.get(entry.effect.effect_id) ?? [];
    effects.push(entry.effect);
    grouped.set(entry.effect.effect_id, effects);
  }
  return [...grouped]
    .filter(([, effects]) => effects.length > 1 && effects.some((effect) => effect.stack_rule !== "INDEPENDENT"))
    .map(([effectId]) => effectId);
}

function repeatedEffectCounts(operations) {
  const counts = new Map();
  for (const entry of operations ?? []) {
    if (entry.op !== "APPLY_EFFECT" || !entry.effect?.effect_id) continue;
    counts.set(entry.effect.effect_id, (counts.get(entry.effect.effect_id) ?? 0) + 1);
  }
  return [...counts.values()].filter((count) => count > 1);
}

const metadataOnly = new Set([
  "限定服裝", "本家限定", "聯動限定", "免費服裝", "輔助",
]);

function hasSemanticEvidence(tag, costume, variant, evidence) {
  if (metadataOnly.has(tag)) return true;
  const checks = {
    "物理傷害": () => damage(evidence, "PHYSICAL") || damage(evidence, "COLLISION"),
    "魔法傷害": () => damage(evidence, "MAGICAL"),
    "固定傷害": () => damage(evidence, "FIXED"),
    "純粹傷害": () => damage(evidence, "FIXED"),
    "攻擊力增益": () => modifier(evidence, "attack_bp", (v) => v > 0),
    "魔法力增益": () => modifier(evidence, "magic_bp", (v) => v > 0),
    "致命率增益": () => modifier(evidence, "crit_rate_bp", (v) => v > 0),
    "致命傷害增益": () => modifier(evidence, "crit_damage_bp", (v) => v > 0),
    "屬性傷害增益": () => modifier(evidence, "property_damage_bp", (v) => v > 0),
    "降物/魔防": () => modifier(evidence, "defense_bp", (v) => v < 0) || modifier(evidence, "magic_resist_bp", (v) => v < 0),
    "降物/魔攻": () => modifier(evidence, "attack_bp", (v) => v < 0) || modifier(evidence, "magic_bp", (v) => v < 0),
    "脆弱": () => tagged(evidence, "VULNERABLE") || modifier(evidence, "incoming_damage_bp", (v) => v > 0),
    "持續傷害脆弱": () => modifier(evidence, "dot_incoming_damage_bp", (v) => v > 0),
    "回復生命": () => operation(evidence, "HEAL") || tagged(evidence, "RECOVERY") || evidence.effects.some((effect) => effect.revive_hp_bp != null),
    "增加SP": () => evidence.operations.some((entry) => ["CHANGE_SP", "CHANGE_SP_PER_SUCCESSFUL_HIT"].includes(entry.op) && entry.amount > 0),
    "失去SP": () => evidence.operations.some((entry) => ["CHANGE_SP", "CHANGE_SP_PER_SUCCESSFUL_HIT"].includes(entry.op) && entry.amount < 0),
    "解除增益": () => operation(evidence, "REMOVE_EFFECTS") || operation(evidence, "REMOVE_EFFECTS_BY_TAG"),
    "解除減益": () => operation(evidence, "ABSORB_EFFECTS_AND_APPLY_STACKS") || evidence.operations.some((entry) => entry.op === "REMOVE_EFFECTS" && entry.polarity === "HARMFUL"),
    "沉默": () => tagged(evidence, "SILENCE"),
    "技能擊退": () => operation(evidence, "KNOCKBACK"),
    "持續傷害": () => tagged(evidence, "DOT"),
    "中毒": () => tagged(evidence, "POISON"),
    "流血": () => tagged(evidence, "BLEED"),
    "燒傷": () => tagged(evidence, "BURN"),
    "腐敗": () => tagged(evidence, "CORRUPTION"),
    "凍傷": () => tagged(evidence, "FROSTBITE"),
    "惡夢": () => tagged(evidence, "NIGHTMARE"),
    "能量防衛": () => tagged(evidence, "ENERGY_GUARD"),
    "防護罩": () => tagged(evidence, "BARRIER"),
    "迴避": () => tagged(evidence, "EVASION") || modifier(evidence, "evasion_bp", (v) => v > 0),
    "百分比傷害": () => evidence.references.has("TARGET_MAX_HP") || evidence.operations.some((entry) => entry.op === "KNOCKBACK" && entry.collision_coefficient_bp > 0),
    "生命傷害": () => evidence.references.has("MAX_HP") || evidence.references.has("CURRENT_HP"),
    "挑釁": () => tagged(evidence, "TAUNT"),
    "集中": () => tagged(evidence, "FOCUS"),
    "連鎖強化": () => modifier(evidence, "chain_dealt_delta", (v) => v > 0),
    "連鎖弱化": () => modifier(evidence, "chain_dealt_delta", (v) => v < 0) || modifier(evidence, "chain_received_delta", (v) => v < 0),
    "維持連鎖": () => modifier(evidence, "chain_retention", (v) => v > 0),
    "連鎖傷害增益": () => modifier(evidence, "chain_damage_outgoing_bp", (v) => v > 0) || modifier(evidence, "chain_damage_incoming_bp", (v) => v > 0),
    "普攻傷害增強": () => modifier(evidence, "normal_attack_damage_bp", (v) => v > 0),
    "SP消耗增加": () => modifier(evidence, "sp_cost_delta", (v) => v > 0) || variant.consume_remaining_sp,
    "SP消耗減少": () => modifier(evidence, "sp_cost_delta", (v) => v < 0),
    "增強效果": () => tagged(evidence, "AUGMENTATION") || modifier(evidence, "outgoing_damage_bp", (v) => v > 0),
    "反擊": () => evidence.effects.some((effect) => effect.counter),
    "復活": () => evidence.effects.some((effect) => effect.revive_hp_bp != null),
    "增益延長": () => evidence.operations.some((entry) => entry.op === "EXTEND_EFFECTS" && entry.polarity === "BENEFICIAL"),
    "減益延長": () => evidence.operations.some((entry) => entry.op === "EXTEND_EFFECTS" && entry.polarity === "HARMFUL"),
    "冷卻減少": () => operation(evidence, "CHANGE_COOLDOWN") || operation(evidence, "CHANGE_COSTUME_COOLDOWN") || costume.variants.some((entry) => entry.cooldown > variant.cooldown),
    "迴避目標": () => tagged(evidence, "EVADE_TARGET"),
    "召喚": () => operation(evidence, "SUMMON"),
    "召喚物脆弱": () => modifier(evidence, "summon_incoming_damage_bp", (v) => v > 0),
    "先發制人": () => variant.preemptive,
    "疊加": () => evidence.effects.some((effect) => effect.stack_rule === "INDEPENDENT" || Number(effect.max_stacks ?? 0) > 1),
    "變身": () => tagged(evidence, "TRANSFORMATION"),
    "光環": () => evidence.effects.some((effect) => effect.aura_allies || effect.aura_opponents),
    "領域": () => evidence.effects.some((effect) => tagged({ tags: new Set(effect.tags ?? []) }, "FIELD") && (effect.aura_allies || effect.aura_opponents)),
    "加速": () => tagged(evidence, "ACCELERATION"),
    "標記": () => tagged(evidence, "MARK"),
    "條件增傷": () => evidence.damage.some((entry) => entry.scaling) || operation(evidence, "CONDITIONAL") || evidence.effects.some((effect) => (effect.conditional_outgoing ?? []).length > 0),
    "總量": () => evidence.damage.some((entry) => entry.scaling),
    "暴走": () => variant.consume_remaining_sp && evidence.damage.some((entry) => entry.scaling?.source?.type === "EXTRA_SP_CONSUMED"),
    "能量防衛傷害": () => evidence.references.has("ENERGY_GUARD"),
    "共鳴": () => operation(evidence, "APPLY_EFFECT_PER_MATCHING_ENEMY"),
  };
  return checks[tag]?.() ?? false;
}

const failures = [];
let lineageChecks = 0;
const canonicalObject = value => JSON.stringify(Object.fromEntries(Object.entries(value ?? {}).sort(([left], [right]) => left.localeCompare(right))));
const regularCharacterFields = new Set([
  "atkPosition", "atkType", "attribute", "awakening", "character", "characterId", "costumes",
  "enName", "evgraving", "gameId", "gender", "knockback", "maxlevel", "nickname",
  "originalCostumeCode", "star", "weapon", "wrongNames",
]);
const characterStatFields = new Set(["hp", "atk", "cr", "cdmg", "def", "mr"]);
const statEntryFields = new Set(["type", "key", "value"]);
const regularCostumeFields = new Set([
  "_localization", "avatarId", "beforeCostumeName", "bondingStat", "burst", "chain",
  "character", "characterId", "costumeCode", "costumeId", "costumeName", "costumeNickname",
  "gameId", "images", "knockback", "level", "permanentStats", "possibleSPList", "potential",
  "range", "skill", "skillName", "skillPotential", "specialGetWay", "summons", "tags",
  "target", "youtube",
]);
const levelFields = new Set(["SP", "CD", "HIT1", "VALUE1", "VALUE2", "VALUE3", "VALUE4"]);
const potentialFields = new Set(["type", "value", "switches"]);
const burstFields = new Set(["level", "type", "value", "spCost", "switches", "extraEffects"]);
const extraEffectFields = new Set(["type", "value", "switches"]);
const switchFields = new Set(["target", "value"]);
const potentialTypes = new Set(["Fire", "Range", "Rhombus", "Cooldown", "Plus"]);
const burstTypes = new Set(["Fire", "Plus", "Cooldown", "Hit"]);
const extraEffectTypes = new Set(["Plus", "Range", "Hit", "Cooldown"]);
const knockbackDirections = new Set(["BACK", "FRONT", "UP", "DOWN", "UP_BACK", "DOWN_BACK", "UP_FRONT", "DOWN_FRONT"]);
const effectFields = new Set([
  "effect_id", "polarity", "recipient", "duration", "duration_clock", "modifiers", "tags",
  "stack_rule", "barrier", "periodic", "charges", "evasion_decay_bp", "counter",
  "revive_hp_bp", "max_stacks", "conditional_outgoing", "on_hit_received_allies",
  "on_hit_received_operations", "on_turn_end_operations", "aura_allies", "aura_opponents",
  "on_chain_dealt",
]);
for (const character of Object.values(catalog.characters)) {
  if (!knockbackDirections.has(character.knockback_direction)) {
    failures.push(`${character.id}: invalid or missing knockback direction`);
  }
  if (character.id.includes(":")) continue;
  const raw = character.source?.raw_payload ?? {};
  const unexpected = Object.keys(raw).filter((key) => !regularCharacterFields.has(key));
  if (unexpected.length) failures.push(`${character.id}: unclassified source character fields: ${unexpected.join(", ")}`);
  const unexpectedBaseStats = Object.keys(raw.maxlevel ?? {}).filter((key) => !characterStatFields.has(key));
  if (unexpectedBaseStats.length) failures.push(`${character.id}: unclassified max-level fields: ${unexpectedBaseStats.join(", ")}`);
  for (const entry of [...(raw.evgraving ?? []), ...(raw.awakening ?? [])]) {
    const fields = Object.keys(entry).filter((key) => !statEntryFields.has(key));
    if (fields.length) failures.push(`${character.id}: unclassified character stat-entry fields: ${fields.join(", ")}`);
  }
  const expectedType = rawAttackType(raw.atkType);
  const expectedStats = {
    max_hp: rawInteger(raw.maxlevel?.hp),
    attack: expectedType === "PHYSICAL" ? rawInteger(raw.maxlevel?.atk) : 0,
    magic: expectedType === "MAGICAL" ? rawInteger(raw.maxlevel?.atk) : 0,
    crit_rate_bp: rawPercent(raw.maxlevel?.cr),
    crit_damage_bp: rawPercent(raw.maxlevel?.cdmg),
    defense_bp: rawPercent(raw.maxlevel?.def),
    magic_resist_bp: rawPercent(raw.maxlevel?.mr),
  };
  for (const [key, value] of Object.entries(expectedStats)) {
    lineageChecks += 1;
    if (character.level_100?.[key] !== value) failures.push(`${character.id}: source maxlevel.${key} was not preserved`);
  }
  const scalarChecks = {
    rarity: rawInteger(raw.star),
    element: rawElement(raw.attribute),
    attack_type: expectedType,
    target_selector: rawSelector(raw.atkPosition),
    knockback_direction: rawKnockbackDirection(raw.knockback),
  };
  for (const [key, value] of Object.entries(scalarChecks)) {
    lineageChecks += 1;
    if (character[key] !== value) failures.push(`${character.id}: source field for ${key} was not preserved`);
  }
  lineageChecks += 3;
  if (canonicalObject(character.engraving_modifiers) !== canonicalObject(rawStatModifiers(raw.evgraving))) failures.push(`${character.id}: engraving stats diverge from the source table`);
  if (canonicalObject(character.awakening_modifiers) !== canonicalObject(rawStatModifiers(raw.awakening))) failures.push(`${character.id}: awakening stats diverge from the source table`);
  if (JSON.stringify(character.costume_ids) !== JSON.stringify((raw.costumes ?? []).map((entry) => entry.costumeId))) failures.push(`${character.id}: costume membership diverges from the source table`);
  const exclusive = Object.values(catalog.equipment).find((item) => item.owner_character_id === character.id);
  lineageChecks += 1;
  if (!exclusive || exclusive.id !== raw.weapon) failures.push(`${character.id}: exclusive equipment link was not preserved`);
  if ((raw.gender === "男" || raw.gender === "女") && (raw.costumes ?? []).some((costume) => /(?:男性|女性)角色/.test((costume.skill ?? []).join(" ")))) {
    failures.push(`${character.id}: gender-dependent battle rule requires a typed model field`);
  }
}
let variants = 0;
const blessingIds = Object.keys(catalog.blessings ?? {}).sort();
if (blessingIds.length !== 47) failures.push(`expected 47 current blessings, got ${blessingIds.length}`);
for (let index = 0; index < blessingIds.length; index += 1) {
  const expectedId = `blessing_${String(index + 1).padStart(3, "0")}`;
  const id = blessingIds[index];
  const blessing = catalog.blessings[id];
  if (id !== expectedId || blessing.id !== id) failures.push(`${id}: non-contiguous or mismatched blessing id`);
  if (!["OFFENCE", "DEFENCE", "UTILITY"].includes(blessing.category)) failures.push(`${id}: unknown blessing category`);
  if (!Array.isArray(blessing.levels) || !blessing.levels.length) failures.push(`${id}: blessing levels are missing`);
  for (const locale of ["ja", "ko", "en"]) {
    if (!blessing.names?.[locale] || !blessing.descriptions?.[locale]?.length) failures.push(`${id}: ${locale} localization is missing`);
  }
  const raw = blessing.source?.raw_payload;
  if (raw?.blessingId !== id || Number(raw?.levelLength) !== blessing.levels.length || raw?.level?.length < blessing.levels.length) {
    failures.push(`${id}: transformed level structure diverges from the source record`);
  }
  for (const [levelIndex, level] of blessing.levels.entries()) {
    if (level.level !== levelIndex + 1 || level.point_cost !== Number(raw?.level?.[levelIndex]?.cost) || !level.effect?.type) {
      failures.push(`${id}: level ${levelIndex + 1} is incomplete or diverges from the source cost`);
    }
  }
  if (id === "blessing_045") {
    const modifiers = blessing.levels[0]?.effect?.effect?.modifiers;
    if (modifiers?.attack_bp !== 30000 || modifiers?.magic_bp !== 30000 || !raw?.official_override) {
      failures.push(`${id}: official 2026-08-27 Surprise Preparation 300% override is missing`);
    }
    for (const locale of ["zh-TW", "zh-CN", "en", "ja", "ko"]) {
      const description = blessing.descriptions?.[locale]?.join(" ") ?? "";
      if (!/300[%％]/.test(description) || /100[%％]/.test(description)) {
        failures.push(`${id}: ${locale} description does not reflect the official 300% override`);
      }
    }
  }
  if (id === "blessing_046") {
    if (blessing.levels[0]?.effect?.amount_bp !== 15000 || !raw?.official_override) {
      failures.push(`${id}: official 2026-08-27 Quick Decision 150% override is missing`);
    }
    for (const locale of ["zh-TW", "zh-CN", "en", "ja", "ko"]) {
      const description = blessing.descriptions?.[locale]?.join(" ") ?? "";
      if (!/150[%％]/.test(description) || /100[%％]/.test(description)) {
        failures.push(`${id}: ${locale} description does not reflect the official 150% override`);
      }
    }
  }
}
for (const costume of Object.values(catalog.costumes)) {
  variants += costume.variants.length;
  if (!costume.id.includes(":") && !costume.skill_names?.ja) {
    failures.push(`${costume.id}: official Japanese skill name is missing`);
  }
  if (!costume.executable || costume.compile_diagnostics.length) {
    failures.push(`${costume.id}: costume compilation failed: ${costume.compile_diagnostics.join("; ")}`);
  }
  for (const variant of costume.variants) {
    if (!variant.executable || variant.compile_diagnostics.length) {
      failures.push(`${costume.id}/${variant.enhancement}/${variant.burst_level}/${variant.potential_mask}: variant compilation failed`);
    }
    if (!costume.id.includes(":") && (!variant.description_ja || /\{[^}]+\}/.test(variant.description_ja))) {
      failures.push(`${costume.id}/${variant.enhancement}/${variant.burst_level}/${variant.potential_mask}: official Japanese description is missing or unresolved`);
    }
    for (const effect of collectEvidence(variant).effects) {
      const missing = [...effectFields].filter((key) => !Object.hasOwn(effect, key));
      const unexpected = Object.keys(effect).filter((key) => !effectFields.has(key));
      lineageChecks += effectFields.size;
      if (missing.length) failures.push(`${costume.id}: incomplete typed effect '${effect.effect_id}': ${missing.join(", ")}`);
      if (unexpected.length) failures.push(`${costume.id}: unknown typed effect fields in '${effect.effect_id}': ${unexpected.join(", ")}`);
    }
  }
  const variant = fullVariant(costume);
  const evidence = collectEvidence(variant);
  const semanticTags = String(costume.source?.raw_payload?.tags ?? "").split(",").filter(Boolean);
  for (const tag of semanticTags) {
    if (!hasSemanticEvidence(tag, costume, variant, evidence)) failures.push(`${costume.id}: tag '${tag}' has no typed evidence`);
  }
  if (costume.id.includes(":")) continue;
  const raw = costume.source?.raw_payload ?? {};
  const unexpected = Object.keys(raw).filter((key) => !regularCostumeFields.has(key));
  if (unexpected.length) failures.push(`${costume.id}: unclassified source costume fields: ${unexpected.join(", ")}`);
  for (const entry of [...(raw.permanentStats ?? []), ...(raw.bondingStat ?? [])]) {
    const fields = Object.keys(entry).filter((key) => !statEntryFields.has(key));
    if (fields.length) failures.push(`${costume.id}: unclassified costume stat-entry fields: ${fields.join(", ")}`);
  }
  for (const [index, level] of (raw.level ?? []).entries()) {
    const fields = Object.keys(level).filter((key) => !levelFields.has(key));
    if (fields.length) failures.push(`${costume.id}: unclassified level ${index} fields: ${fields.join(", ")}`);
  }
  for (const [index, potential] of (raw.skillPotential ?? []).entries()) {
    const fields = Object.keys(potential).filter((key) => !potentialFields.has(key));
    if (fields.length) failures.push(`${costume.id}: unclassified potential ${index + 1} fields: ${fields.join(", ")}`);
    if (!potentialTypes.has(potential.type)) failures.push(`${costume.id}: unsupported potential type '${potential.type}'`);
    for (const item of potential.switches ?? []) {
      const switchKeys = Object.keys(item).filter((key) => !switchFields.has(key));
      if (switchKeys.length) failures.push(`${costume.id}: unclassified potential switch fields: ${switchKeys.join(", ")}`);
    }
  }
  for (const [index, burst] of (raw.burst ?? []).entries()) {
    const fields = Object.keys(burst).filter((key) => !burstFields.has(key));
    if (fields.length) failures.push(`${costume.id}: unclassified burst ${index + 1} fields: ${fields.join(", ")}`);
    if (!burstTypes.has(burst.type)) failures.push(`${costume.id}: unsupported burst type '${burst.type}'`);
    for (const item of burst.switches ?? []) {
      const switchKeys = Object.keys(item).filter((key) => !switchFields.has(key));
      if (switchKeys.length) failures.push(`${costume.id}: unclassified burst switch fields: ${switchKeys.join(", ")}`);
    }
    for (const extra of burst.extraEffects ?? []) {
      const extraFields = Object.keys(extra).filter((key) => !extraEffectFields.has(key));
      if (extraFields.length) failures.push(`${costume.id}: unclassified burst extra-effect fields: ${extraFields.join(", ")}`);
      if (!extraEffectTypes.has(extra.type)) failures.push(`${costume.id}: unsupported burst extra-effect type '${extra.type}'`);
      for (const item of extra.switches ?? []) {
        const switchKeys = Object.keys(item).filter((key) => !switchFields.has(key));
        if (switchKeys.length) failures.push(`${costume.id}: unclassified burst extra-effect switch fields: ${switchKeys.join(", ")}`);
      }
    }
  }
  lineageChecks += 2;
  if (canonicalObject(costume.permanent_potential_modifiers) !== canonicalObject(rawStatModifiers(raw.permanentStats))) failures.push(`${costume.id}: permanent-potential stats diverge from the source table`);
  if (canonicalObject(costume.bonding_modifiers) !== canonicalObject(rawStatModifiers(raw.bondingStat))) failures.push(`${costume.id}: bonding stats diverge from the source table`);

  const nextAlly = (raw.skill ?? []).join(" ").includes("下一個攻擊順序") || (raw.skill ?? []).join(" ").includes("下一位攻擊順序");
  const expectedSelector = nextAlly ? "NEXT_ALLY_IN_ORDER" : rawSelector(raw.target);
  for (const current of costume.variants) {
    const expected = resolvedSourceVariant(raw, current.enhancement, current.burst_level, current.potential_mask);
    lineageChecks += 7;
    if (current.selector !== expectedSelector) failures.push(`${costume.id}: target selector diverges from source target '${raw.target}'`);
    if (current.preemptive !== semanticTags.includes("先發制人")) failures.push(`${costume.id}: preemptive tag was not preserved`);
    if (current.consume_remaining_sp !== semanticTags.includes("暴走")) failures.push(`${costume.id}: rampage SP-consumption tag was not preserved`);
    const expectedTargetAll = expected.range === "all";
    if (current.target_all !== expectedTargetAll) failures.push(`${costume.id}: all-target range was not preserved`);
    if (current.sp_cost !== expected.spCost) failures.push(`${costume.id}: variant SP cost diverges from source enhancement/burst/potential data`);
    if (current.cooldown !== expected.cooldown) failures.push(`${costume.id}: variant cooldown diverges from source enhancement/burst/potential data`);
    const expectedHits = Math.max(1, rawInteger(expected.level.HIT1 ?? raw.chain ?? 1));
    if (directDamageOperations(current.operations).some((damage) => damage.hits !== expectedHits)) failures.push(`${costume.id}: variant hit count diverges from source chain/HIT1 data`);
    const magnitudes = [...numericMagnitudes(current.operations), ...repeatedEffectCounts(current.operations)];
    const placeholders = [...new Set(expected.activeText.flatMap((line) => [...String(line).matchAll(/\{([A-Z]+\d+)\}/g)].map((match) => match[1])))];
    for (const placeholder of placeholders) {
      const value = Math.abs(Number(expected.level[placeholder]));
      lineageChecks += 1;
      if (Number.isFinite(value) && !magnitudes.includes(value) && !magnitudes.includes(value * 100)) failures.push(`${costume.id}: ${placeholder}=${value} is absent from a materialized variant`);
    }
  }
  lineageChecks += 1;
  const sourceSpCosts = [...new Set((raw.possibleSPList ?? []).map(Number))].sort((left, right) => left - right);
  const compiledBaseSpCosts = [...new Set(costume.variants.filter((entry) => entry.burst_level === 0).map((entry) => entry.sp_cost))].sort((left, right) => left - right);
  if (JSON.stringify(sourceSpCosts) !== JSON.stringify(compiledBaseSpCosts)) failures.push(`${costume.id}: possible SP costs diverge from source table`);

  const rawLevels = raw.level ?? [];
  for (let enhancement = 1; enhancement < rawLevels.length; enhancement += 1) {
    if (JSON.stringify(rawLevels[enhancement]) === JSON.stringify(rawLevels[enhancement - 1])) continue;
    lineageChecks += 1;
    const previous = variantAt(costume, enhancement - 1, 0, 0);
    const current = variantAt(costume, enhancement, 0, 0);
    if (!previous || !current || variantMechanics(previous) === variantMechanics(current)) failures.push(`${costume.id}: +${enhancement} source level changes no typed mechanic`);
  }
  for (const [index] of (raw.skillPotential ?? []).entries()) {
    lineageChecks += 1;
    const base = variantAt(costume, rawLevels.length - 1, 0, 0);
    const unlocked = variantAt(costume, rawLevels.length - 1, 0, 1 << index);
    if (!base || !unlocked || variantMechanics(base) === variantMechanics(unlocked)) failures.push(`${costume.id}: potential ${index + 1} changes no typed mechanic`);
  }
  for (let burstLevel = 1; burstLevel <= (raw.burst ?? []).length; burstLevel += 1) {
    lineageChecks += 1;
    const previous = variantAt(costume, rawLevels.length - 1, burstLevel - 1, 0);
    const unlocked = variantAt(costume, rawLevels.length - 1, burstLevel, 0);
    if (!previous || !unlocked || variantMechanics(previous) === variantMechanics(unlocked)) failures.push(`${costume.id}: burst ${burstLevel} changes no typed mechanic`);
  }

  const baseVariant = variantAt(costume, rawLevels.length - 1, 0, 0);
  const duplicateEffectIds = duplicateUnconditionalEffectIds(baseVariant?.operations);
  lineageChecks += 1;
  if (duplicateEffectIds.length) failures.push(`${costume.id}: unconditional effects overwrite one another: ${duplicateEffectIds.join(", ")}`);
  const firstSourceDamageIndex = (raw.skill ?? []).findIndex((line) => hasImmediateDamageSentence([line]));
  const firstCompiledDamageIndex = (baseVariant?.operations ?? []).findIndex((entry) => directDamageOperations([entry]).length > 0);
  for (const [operationIndex, entry] of (baseVariant?.operations ?? []).entries()) {
    const match = entry.effect?.effect_id?.match(new RegExp(`^${costume.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:STAT:(\\d+)$`));
    if (!match || firstSourceDamageIndex < 0 || firstCompiledDamageIndex < 0) continue;
    lineageChecks += 1;
    const sourceBeforeDamage = Number(match[1]) < firstSourceDamageIndex;
    const compiledBeforeDamage = operationIndex < firstCompiledDamageIndex;
    if (sourceBeforeDamage !== compiledBeforeDamage) failures.push(`${costume.id}: stat effect order diverges from skill description`);
  }
  const magnitudes = numericMagnitudes(baseVariant?.operations ?? []);
  const placeholders = [...new Set([...(raw.skill ?? []).join(" ").matchAll(/\{([A-Z]+\d+)\}/g)].map((match) => match[1]))];
  for (const placeholder of placeholders) {
    const value = Math.abs(Number(rawLevels.at(-1)?.[placeholder]));
    lineageChecks += 1;
    if (Number.isFinite(value) && !magnitudes.includes(value) && !magnitudes.includes(value * 100)) failures.push(`${costume.id}: ${placeholder}=${value} has no typed operation value`);
  }
  const skillWithoutPlaceholders = (raw.skill ?? []).join(" ").replace(/\{[^}]+\}/g, "");
  const literalParameters = [...new Set([...skillWithoutPlaceholders.matchAll(/(?<![A-Za-z])\d+(?:\.\d+)?/g)].map((match) => Number(match[0])))];
  const derivedChainThresholds = sourceChainThresholds(baseVariant?.operations ?? []);
  for (const value of literalParameters.filter((parameter) => parameter !== 1)) {
    lineageChecks += 1;
    if (!magnitudes.includes(value) && !magnitudes.includes(value * 100) && !derivedChainThresholds.includes(value)) failures.push(`${costume.id}: literal skill parameter ${value} has no typed operation value`);
  }

  const immediateDamage = directDamageOperations(baseVariant?.operations ?? []);
  lineageChecks += 1;
  if (hasImmediateDamageSentence(raw.skill) !== (immediateDamage.length > 0)) failures.push(`${costume.id}: immediate damage was confused with a reaction or periodic effect`);
  if (raw.knockback) {
    const knockback = evidence.operations.find((entry) => entry.op === "KNOCKBACK");
    lineageChecks += 1;
    if (!knockback || knockback.direction !== rawKnockbackDirection(raw.knockback.postion) || knockback.distance !== rawInteger(raw.knockback.cells)) failures.push(`${costume.id}: skill knockback metadata was not preserved`);
  }
  if ((raw.summons ?? []).length) {
    const summoned = new Set(evidence.operations.filter((entry) => entry.op === "SUMMON").map((entry) => entry.character_id.replace(/^summon:/, "")));
    lineageChecks += 1;
    if ((raw.summons ?? []).some((summon) => !summoned.has(summon))) failures.push(`${costume.id}: summon membership was not preserved`);
  }
}

if (failures.length) {
  for (const failure of failures) console.error(failure);
  throw new Error(`catalog semantic validation failed with ${failures.length} error(s)`);
}

console.log(JSON.stringify({
  catalog: catalogPath,
  ruleset: catalog.ruleset_id,
  characters: Object.keys(catalog.characters).length,
  costumes: Object.keys(catalog.costumes).length,
  variants,
  blessings: blessingIds.length,
  lineageChecks,
  status: "ok",
}, null, 2));
