import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const catalog = JSON.parse(await readFile(resolve(root, "data/generated/catalog.json"), "utf8"));

function maxLoadout(characterId) {
  const character = catalog.characters[characterId];
  if (!character) throw new Error(`unknown character ${characterId}`);
  return character.costume_ids.map((costumeId) => {
    const costume = catalog.costumes[costumeId];
    return {
      costume_id: costumeId,
      enhancement: Math.max(...costume.variants.map((variant) => variant.enhancement)),
      burst_level: Math.max(...costume.variants.map((variant) => variant.burst_level)),
      potential_mask: 7,
      permanent_potential_enabled: true,
      costume_link_target: null,
    };
  });
}

function playerUnit(unitId, characterId, partyNo, position) {
  const costumeLoadout = maxLoadout(characterId);
  const cheapestFirst = costumeLoadout.map((loadout) => loadout.costume_id).sort((left, right) => {
    const minCost = (id) => Math.min(...catalog.costumes[id].variants.filter((variant) => variant.enhancement === 5 && variant.potential_mask === 7).map((variant) => variant.sp_cost));
    return minCost(left) - minCost(right) || left.localeCompare(right);
  });
  return {
    unit_id: unitId,
    character_id: characterId,
    side: "PLAYER",
    position,
    costume_loadout: costumeLoadout,
    stat_overrides: null,
    equipment_modifiers: {},
    ai_priority: cheapestFirst,
    party_no: partyNo,
    hp_owner: null,
    weak_point_bonus_bp: 0,
    can_act: true,
  };
}

function buildMonsterChaser(monsterId, startingLevel) {
  const monster = catalog.monsters[monsterId];
  if (!monster) throw new Error(`unknown current monster ${monsterId}`);
  const raw = monster.source.raw_payload;
  const levels = Object.keys(monster.stats_by_level).map(Number).sort((a, b) => a - b);
  const cumulativeHpByLevel = levels.map((level) => monster.stats_by_level[level].max_hp);
  const baseBossStats = { ...monster.stats_by_level[startingLevel] };
  const attackableParts = monster.parts.filter((part) => part.attackable);
  const hpOwner = 1001;
  const bossCostumes = monster.skill_ids.map((costumeId) => ({
    costume_id: costumeId,
    enhancement: 0,
    burst_level: 0,
    potential_mask: 0,
    permanent_potential_enabled: false,
    costume_link_target: null,
  }));
  const bossUnits = attackableParts.map((part, index) => ({
    unit_id: hpOwner + index,
    character_id: `fiend:${monsterId}`,
    side: "ENEMY",
    position: part.position,
    costume_loadout: index === 0 ? bossCostumes : [],
    stat_overrides: baseBossStats,
    equipment_modifiers: {},
    ai_priority: index === 0 ? monster.skill_ids : [],
    party_no: 1,
    hp_owner: index === 0 ? null : hpOwner,
    weak_point_bonus_bp: part.weak_point_bonus_bp,
    can_act: index === 0,
  }));
  const formation = [{ row: 0, depth: 0 }, { row: 1, depth: 0 }, { row: 2, depth: 0 }, { row: 0, depth: 1 }, { row: 2, depth: 1 }];
  const partyOne = ["Lathel", "Justia", "Scheherazade", "Gray", "Celia"];
  const partyTwo = ["Sylvia", "Rubia", "Eclipse", "Teresse", "Liatris"];
  const players = [
    ...partyOne.map((characterId, index) => playerUnit(1 + index, characterId, 1, formation[index])),
    ...partyTwo.map((characterId, index) => playerUnit(101 + index, characterId, 2, formation[index])),
  ];
  return {
    scenario_id: `monster-chaser-${monsterId}-level-${startingLevel}`,
    rules: {
      mode: "MONSTER_CHASER",
      grid: { rows: 3, depths: 4, deployment_limit: 5, blocked: [] },
      initial_sp: [raw.environment.spSetting.start, 0],
      sp_cap: null,
      recovery_after_team_turn: [0, 0],
      first_side: "PLAYER",
      max_game_turns: 20,
      chain_reset_on_team_turn: true,
      allow_formation_change: true,
      allow_manual_commands: [true, false],
    },
    units: [...players, ...bossUnits],
    monster_chaser: {
      monster_id: monsterId,
      cumulative_hp_by_level: cumulativeHpByLevel,
      selected_level: startingLevel,
      party_limit: startingLevel >= 6 ? 2 : 1,
      turn_sp_recovery: raw.environment.spSetting.recover,
    },
  };
}

const requestedMonsterId = process.argv[2] ?? "10072";
const requestedStartingLevel = Number(process.argv[3] ?? 6);
if (!Number.isInteger(requestedStartingLevel) || requestedStartingLevel < 1) throw new Error("starting level must be a positive integer");
const output = resolve(root, process.argv[4] ?? "data/scenarios/monster-chaser-current.json");
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(buildMonsterChaser(requestedMonsterId, requestedStartingLevel), null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output, ruleset: catalog.ruleset_id, monster: catalog.monsters[requestedMonsterId].names.ja, startingLevel: requestedStartingLevel, levels: Object.keys(catalog.monsters[requestedMonsterId].stats_by_level).length }, null, 2));
