export type BattleMode = "NORMAL" | "MIRROR_WAR" | "MONSTER_CHASER" | "GOLDEN_COLOSSEUM";
export type Side = "PLAYER" | "ENEMY";
export type Element = "FIRE" | "WATER" | "WIND" | "LIGHT" | "DARK";
export type KnockbackDirection = "BACK" | "FRONT" | "UP" | "DOWN" | "UP_BACK" | "DOWN_BACK" | "UP_FRONT" | "DOWN_FRONT";
export type SetupSide = "player_units" | "enemy_units";

export type Cell = { row: number; depth: number };
export type Formation = Record<string, Cell>;
export type GridDefinition = {
  rows: number;
  depths: number;
  deployment_limit: number;
  blocked: Array<[number, number]>;
};

export type StatModifiers = Record<string, number>;
export type UnitStats = {
  max_hp: number;
  attack: number;
  magic: number;
  defense_bp: number;
  magic_resist_bp: number;
  crit_rate_bp: number;
  crit_damage_bp: number;
  property_damage_bp: number;
  amplification_bp: number;
  incoming_damage_bp: number;
  outgoing_damage_bp: number;
};

export type GoddessTearNode = { index: number; bit: number; available: boolean };
export type CostumeDefinition = {
  id: string;
  character_id: string;
  name: string;
  skill_name: string;
  description_ja: string;
  operation_summary: string;
  sp_cost: number;
  cooldown: number;
  selector: string;
  target_all: boolean;
  range: Cell[];
  max_enhancement: number;
  max_burst_level: number;
  max_potential_mask: number;
  goddess_tear_nodes: GoddessTearNode[];
  bonding_modifiers: StatModifiers;
  permanent_potential_modifiers: StatModifiers;
};

export type CharacterDefinition = {
  id: string;
  name: string;
  rarity: number;
  element: Element;
  attack_type: string;
  knockback_direction: string;
  level_100: UnitStats;
  costumes: CostumeDefinition[];
  awakening_modifiers: StatModifiers;
  engraving_modifiers: StatModifiers;
};

export type EntityDefinition = {
  id: string;
  name: string;
  element?: Element;
  rarity?: number;
  knockback_direction?: string;
};

export type CostumeLoadout = {
  costume_id: string;
  enhancement: number;
  burst_level: number;
  potential_mask: number;
  permanent_potential_enabled: boolean;
  enabled?: boolean;
};

export type EquipmentStatOption = {
  key: string;
  label: string;
  modifiers: StatModifiers;
};
export type EquipmentDefinition = {
  id: string;
  name: string;
  names: string[];
  kind: "CRAFTED_LEGENDARY" | "EXCLUSIVE";
  tier: string;
  slot: EquipmentSlot;
  owner_character_id: string | null;
  primary_stat_options: EquipmentStatOption[];
  secondary_stat_options: EquipmentStatOption[];
  allowed_substats: EquipmentStatOption[];
  modifiers_by_refinement_score: Record<string, StatModifiers>;
  primary_modifiers_by_refinement_score: Record<string, Record<string, StatModifiers>>;
  secondary_modifiers_by_refinement_score: Record<string, Record<string, StatModifiers>>;
};
export type EquipmentSlot = "WEAPON" | "ARMOR" | "HELMET" | "JEWELRY" | "GLOVES";
export type EquipmentLoadout = {
  equipment_id: string;
  refinement_score: number;
  primary_stat: string | null;
  secondary_stat: string | null;
  substats: string[];
};
export type Equipment = Partial<Record<EquipmentSlot, EquipmentLoadout>>;

export type BuildSettings = {
  awakening_enabled: boolean;
  engraving_enabled: boolean;
  collection: {
    attack_bp: number;
    magic_bp: number;
    max_hp_bp: number;
    crit_rate_bp: number;
  };
  external_buffs: {
    attack_bonus_bp: number;
    crit_rate_bp: number;
    crit_damage_bp: number;
    property_damage_bp: number;
    shield_flat: number;
    shield_percent_bp: number;
  };
  calculator: {
    damage_type: string;
    defense_type: string;
    elemental_advantage: boolean;
    world_buff_enabled: boolean;
    target_condition: {
      min_hp: number;
      min_defense_bp: number;
      min_magic_resist_bp: number;
    };
    option_count: number;
    gear_filters: Record<string, boolean>;
  };
};

export type SetupUnit = {
  character_id: string;
  row: number;
  depth: number;
  party_no: number;
  costumes: CostumeLoadout[];
  costume_link_target: string | null;
  equipment: Equipment;
  build_settings: BuildSettings;
};

export type BlessingLevel = { level: number; point_cost: number };
export type Blessing = {
  id: string;
  name: string;
  category: string;
  description_ja: string;
  levels: BlessingLevel[];
};
export type BlessingSelection = { blessing_id: string; level: number };
export type GoldenBlessingLoadout = { point_limit: number; selected: BlessingSelection[] };
export type GoldenSideBlessings = { going_first: GoldenBlessingLoadout; going_second: GoldenBlessingLoadout };
export type GoldenColosseumSetup = {
  season_label: string;
  weekly_attempts: number;
  refill_limit: number;
  starting_rating: number;
  undeployable_grid_count: number;
  death_time_all_turn: number;
  banned_costume_ids: string[];
  banned_blessing_ids: string[];
  side_blessings: [GoldenSideBlessings, GoldenSideBlessings];
};

export type BattleSetup = {
  mode: BattleMode;
  player_units: SetupUnit[];
  enemy_units: SetupUnit[];
  grid: GridDefinition;
  monster_level?: number;
  seed?: number;
  mcts_simulations?: number;
  mcts_rollout_depth?: number;
  mcts_max_branching?: number;
  golden_colosseum?: GoldenColosseumSetup;
};

export type CharacterProfile = {
  character_id: string;
  awakening_enabled: boolean;
  costumes: Array<Omit<CostumeLoadout, "enabled" | "permanent_potential_enabled">>;
  equipment: Equipment;
  is_default?: boolean;
};
export type CharacterProfileDocument = {
  schema_version: number;
  profiles: CharacterProfile[];
};

export type CommandUi = {
  sp_cost?: number;
  base_sp_cost?: number;
  burst_sp_cost?: number;
  cooldown?: number;
  selector?: string;
  target_all?: boolean;
  range?: Cell[];
  operation_summary?: string;
  description_ja?: string;
  knockback_direction?: KnockbackDirection;
  knockback_offset?: Cell;
  knockback_distance?: number;
};
export type BattleCommand = {
  type: string;
  costume_id?: string;
  burst_level?: number;
  explicit_target?: number | null;
  unavailable_reason?: string;
  cooldown_remaining?: number;
  ui?: CommandUi;
};
export type LegalActions = {
  unit_id: number;
  commands: BattleCommand[];
  unavailable_commands: BattleCommand[];
};

export type ActiveEffect = {
  type?: string;
  kind?: string;
  remaining_turns?: number;
  source_unit_id?: number;
  amount?: number;
  value?: number;
  modifiers?: StatModifiers;
};
export type BattleUnit = {
  id: number;
  character_id: string;
  side: Side;
  alive: boolean;
  can_act: boolean;
  hp: number;
  party_no: number;
  position: Cell;
  base_stats: UnitStats;
  effects: ActiveEffect[];
  cooldowns: Record<string, number>;
  costume_loadout: CostumeLoadout[];
  ai_priority: string[];
  is_summon: boolean;
  summoned_by: number | null;
  hp_owner: number | null;
  weak_point_bonus_bp: number;
  triggered_skill_uses: Record<string, number>;
  passive_modifiers: StatModifiers;
  external_energy_guard: number;
};
export type BattleTeam = {
  side: Side;
  sp: number;
  action_order: number[];
  chain_by_target: Record<string, number>;
};
export type ModeRules = {
  mode: BattleMode;
  grid: GridDefinition;
  allow_formation_change: boolean;
  allow_manual_commands: boolean;
  sp_cap: number;
  initial_sp: number;
  max_game_turns: number;
  first_side: Side;
  action_flow: string;
  recovery_after_team_turn: number;
  chain_reset_on_team_turn: boolean;
  cooldowns_disabled: boolean;
  sp_costs_bypassed: boolean;
};
export type MonsterChaserState = {
  current_party: number;
  current_level: number;
  selected_level: number;
  battle_hp_remaining: number;
  level_hp_segments: number[];
};
export type GoldenColosseumState = {
  all_turn: number;
  initiative: Side;
};
export type TerminalState = { outcome: string; reason: string };
export type BattleEvent = {
  sequence: number;
  turn?: number;
  side?: Side;
  kind: Record<string, unknown> & { type: string };
};
export type BattleState = {
  scenario_id: string;
  ruleset_id: string;
  rules: ModeRules;
  units: Record<string, BattleUnit>;
  teams: BattleTeam[];
  active_side: Side;
  game_turn: number;
  round_no: number;
  action_sequence: number;
  event_sequence: number;
  event_log: BattleEvent[];
  terminal: TerminalState | null;
  monster_chaser: MonsterChaserState | null;
  golden_colosseum: GoldenColosseumState | null;
  damage_by_source: Record<string, number>;
  next_effect_instance_id: number;
  rng: unknown;
};

export type AiReport = {
  controller: string;
  simulations?: number;
  candidates?: number;
  root_value?: number;
};
export type AutoPlan = { commands: Record<string, BattleCommand> };
export type SavedSetup = { name: string; scenario: string };
export type BattleSnapshot = {
  state: BattleState;
  legal: LegalActions[];
  seed: number;
  ruleset_id: string;
  enemy_controller: "MCTS" | "RULE_BASED" | "COLOSSEUM_AUTO";
  mcts: { simulations: number; rollout_depth: number; max_branching: number };
  last_ai: AiReport | null;
  auto_plan: AutoPlan | null;
  setup: BattleSetup;
  saved_setups: SavedSetup[];
  loaded_setup?: string;
  can_rollback: boolean;
};

export type PreviewResult = {
  actor_id: number;
  action_index: number;
  command: BattleCommand;
  resolved_command: BattleCommand | null;
  target_id: number | null;
  anchor: Cell | null;
  target_side: Side | null;
  affected_cells: Cell[];
  affected_unit_ids: number[];
  movements: Array<{ unit_id: number; from: Cell; to: Cell }>;
  actor_events: BattleEvent[];
  resolved_action_order: number[];
  damage_by_target: Array<{
    target_id: number;
    amount: number;
    absorbed: number;
    hits: number;
    critical_hits: number;
    evaded_hits: number;
    collision_damage: number;
  }>;
  total_damage: number;
};

export type MonsterSkill = { name: string; condition: string | null; operation_summary: string };
export type Catalog = {
  ruleset_id: string;
  characters: CharacterDefinition[];
  entities: EntityDefinition[];
  equipment: EquipmentDefinition[];
  blessings: Blessing[];
  monster_skills: MonsterSkill[];
  system_costumes: CostumeDefinition[];
  build_settings_default: BuildSettings;
  presets: Record<BattleMode, BattleSetup>;
};

export type ModeCapabilities = {
  formation: boolean;
  mctsOpponent: boolean;
  ruleBasedOpponent: boolean;
  automaticBattle: boolean;
  twoPlayerParties: boolean;
  manualPlayer: boolean;
};
