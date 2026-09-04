import { afterEach, describe, expect, test, vi } from "vitest";

import type { BattleApi, PreviewRequest } from "../src/lib/api";
import { CatalogState } from "../src/lib/state/catalog-state.svelte";
import { FeedbackState } from "../src/lib/state/feedback-state.svelte";
import { PlanningState } from "../src/lib/state/planning-state.svelte";
import { PlaybackState } from "../src/lib/state/playback-state.svelte";
import { SessionState } from "../src/lib/state/session-state.svelte";
import type {
  BattleSetup,
  BattleSnapshot,
  BattleUnit,
  BuildSettings,
  Catalog,
  CharacterDefinition,
  PreviewResult,
} from "../src/lib/types";

afterEach(() => vi.useRealTimers());

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
  costumes: [],
  awakening_modifiers: {},
  engraving_modifiers: {},
};

const setup: BattleSetup = {
  mode: "NORMAL",
  player_units: [],
  enemy_units: [],
  grid: { rows: 3, depths: 4, deployment_limit: 5, blocked: [] },
};

const catalogDocument: Catalog = {
  ruleset_id: "rules",
  characters: [character],
  entities: [],
  equipment: [],
  blessings: [],
  monster_skills: [],
  system_costumes: [],
  build_settings_default: buildSettings,
  presets: {
    NORMAL: setup,
    MIRROR_WAR: { ...setup, mode: "MIRROR_WAR" },
    MONSTER_CHASER: { ...setup, mode: "MONSTER_CHASER" },
    GOLDEN_COLOSSEUM: { ...setup, mode: "GOLDEN_COLOSSEUM" },
  },
};

const unit: BattleUnit = {
  id: 1,
  character_id: "hero",
  side: "PLAYER",
  alive: true,
  can_act: true,
  hp: 100,
  party_no: 1,
  position: { row: 0, depth: 0 },
  base_stats: character.level_100,
  effects: [],
  cooldowns: {},
  costume_loadout: [],
  ai_priority: [],
  is_summon: false,
  summoned_by: null,
  hp_owner: null,
  weak_point_bonus_bp: 0,
  triggered_skill_uses: {},
  passive_modifiers: {},
  external_energy_guard: 0,
};

const snapshot = (events: BattleSnapshot["state"]["event_log"] = []): BattleSnapshot => ({
  state: {
    scenario_id: "test",
    ruleset_id: "rules",
    rules: {
      mode: "NORMAL",
      grid: setup.grid,
      allow_formation_change: true,
      allow_manual_commands: true,
      sp_cap: 20,
      initial_sp: 5,
      max_game_turns: 10,
      first_side: "PLAYER",
      action_flow: "TEAM_TURN",
      recovery_after_team_turn: 1,
      chain_reset_on_team_turn: true,
      cooldowns_disabled: false,
      sp_costs_bypassed: false,
    },
    units: { "1": structuredClone(unit) },
    teams: [{ side: "PLAYER", sp: 5, action_order: [1], chain_by_target: {} }],
    active_side: "PLAYER",
    game_turn: 1,
    round_no: 1,
    action_sequence: 0,
    event_sequence: events.length,
    event_log: events,
    terminal: null,
    monster_chaser: null,
    golden_colosseum: null,
    damage_by_source: {},
    next_effect_instance_id: 1,
    rng: null,
  },
  legal: [{ unit_id: 1, commands: [{ type: "NORMAL_ATTACK" }], unavailable_commands: [] }],
  seed: 42,
  ruleset_id: "rules",
  enemy_controller: "MCTS",
  mcts: { simulations: 1, rollout_depth: 1, max_branching: 1 },
  last_ai: null,
  auto_plan: null,
  setup,
  saved_setups: [],
  can_rollback: false,
});

const preview = (damage: number): PreviewResult => ({
  anchor: { row: 0, depth: 0 },
  target_side: "ENEMY",
  affected_cells: [{ row: 0, depth: 0 }],
  affected_unit_ids: [],
  damage_by_target: [],
  total_damage: damage,
});

const unused = (): Promise<never> => Promise.reject(new Error("unused test API operation"));

describe("state async lifecycle", () => {
  test("aborts superseded previews, ignores stale results, and aborts on dispose", async () => {
    vi.useFakeTimers();
    const pending: Array<{
      request: PreviewRequest;
      signal: AbortSignal;
      resolve: (result: PreviewResult) => void;
    }> = [];
    const api: BattleApi = {
      catalog: unused,
      state: unused,
      profiles: unused,
      start: unused,
      reset: unused,
      step: unused,
      aiStep: unused,
      rollback: unused,
      preview: (request, signal) => new Promise((resolve) => pending.push({ request, signal, resolve })),
      saveSetup: unused,
      loadSetup: unused,
      saveProfile: unused,
      resetProfile: unused,
    };
    const catalog = new CatalogState();
    catalog.setCatalog(catalogDocument);
    const session = new SessionState(catalog);
    const initial = snapshot();
    session.setSnapshot(initial);
    const playback = new PlaybackState(session, catalog);
    const feedback = new FeedbackState();
    const planning = new PlanningState(api, catalog, session, playback, feedback);

    planning.applySnapshot(initial);
    await vi.advanceTimersByTimeAsync(120);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.request.unit_id).toBe(1);

    planning.requestPreview();
    expect(pending[0]?.signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(120);
    expect(pending).toHaveLength(2);
    pending[0]?.resolve(preview(10));
    await Promise.resolve();
    expect(planning.preview).toBeNull();
    pending[1]?.resolve(preview(20));
    await Promise.resolve();
    expect(planning.preview?.total_damage).toBe(20);

    planning.requestPreview();
    await vi.advanceTimersByTimeAsync(120);
    expect(pending).toHaveLength(3);
    planning.dispose();
    expect(pending[2]?.signal.aborted).toBe(true);
    expect(planning.previewPending).toBe(false);

    playback.dispose();
    feedback.dispose();
  });

  test("playback cancellation resolves active animation waits and prevents later mutation", async () => {
    vi.useFakeTimers();
    const catalog = new CatalogState();
    catalog.setCatalog(catalogDocument);
    const session = new SessionState(catalog);
    const before = snapshot();
    session.setSnapshot(before);
    const playback = new PlaybackState(session, catalog);
    const result = snapshot([{ sequence: 1, turn: 1, kind: { type: "ACTION_DECLARED", actor_id: 1 } }]);

    const completed = playback.playEvents(before, result, {});
    expect(playback.executing).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    playback.cancelPlayback();
    await expect(completed).resolves.toBe(false);
    expect(playback.executing).toBe(false);
    expect(playback.cue).toEqual({ title: "", detail: "", turn: "" });
    expect(vi.getTimerCount()).toBe(0);

    playback.dispose();
  });
});
