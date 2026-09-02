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
let variants = 0;
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
  }
  const variant = fullVariant(costume);
  const evidence = collectEvidence(variant);
  const semanticTags = String(costume.source?.raw_payload?.tags ?? "").split(",").filter(Boolean);
  for (const tag of semanticTags) {
    if (!hasSemanticEvidence(tag, costume, variant, evidence)) failures.push(`${costume.id}: tag '${tag}' has no typed evidence`);
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
  status: "ok",
}, null, 2));
