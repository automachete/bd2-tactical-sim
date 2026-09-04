import { knockbackPresentation } from "./battle-ui-model";
import { t } from "./i18n";
import type {
  ActiveEffect,
  BattleCommand,
  BattleEvent,
  BattleUnit,
  Catalog,
  CharacterDefinition,
  CostumeDefinition,
  EntityDefinition,
} from "./types";

export type CommandPresentation = {
  name: string;
  sp_cost: number;
  cooldown: number;
  range: Array<{ row: number; depth: number }>;
  operation_summary: string;
  description_ja: string;
  glyph: string;
  selector?: string;
  target_all?: boolean;
  knockback_direction?: string;
  knockback_offset?: { row: number; depth: number };
  knockback_arrow?: string;
  knockback_distance?: number;
};

const ELEMENTS = new Set(["FIRE", "WATER", "WIND", "LIGHT", "DARK"]);
export const elementClass = (element: string | null | undefined): string => {
  if (!element) return "neutral";
  const normalized = element.toUpperCase();
  if (!ELEMENTS.has(normalized)) throw new Error(`Unsupported element: ${element}`);
  return normalized.toLowerCase();
};

export const portraitPath = (character: CharacterDefinition | EntityDefinition | undefined): string | null => (
  character?.rarity === 5 ? `/assets/character-icons/64/${encodeURIComponent(character.id)}.png` : null
);
export const initials = (character: CharacterDefinition | EntityDefinition | undefined): string => (
  String(character?.name ?? character?.id ?? t("unit.fiend")).trim().slice(0, 2).toUpperCase()
);
export const formatNumber = (value: number | null | undefined): string => Number(value ?? 0).toLocaleString("ja-JP");

export const entityById = (catalog: Catalog, id: string): CharacterDefinition | EntityDefinition | undefined => (
  catalog.characters.find((character) => character.id === id)
  ?? catalog.entities.find((entity) => entity.id === id)
);
export const costumeById = (catalog: Catalog, id: string): CostumeDefinition | undefined => (
  catalog.characters.flatMap((character) => character.costumes)
    .concat(catalog.system_costumes)
    .find((costume) => costume.id === id)
);

export const commandPresentation = (catalog: Catalog, unit: BattleUnit, command: BattleCommand | undefined): CommandPresentation => {
  if (!command) {
    return { name: t("action.cannotAct"), sp_cost: 0, cooldown: 0, range: [], operation_summary: "", description_ja: "", glyph: "—" };
  }
  if (command.type === "USE_COSTUME" && command.costume_id) {
    const costume = costumeById(catalog, command.costume_id);
    if (!costume) throw new Error(`catalog costume is missing for ${command.costume_id}`);
    return {
      name: costume.skill_name || costume.name,
      sp_cost: command.ui?.sp_cost ?? costume.sp_cost,
      cooldown: command.ui?.cooldown ?? costume.cooldown,
      range: command.ui?.range ?? costume.range,
      operation_summary: command.ui?.operation_summary ?? costume.operation_summary,
      description_ja: command.ui?.description_ja ?? costume.description_ja,
      glyph: "✦",
      selector: command.ui?.selector ?? costume.selector,
      target_all: command.ui?.target_all ?? costume.target_all,
    };
  }
  if (command.type === "NORMAL_ATTACK") {
    return { name: t("action.normal"), sp_cost: 0, cooldown: 0, range: [{ row: 0, depth: 0 }], operation_summary: t("action.normalSummary"), description_ja: "", glyph: "⚔" };
  }
  if (command.type === "KNOCKBACK") {
    const presentation = knockbackPresentation(
      command.ui?.knockback_direction,
      command.ui?.knockback_offset,
    );
    return {
      name: t("action.knockback"),
      sp_cost: 0,
      cooldown: 0,
      range: [{ row: 0, depth: 0 }],
      operation_summary: t("action.knockbackSummary", {
        direction: t(`knockback.${presentation.direction}`), arrow: presentation.arrow, distance: presentation.distance,
      }),
      description_ja: t("action.knockbackDescription", {
        direction: t(`knockback.${presentation.direction}`), distance: presentation.distance,
      }),
      glyph: presentation.arrow,
      knockback_direction: presentation.direction,
      knockback_offset: { row: presentation.row, depth: presentation.depth },
      knockback_arrow: presentation.arrow,
      knockback_distance: presentation.distance,
    };
  }
  return { name: command.type, sp_cost: 0, cooldown: 0, range: [], operation_summary: "", description_ja: "", glyph: "?" };
};

export const effectLabel = (effect: ActiveEffect): string => {
  const key = effect.kind ?? effect.type ?? "unknown";
  const duration = effect.remaining_turns === undefined ? "" : ` · ${t("effect.turns", { turns: effect.remaining_turns })}`;
  return `${t(`effect.${key}`)}${duration}`;
};

const eventValue = (kind: BattleEvent["kind"], key: string): string | number | undefined => {
  const value = kind[key];
  return typeof value === "string" || typeof value === "number" ? value : undefined;
};
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const eventBoolean = (kind: BattleEvent["kind"], key: string): boolean => kind[key] === true;
const cellText = (value: unknown): string => {
  if (!isRecord(value)) return t("event.unknown");
  return t("event.cell", { row: Number(value.row) + 1, depth: Number(value.depth) + 1 });
};
const commandText = (value: unknown): string => {
  if (!isRecord(value)) return t("selection.none");
  const type = typeof value.type === "string" ? value.type : "";
  if (type === "NORMAL_ATTACK") return t("action.normal");
  if (type === "KNOCKBACK") return t("action.knockback");
  if (type === "USE_COSTUME") return typeof value.costume_id === "string" ? value.costume_id : t("action.costume");
  return t("selection.none");
};
export const humanEvent = (event: BattleEvent, unitName: (unitId: number) => string): string => {
  const { kind } = event;
  const sequence = String(event.sequence).padStart(4, "0");
  const actor = Number(eventValue(kind, "actor_id"));
  const target = Number(eventValue(kind, "target_id") ?? eventValue(kind, "unit_id"));
  const side = (key = "side"): string => t(`battle.side.${String(eventValue(kind, key) ?? "")}`);
  let detail: string;
  switch (kind.type) {
    case "BATTLE_STARTED": detail = t("event.battleStarted", { side: side("first_side") }); break;
    case "INITIATIVE_ROLLED": detail = t("event.initiativeRolled", { side: side("first_side"), draw: Number(eventValue(kind, "draw_id")) }); break;
    case "ALL_TURN_STARTED": detail = t("event.allTurnStarted", { turn: Number(eventValue(kind, "all_turn")) }); break;
    case "ALL_TURN_ENDED": detail = t("event.allTurnEnded", { turn: Number(eventValue(kind, "all_turn")) }); break;
    case "BLESSING_ACTIVATED": detail = t("event.blessingActivated", { side: side(), blessing: String(eventValue(kind, "blessing_id") ?? ""), level: Number(eventValue(kind, "level")) }); break;
    case "DEATH_TIME_ADVANCED": detail = t("event.deathTimeAdvanced", { turn: Number(eventValue(kind, "all_turn")), stacks: Number(eventValue(kind, "stacks")) }); break;
    case "TURN_STARTED": detail = t("event.turnStarted", { turn: Number(eventValue(kind, "turn")), side: side(), sp: Number(eventValue(kind, "sp")) }); break;
    case "FORMATION_CHANGED": detail = t("event.formationChanged", { unit: unitName(target), from: cellText(kind.from), to: cellText(kind.to) }); break;
    case "ACTION_STARTED":
    case "ACTION_DECLARED": detail = t("event.actionStarted", { unit: unitName(actor), action: commandText(kind.command) }); break;
    case "ACTION_ENDED": detail = t("event.actionEnded", { unit: unitName(actor) }); break;
    case "TARGET_LOCKED": detail = t("event.targetLocked", { actor: unitName(actor), target: unitName(target) }); break;
    case "TARGET_CELL_LOCKED": detail = t("event.targetCellLocked", { actor: unitName(actor), cell: cellText(kind.cell) }); break;
    case "TARGET_AREA_RESOLVED": detail = t("event.targetAreaResolved", { actor: unitName(actor), cells: Array.isArray(kind.cells) ? kind.cells.length : 0, targets: Array.isArray(kind.target_ids) ? kind.target_ids.length : 0 }); break;
    case "RNG_ROLLED": detail = t("event.rng", { result: t(eventBoolean(kind, "success") ? "event.success" : "event.failure") }); break;
    case "DAMAGE_APPLIED": detail = t("event.damage", { actor: unitName(actor), target: unitName(target), amount: formatNumber(Number(eventValue(kind, "amount"))), critical: eventBoolean(kind, "critical") ? t("event.criticalSuffix") : "" }); break;
    case "DAMAGE_EVADED": detail = t("event.damageEvaded", { target: unitName(target) }); break;
    case "BARRIER_ABSORBED": detail = t("event.barrier", { target: unitName(target), amount: formatNumber(Number(eventValue(kind, "amount"))) }); break;
    case "HEAL_APPLIED": detail = t("event.heal", { actor: unitName(actor), target: unitName(target), amount: formatNumber(Number(eventValue(kind, "amount"))) }); break;
    case "EFFECT_APPLIED": detail = t("event.effectApplied", { target: unitName(target) }); break;
    case "EFFECT_EXPIRED": detail = t("event.effectExpired", { target: unitName(target) }); break;
    case "SP_CHANGED": detail = t("event.spChanged", { side: side(), before: Number(eventValue(kind, "before")), after: Number(eventValue(kind, "after")) }); break;
    case "COOLDOWN_CHANGED": detail = t("event.cooldownChanged", { unit: unitName(target), costume: String(eventValue(kind, "costume_id") ?? t("action.costume")), before: Number(eventValue(kind, "before")), after: Number(eventValue(kind, "after")) }); break;
    case "CHAIN_CHANGED":
    case "CHAIN_UPDATED": detail = t("event.chainChanged", { target: unitName(target), before: Number(eventValue(kind, "before")), after: Number(eventValue(kind, "after") ?? eventValue(kind, "value")) }); break;
    case "UNIT_MOVED": detail = t("event.unitMoved", { unit: unitName(target), from: cellText(kind.from), to: cellText(kind.to) }); break;
    case "COLLISION_DAMAGE": detail = t("event.collision", { moving: unitName(Number(eventValue(kind, "moving_id"))), occupant: unitName(Number(eventValue(kind, "occupant_id"))), amount: formatNumber(Number(eventValue(kind, "amount"))) }); break;
    case "ACTION_SKIPPED": detail = t("event.actionSkipped", { unit: unitName(actor) }); break;
    case "UNIT_DIED":
    case "UNIT_DEFEATED": detail = t("event.unitDied", { unit: unitName(target) }); break;
    case "UNIT_REVIVED": detail = t("event.unitRevived", { unit: unitName(target), hp: formatNumber(Number(eventValue(kind, "hp"))) }); break;
    case "UNIT_SUMMONED": detail = t("event.unitSummoned", { unit: unitName(target), cell: cellText(kind.position) }); break;
    case "MONSTER_PARTY_ACTIVATED": detail = t("event.partyActivated", { party: Number(eventValue(kind, "party_no")) }); break;
    case "MONSTER_LEVEL_ADVANCED": detail = t("event.levelAdvanced", { level: Number(eventValue(kind, "to_level")), amount: formatNumber(Number(eventValue(kind, "carry_damage"))) }); break;
    case "TURN_ENDED": detail = t("event.turnEnded", { turn: Number(eventValue(kind, "turn")), side: side() }); break;
    case "BATTLE_ENDED": {
      const result = isRecord(kind.result) && typeof kind.result.outcome === "string" ? kind.result.outcome : String(eventValue(kind, "result") ?? "");
      detail = t("event.battleEnded", { outcome: t(`battle.outcome.${result}`) });
      break;
    }
    default: detail = t("event.unknown");
  }
  return `${sequence}  ${detail}`;
};
