use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Deserializer, Serialize};

/// Deserialize an explicitly present nullable field. Serde normally treats a
/// missing `Option<T>` exactly like JSON `null`; battle data must distinguish
/// the verified absence of a mechanic from an omitted/unknown field.
fn required_option<'de, D, T>(deserializer: D) -> std::result::Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

pub type UnitId = u32;
pub type BasisPoints = i32;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Side {
    Player,
    Enemy,
}

impl Side {
    pub const fn opponent(self) -> Self {
        match self {
            Self::Player => Self::Enemy,
            Self::Enemy => Self::Player,
        }
    }

    pub const fn index(self) -> usize {
        match self {
            Self::Player => 0,
            Self::Enemy => 1,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Element {
    Fire,
    Water,
    Wind,
    Light,
    Dark,
}

impl Element {
    pub const fn factor_bp(self, defender: Self) -> BasisPoints {
        use Element::*;
        match (self, defender) {
            (Fire, Wind) | (Wind, Water) | (Water, Fire) | (Light, Dark) | (Dark, Light) => 15_000,
            (Fire, Water) | (Wind, Fire) | (Water, Wind) => 5_000,
            _ => 10_000,
        }
    }

    pub const fn is_advantageous_against(self, defender: Self) -> bool {
        use Element::*;
        matches!(
            (self, defender),
            (Fire, Wind) | (Wind, Water) | (Water, Fire) | (Light, Dark) | (Dark, Light)
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AttackType {
    Physical,
    Magical,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DamageKind {
    Physical,
    Magical,
    Fixed,
    HpConsumption,
    Collision,
    Dot,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TargetSelector {
    Front,
    Skip,
    SelfUnit,
    AllyFront,
    NextAllyInOrder,
    Explicit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cell {
    pub row: i8,
    pub depth: i8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Offset {
    pub row: i8,
    pub depth: i8,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GridDefinition {
    pub rows: i8,
    pub depths: i8,
    pub deployment_limit: usize,
    pub blocked: BTreeSet<(i8, i8)>,
}

impl GridDefinition {
    pub fn standard() -> Self {
        Self {
            rows: 3,
            depths: 4,
            deployment_limit: 5,
            blocked: BTreeSet::new(),
        }
    }

    pub fn contains(&self, cell: Cell) -> bool {
        cell.row >= 0
            && cell.row < self.rows
            && cell.depth >= 0
            && cell.depth < self.depths
            && !self.blocked.contains(&(cell.row, cell.depth))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Stats {
    pub max_hp: i64,
    pub attack: i64,
    pub magic: i64,
    pub crit_rate_bp: BasisPoints,
    pub crit_damage_bp: BasisPoints,
    pub defense_bp: BasisPoints,
    pub magic_resist_bp: BasisPoints,
    pub property_damage_bp: BasisPoints,
    pub outgoing_damage_bp: BasisPoints,
    pub incoming_damage_bp: BasisPoints,
    pub amplification_bp: BasisPoints,
}

impl Stats {
    pub fn validate(&self) -> bool {
        self.max_hp > 0 && self.attack >= 0 && self.magic >= 0
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CharacterDefinition {
    pub id: String,
    pub names: BTreeMap<String, String>,
    pub rarity: u8,
    pub element: Element,
    pub attack_type: AttackType,
    pub target_selector: TargetSelector,
    /// Direction used by the character's built-in knockback command. External
    /// data is normalized into the simulator's row/depth coordinate space.
    pub knockback_direction: KnockbackDirection,
    /// Unmodified level-100 stats. Engraving and awakening are kept separate
    /// because BD2DB lets a build enable or disable each progression source.
    pub level_100: Stats,
    pub engraving_modifiers: StatModifiers,
    pub awakening_modifiers: StatModifiers,
    pub costume_ids: Vec<String>,
    pub source: SourceRecord,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CostumeDefinition {
    pub id: String,
    pub character_id: String,
    pub names: BTreeMap<String, String>,
    /// Localized in-game skill names. Costume names remain in `names` because
    /// both are independently displayed by the official UI.
    pub skill_names: BTreeMap<String, String>,
    pub range: Vec<Offset>,
    pub variants: Vec<SkillVariant>,
    /// Permanent stat nodes unlocked in this costume's potential tree.
    pub permanent_potential_modifiers: StatModifiers,
    /// Stats granted when this costume is selected as the character's bond.
    pub bonding_modifiers: StatModifiers,
    /// False means that the source record is preserved but its prose has not
    /// yet been compiled into lossless executable operations. Such a costume
    /// is never exposed as a legal action.
    pub executable: bool,
    pub compile_diagnostics: Vec<String>,
    pub source: SourceRecord,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SkillVariant {
    pub enhancement: u8,
    pub burst_level: u8,
    pub potential_mask: u8,
    pub sp_cost: i32,
    pub cooldown: u16,
    pub selector: TargetSelector,
    #[serde(deserialize_with = "required_option")]
    pub fixed_target_cell: Option<Cell>,
    pub target_all: bool,
    #[serde(deserialize_with = "required_option")]
    pub range_override: Option<Vec<Offset>>,
    pub operations: Vec<SkillOperation>,
    pub consume_remaining_sp: bool,
    pub executable: bool,
    pub compile_diagnostics: Vec<String>,
    pub preemptive: bool,
    /// Optional encounter-AI trigger. Triggered skills are resolved immediately
    /// after the opposing action that makes this condition true.
    #[serde(deserialize_with = "required_option")]
    pub activation_condition: Option<SkillCondition>,
    /// Per Monster Chaser party activation cap for a triggered skill.
    #[serde(deserialize_with = "required_option")]
    pub max_uses_per_party: Option<u16>,
    /// One-based position in an encounter-controlled boss action cycle.
    #[serde(deserialize_with = "required_option")]
    pub ai_sequence_index: Option<u16>,
    /// Official Japanese in-game skill text with the selected enhancement,
    /// burst and potential values materialized. This is presentation data;
    /// executable behaviour remains defined exclusively by `operations`.
    pub description_ja: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "SCREAMING_SNAKE_CASE", deny_unknown_fields)]
pub enum SkillOperation {
    DealDamage {
        kind: DamageKind,
        coefficient_bp: BasisPoints,
        #[serde(deserialize_with = "required_option")]
        reference: Option<StatReference>,
        #[serde(deserialize_with = "required_option")]
        scaling: Option<DamageScaling>,
        hits: u16,
        can_crit: bool,
        can_evade: bool,
        chain_per_hit: u16,
        main_target_bonus_bp: BasisPoints,
    },
    Heal {
        coefficient_bp: BasisPoints,
        reference: StatReference,
        can_crit: bool,
        recipient: EffectRecipient,
    },
    ConsumeHp {
        coefficient_bp: BasisPoints,
        reference: StatReference,
        can_kill: bool,
    },
    ApplyEffect {
        effect: EffectSpec,
    },
    RemoveEffects {
        polarity: EffectPolarity,
        count: u16,
    },
    RemoveEffectsByTag {
        tag: String,
    },
    AbsorbEffectsAndApplyStacks {
        polarity: EffectPolarity,
        recipient: EffectRecipient,
        effect: EffectSpec,
        max_stacks: u16,
    },
    ExtendEffects {
        polarity: EffectPolarity,
        duration: u16,
        recipient: EffectRecipient,
    },
    ChangeCooldown {
        amount: i16,
        recipient: EffectRecipient,
    },
    ChangeCostumeCooldown {
        amount: i16,
        costume_id: String,
    },
    ChangeSp {
        amount: i32,
        side: EffectRecipient,
    },
    ChangeSpPerSuccessfulHit {
        amount: i32,
        side: EffectRecipient,
    },
    Knockback {
        direction: KnockbackDirection,
        distance: u8,
        collision_coefficient_bp: BasisPoints,
    },
    Conditional {
        condition: SkillCondition,
        operations: Vec<SkillOperation>,
    },
    InstantDeath {
        remove_beneficial_effects: bool,
    },
    Summon {
        character_id: String,
        costume_id: String,
        count: u8,
        enhancement: u8,
        inherit_summoner_stats: bool,
    },
    SelfDestruct,
    ApplyEffectPerMatchingEnemy {
        effect: EffectSpec,
        tag: String,
        stacks_per_unit: u16,
        max_stacks: u16,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DamageScaling {
    pub source: DamageScalingSource,
    pub coefficient_bp_per_unit: BasisPoints,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "SCREAMING_SNAKE_CASE", deny_unknown_fields)]
pub enum DamageScalingSource {
    TargetCount,
    TargetCountMinusOne,
    ActorEffectCount { polarity: EffectPolarity },
    TargetEffectCount { polarity: EffectPolarity },
    TargetTagStacks { tag: String },
    SkillSpCost,
    ExtraSpConsumed,
}

const fn default_true() -> bool {
    true
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum StatReference {
    Attack,
    Magic,
    MaxHp,
    CurrentHp,
    Fixed,
    TargetMaxHp,
    TargetCurrentHp,
    TargetAttack,
    TargetMagic,
    EnergyGuard,
    ReceivedDamage,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EffectRecipient {
    ActorSide,
    TargetSide,
    ActorTeam,
    OpponentTeam,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "SCREAMING_SNAKE_CASE", deny_unknown_fields)]
pub enum SkillCondition {
    Any {
        conditions: Vec<SkillCondition>,
    },
    All {
        conditions: Vec<SkillCondition>,
    },
    TargetChainAtLeast {
        value: u16,
    },
    TargetHpAtMost {
        percent_bp: BasisPoints,
    },
    ActorHpAtMost {
        percent_bp: BasisPoints,
    },
    TargetHasTag {
        tag: String,
    },
    TargetLacksTag {
        tag: String,
    },
    ActorHasTag {
        tag: String,
    },
    ActorLacksTag {
        tag: String,
    },
    IsMainTarget,
    IsNotMainTarget,
    TargetChainAtMost {
        value: u16,
    },
    TargetChainMultipleOf {
        value: u16,
    },
    TargetChainNotMultipleOf {
        value: u16,
    },
    TargetEffectCountAtLeast {
        polarity: EffectPolarity,
        value: u16,
    },
    TargetEffectCountAtMost {
        polarity: EffectPolarity,
        value: u16,
    },
    ActorEffectCountAtLeast {
        polarity: EffectPolarity,
        value: u16,
    },
    AnyOpponentChainAtLeast {
        value: u16,
    },
    TargetAttackType {
        attack_type: AttackType,
    },
    TargetNotAttackType {
        attack_type: AttackType,
    },
    TargetElement {
        element: Element,
    },
    TargetNotElement {
        element: Element,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum KnockbackDirection {
    Back,
    Front,
    Up,
    Down,
    UpBack,
    DownBack,
    UpFront,
    DownFront,
}

impl KnockbackDirection {
    pub const ALL: [Self; 8] = [
        Self::Back,
        Self::Front,
        Self::Up,
        Self::Down,
        Self::UpBack,
        Self::DownBack,
        Self::UpFront,
        Self::DownFront,
    ];

    /// Displacement in the same local `(row, depth)` coordinates used by the
    /// battle grid. Both sides keep their front edge at depth zero.
    pub const fn offset(self) -> Offset {
        match self {
            Self::Back => Offset { row: 0, depth: 1 },
            Self::Front => Offset { row: 0, depth: -1 },
            Self::Up => Offset { row: -1, depth: 0 },
            Self::Down => Offset { row: 1, depth: 0 },
            Self::UpBack => Offset { row: -1, depth: 1 },
            Self::DownBack => Offset { row: 1, depth: 1 },
            Self::UpFront => Offset { row: -1, depth: -1 },
            Self::DownFront => Offset { row: 1, depth: -1 },
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EffectPolarity {
    Beneficial,
    Harmful,
    Neutral,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DurationClock {
    GameTurn,
    AllTurn,
    Round,
    Action,
    Permanent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EffectSpec {
    pub effect_id: String,
    pub polarity: EffectPolarity,
    pub recipient: EffectRecipient,
    pub duration: u16,
    pub duration_clock: DurationClock,
    pub modifiers: StatModifiers,
    pub tags: BTreeSet<String>,
    pub stack_rule: StackRule,
    #[serde(deserialize_with = "required_option")]
    pub barrier: Option<BarrierSpec>,
    #[serde(deserialize_with = "required_option")]
    pub periodic: Option<PeriodicSpec>,
    #[serde(deserialize_with = "required_option")]
    pub charges: Option<u16>,
    /// Reduction applied to this effect's evasion probability after each
    /// successful evade. Some of Rou's evasion skills use this mechanic.
    pub evasion_decay_bp: BasisPoints,
    #[serde(deserialize_with = "required_option")]
    pub counter: Option<CounterSpec>,
    #[serde(deserialize_with = "required_option")]
    pub revive_hp_bp: Option<BasisPoints>,
    #[serde(deserialize_with = "required_option")]
    pub max_stacks: Option<u16>,
    pub conditional_outgoing: Vec<ConditionalDamageModifier>,
    #[serde(deserialize_with = "required_option")]
    pub on_hit_received_allies: Option<Box<EffectSpec>>,
    /// Typed operations resolved with the defender as actor and attacker as target.
    pub on_hit_received_operations: Vec<SkillOperation>,
    pub on_turn_end_operations: Vec<SkillOperation>,
    #[serde(deserialize_with = "required_option")]
    pub aura_allies: Option<Box<EffectSpec>>,
    #[serde(deserialize_with = "required_option")]
    pub aura_opponents: Option<Box<EffectSpec>>,
    #[serde(deserialize_with = "required_option")]
    pub on_chain_dealt: Option<Box<ChainTriggerSpec>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BarrierSpec {
    pub coefficient_bp: BasisPoints,
    pub reference: StatReference,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PeriodicSpec {
    pub kind: DamageKind,
    pub coefficient_bp: BasisPoints,
    pub reference: StatReference,
    pub stacks: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CounterSpec {
    pub kind: DamageKind,
    pub coefficient_bp: BasisPoints,
    pub reference: StatReference,
    pub target_all: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConditionalDamageModifier {
    pub condition: SkillCondition,
    pub amount_bp: BasisPoints,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChainTriggerSpec {
    pub stack_effect: Box<EffectSpec>,
    pub threshold: u16,
    pub threshold_effect: Box<EffectSpec>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
pub struct StatModifiers {
    pub max_hp_flat: i64,
    pub max_hp_bp: BasisPoints,
    pub attack_flat: i64,
    pub attack_bp: BasisPoints,
    pub magic_flat: i64,
    pub magic_bp: BasisPoints,
    pub defense_bp: BasisPoints,
    pub magic_resist_bp: BasisPoints,
    pub crit_rate_bp: BasisPoints,
    pub crit_damage_bp: BasisPoints,
    pub property_damage_bp: BasisPoints,
    pub outgoing_damage_bp: BasisPoints,
    pub incoming_damage_bp: BasisPoints,
    pub amplification_bp: BasisPoints,
    pub damage_reduction_bp: BasisPoints,
    pub physical_damage_reduction_bp: BasisPoints,
    pub magical_damage_reduction_bp: BasisPoints,
    pub physical_incoming_damage_bp: BasisPoints,
    pub magical_incoming_damage_bp: BasisPoints,
    pub fire_incoming_damage_bp: BasisPoints,
    pub water_incoming_damage_bp: BasisPoints,
    pub wind_incoming_damage_bp: BasisPoints,
    pub light_incoming_damage_bp: BasisPoints,
    pub dark_incoming_damage_bp: BasisPoints,
    pub dot_incoming_damage_bp: BasisPoints,
    pub chain_damage_incoming_bp: BasisPoints,
    pub evasion_bp: BasisPoints,
    pub sp_cost_delta: i32,
    pub cooldown_delta: i16,
    pub chain_received_delta: i16,
    pub chain_dealt_delta: i16,
    pub chain_retention: u16,
    pub normal_attack_damage_bp: BasisPoints,
    pub summon_incoming_damage_bp: BasisPoints,
    pub chain_damage_outgoing_bp: BasisPoints,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum StackRule {
    #[default]
    Independent,
    ReplaceSameSource,
    KeepStrongest,
    Extend,
    Accumulate,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct SourceRecord {
    pub source_id: String,
    pub source_url: String,
    pub observed_at: String,
    pub source_digest: String,
    pub raw_payload: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MonsterDefinition {
    pub id: String,
    pub names: BTreeMap<String, String>,
    pub element: Element,
    pub stats_by_level: BTreeMap<u8, Stats>,
    pub parts: Vec<MonsterPartDefinition>,
    pub skill_ids: Vec<String>,
    pub immunities: BTreeSet<String>,
    pub source: SourceRecord,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MonsterPartDefinition {
    pub id: String,
    pub position: Cell,
    pub attackable: bool,
    pub weak_point_bonus_bp: BasisPoints,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EquipmentSlot {
    Weapon,
    Armor,
    Helmet,
    Jewelry,
    Gloves,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EquipmentStat {
    MaxHpFlat,
    MaxHpPercent,
    AttackFlat,
    AttackPercent,
    MagicFlat,
    MagicPercent,
    Defense,
    MagicResist,
    CritRate,
    CritDamage,
}

/// One external-catalog equipment archetype.
///
/// The current simulator contains crafted UR IV (Legendary) equipment and
/// five-star character-exclusive UR equipment. Every accepted refinement
/// score and selectable exclusive main ability is materialized as an exact
/// modifier record at import time, so the battle core never guesses a live
/// game formula.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EquipmentDefinition {
    pub id: String,
    pub names: BTreeMap<String, String>,
    pub kind: EquipmentKind,
    /// BD2DB tier key (`UR4` or `EX UR`).
    pub tier: String,
    pub slot: EquipmentSlot,
    /// Character restriction for exclusive gear. Crafted Legendary gear uses
    /// `None`.
    #[serde(deserialize_with = "required_option")]
    pub owner_character_id: Option<String>,
    /// Fixed abilities, including the star-scaled exclusive ability, already
    /// materialized for every supported refinement score.
    pub modifiers_by_refinement_score: BTreeMap<u8, StatModifiers>,
    /// Exclusive gear exposes two independently selectable main abilities.
    /// Crafted Legendary gear keeps both lists empty because its main
    /// abilities are fixed in `modifiers_by_refinement_score`.
    pub primary_stat_options: Vec<EquipmentStat>,
    pub secondary_stat_options: Vec<EquipmentStat>,
    pub primary_modifiers_by_refinement_score: BTreeMap<u8, BTreeMap<EquipmentStat, StatModifiers>>,
    pub secondary_modifiers_by_refinement_score:
        BTreeMap<u8, BTreeMap<EquipmentStat, StatModifiers>>,
    pub allowed_substats: Vec<EquipmentStat>,
    pub substat_modifiers: BTreeMap<EquipmentStat, StatModifiers>,
    pub source: SourceRecord,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EquipmentLoadout {
    pub equipment_id: String,
    pub refinement_score: u8,
    #[serde(deserialize_with = "required_option")]
    pub primary_stat: Option<EquipmentStat>,
    #[serde(deserialize_with = "required_option")]
    pub secondary_stat: Option<EquipmentStat>,
    /// BrownDust2 UR equipment has exactly three independently rerollable
    /// secondary-stat slots. Duplicate stat kinds are legal.
    pub substats: Vec<EquipmentStat>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EquipmentKind {
    CraftedLegendary,
    Exclusive,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CalculatorDamageType {
    #[default]
    Normal,
    Fixed,
    HpShield,
    Hp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CalculatorDefenseType {
    #[default]
    None,
    Defense,
    MagicResist,
}

/// Account-wide collection bonuses used by all three current BD2DB
/// calculators. Values are basis points.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CollectionBonus {
    pub max_hp_bp: BasisPoints,
    pub attack_bp: BasisPoints,
    pub magic_bp: BasisPoints,
    pub crit_rate_bp: BasisPoints,
}

impl Default for CollectionBonus {
    fn default() -> Self {
        Self {
            max_hp_bp: 8_000,
            attack_bp: 8_000,
            magic_bp: 8_000,
            crit_rate_bp: 5_000,
        }
    }
}

/// Numeric result of BD2DB's external-buff picker. Keeping the normalized
/// values makes builds portable without depending on a user's BD2DB account.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct ExternalBuffSettings {
    pub attack_bonus_bp: BasisPoints,
    pub crit_rate_bp: BasisPoints,
    pub crit_damage_bp: BasisPoints,
    pub property_damage_bp: BasisPoints,
    pub shield_percent_bp: BasisPoints,
    pub shield_flat: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct CalculatorTargetCondition {
    pub min_hp: i64,
    pub min_defense_bp: BasisPoints,
    pub min_magic_resist_bp: BasisPoints,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CalculatorGearFilters {
    pub exclusive: bool,
    pub ur4: bool,
    pub ur3: bool,
    pub monster: bool,
}

impl Default for CalculatorGearFilters {
    fn default() -> Self {
        Self {
            exclusive: true,
            ur4: true,
            ur3: true,
            monster: true,
        }
    }
}

/// Evaluation-only inputs used by BD2DB's option and gear-combination
/// calculators. They do not override the actual skill, target, or elemental
/// rules executed by the battle simulator.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EquipmentCalculatorSettings {
    pub damage_type: CalculatorDamageType,
    pub elemental_advantage: bool,
    pub defense_type: CalculatorDefenseType,
    pub target_condition: CalculatorTargetCondition,
    pub option_count: u8,
    pub gear_filters: CalculatorGearFilters,
    pub world_buff_enabled: bool,
}

impl Default for EquipmentCalculatorSettings {
    fn default() -> Self {
        Self {
            damage_type: CalculatorDamageType::Normal,
            elemental_advantage: true,
            defense_type: CalculatorDefenseType::None,
            target_condition: CalculatorTargetCondition::default(),
            option_count: 15,
            gear_filters: CalculatorGearFilters::default(),
            world_buff_enabled: false,
        }
    }
}

/// Every non-equipment input that BD2DB applies to a character build.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UnitBuildSettings {
    pub engraving_enabled: bool,
    pub awakening_enabled: bool,
    pub collection: CollectionBonus,
    pub external_buffs: ExternalBuffSettings,
    pub calculator: EquipmentCalculatorSettings,
}

impl Default for UnitBuildSettings {
    fn default() -> Self {
        Self {
            engraving_enabled: true,
            awakening_enabled: true,
            collection: CollectionBonus::default(),
            external_buffs: ExternalBuffSettings::default(),
            calculator: EquipmentCalculatorSettings::default(),
        }
    }
}

impl UnitBuildSettings {
    /// Neutral settings for monsters, summons, and focused engine tests.
    pub fn unmodified() -> Self {
        Self {
            engraving_enabled: false,
            awakening_enabled: false,
            collection: CollectionBonus {
                max_hp_bp: 0,
                attack_bp: 0,
                magic_bp: 0,
                crit_rate_bp: 0,
            },
            external_buffs: ExternalBuffSettings::default(),
            calculator: EquipmentCalculatorSettings::default(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct Catalog {
    pub ruleset_id: String,
    pub characters: BTreeMap<String, CharacterDefinition>,
    pub costumes: BTreeMap<String, CostumeDefinition>,
    pub monsters: BTreeMap<String, MonsterDefinition>,
    pub equipment: BTreeMap<String, EquipmentDefinition>,
    pub blessings: BTreeMap<String, BlessingDefinition>,
    pub skills: BTreeMap<String, CostumeDefinition>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum BattleMode {
    Normal,
    MirrorWar,
    MonsterChaser,
    GoldenColosseum,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ActionFlow {
    TeamTurn,
    AlternatingCostume,
}

/// Current maximum shared skill points for every implemented BD2 battle mode.
pub const SP_CAP: i32 = 20;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModeRules {
    pub mode: BattleMode,
    pub grid: GridDefinition,
    pub initial_sp: [i32; 2],
    pub sp_cap: i32,
    pub recovery_after_team_turn: [i32; 2],
    pub first_side: Side,
    pub max_game_turns: u32,
    pub chain_reset_on_team_turn: bool,
    /// Golden Colosseum bypasses payment while keeping available-SP scaling at zero.
    pub sp_costs_bypassed: bool,
    /// Golden Colosseum skills never enter or consult the costume cooldown cycle.
    pub cooldowns_disabled: bool,
    pub action_flow: ActionFlow,
    pub allow_formation_change: bool,
    pub allow_manual_commands: [bool; 2],
}

impl ModeRules {
    pub fn normal() -> Self {
        Self {
            mode: BattleMode::Normal,
            grid: GridDefinition::standard(),
            initial_sp: [15, 0],
            sp_cap: SP_CAP,
            recovery_after_team_turn: [0, 0],
            first_side: Side::Player,
            max_game_turns: 50,
            chain_reset_on_team_turn: true,
            sp_costs_bypassed: false,
            cooldowns_disabled: false,
            action_flow: ActionFlow::TeamTurn,
            allow_formation_change: true,
            allow_manual_commands: [true, false],
        }
    }

    pub fn mirror_war() -> Self {
        Self {
            mode: BattleMode::MirrorWar,
            grid: GridDefinition::standard(),
            initial_sp: [5, 6],
            sp_cap: SP_CAP,
            recovery_after_team_turn: [6, 6],
            first_side: Side::Player,
            max_game_turns: 50,
            chain_reset_on_team_turn: true,
            sp_costs_bypassed: false,
            cooldowns_disabled: false,
            action_flow: ActionFlow::TeamTurn,
            allow_formation_change: false,
            allow_manual_commands: [false, false],
        }
    }

    pub fn monster_chaser() -> Self {
        let mut rules = Self::normal();
        rules.mode = BattleMode::MonsterChaser;
        rules.max_game_turns = 20;
        rules
    }

    pub fn golden_colosseum(grid: GridDefinition) -> Self {
        Self {
            mode: BattleMode::GoldenColosseum,
            grid,
            initial_sp: [0, 0],
            sp_cap: SP_CAP,
            recovery_after_team_turn: [0, 0],
            // Replaced by a deterministic initiative roll when the battle is created.
            first_side: Side::Player,
            // The public Golden Colosseum rules do not define a draw turn.
            // Keep the generic engine guard unreachable in practical play
            // instead of inventing a Colosseum-specific 50-turn limit.
            max_game_turns: u32::MAX,
            chain_reset_on_team_turn: false,
            sp_costs_bypassed: true,
            cooldowns_disabled: true,
            action_flow: ActionFlow::AlternatingCostume,
            allow_formation_change: false,
            allow_manual_commands: [false, false],
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum BlessingCategory {
    Offence,
    Defence,
    Utility,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum BlessingTarget {
    AllAllies,
    AllEnemies,
    FirstAlly,
    FirstEnemy,
    ThirdAlly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum BlessingDamageCondition {
    TargetHpAtLeast90,
    TargetHpAtMost90,
    TargetTaunted,
    TargetChainAtMost5,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "SCREAMING_SNAKE_CASE", deny_unknown_fields)]
pub enum BlessingEffect {
    TeamStats {
        modifiers: StatModifiers,
        #[serde(deserialize_with = "required_option")]
        element: Option<Element>,
        #[serde(deserialize_with = "required_option")]
        attack_type: Option<AttackType>,
    },
    PropertyBalance {
        property_damage_bp: BasisPoints,
        property_resistance_bp: BasisPoints,
    },
    CounterDamage {
        amount_bp: BasisPoints,
    },
    ExtraChain {
        stacks: u16,
    },
    ChainDamage {
        amount_bp_per_stack: BasisPoints,
    },
    TimedEffect {
        start_all_turn: u32,
        every_all_turn: bool,
        target: BlessingTarget,
        effect: Box<EffectSpec>,
    },
    Immunity {
        tags: BTreeSet<String>,
    },
    BuffRemovalImmunity,
    ForceFixedDamage,
    StatBoostPressure {
        amount_bp: BasisPoints,
    },
    ConditionalDamage {
        condition: BlessingDamageCondition,
        amount_bp: BasisPoints,
    },
    ChainCap {
        maximum: u16,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BlessingLevelDefinition {
    pub level: u8,
    pub point_cost: u8,
    pub effect: BlessingEffect,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BlessingDefinition {
    pub id: String,
    pub names: BTreeMap<String, String>,
    pub descriptions: BTreeMap<String, Vec<String>>,
    pub category: BlessingCategory,
    pub levels: Vec<BlessingLevelDefinition>,
    pub source: SourceRecord,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UnitSetup {
    pub unit_id: UnitId,
    pub character_id: String,
    pub side: Side,
    pub position: Cell,
    pub costume_loadout: Vec<CostumeLoadout>,
    #[serde(default)]
    pub build_settings: UnitBuildSettings,
    #[serde(default)]
    pub stat_overrides: Option<Stats>,
    #[serde(default)]
    pub equipment: BTreeMap<EquipmentSlot, EquipmentLoadout>,
    #[serde(default)]
    pub ai_priority: Vec<String>,
    /// Monster Chaser party number. Ordinary battles always use party 1.
    #[serde(default = "default_party_no")]
    pub party_no: u8,
    /// Optional HP pool owner for an attackable boss part.
    #[serde(default)]
    pub hp_owner: Option<UnitId>,
    /// Additional damage received by this boss part, in basis points.
    #[serde(default)]
    pub weak_point_bonus_bp: BasisPoints,
    /// Targetable board object that does not receive an action slot (for boss parts).
    #[serde(default = "default_true")]
    pub can_act: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CostumeLoadout {
    pub costume_id: String,
    pub enhancement: u8,
    pub burst_level: u8,
    #[serde(default = "default_potential_mask")]
    pub potential_mask: u8,
    /// Whether the non-skill stat nodes in this costume's potential tree are unlocked.
    #[serde(default)]
    pub permanent_potential_enabled: bool,
    /// At most one loadout entry may name the costume whose bond stats are active.
    #[serde(default)]
    pub costume_link_target: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BattleSetup {
    pub scenario_id: String,
    pub rules: ModeRules,
    pub units: Vec<UnitSetup>,
    #[serde(default)]
    pub monster_chaser: Option<MonsterChaserSetup>,
    #[serde(default)]
    pub golden_colosseum: Option<GoldenColosseumSetup>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BlessingSelection {
    pub blessing_id: String,
    pub level: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InitiativeBlessings {
    pub point_limit: u8,
    pub selected: Vec<BlessingSelection>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GoldenColosseumSideSetup {
    pub going_first: InitiativeBlessings,
    pub going_second: InitiativeBlessings,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GoldenColosseumSetup {
    pub season_label: String,
    /// Base battle entries granted for one weekly season.
    pub weekly_attempts: u16,
    /// Number of full-attempt refills that may be purchased during the season.
    pub refill_limit: u8,
    /// Rating assigned when the season begins.
    pub starting_rating: u16,
    /// The rotating rule specifies the number, while `rules.grid.blocked`
    /// stores the concrete cells for this battle/formation realization.
    pub undeployable_grid_count: u8,
    pub death_time_all_turn: u32,
    pub banned_costume_ids: BTreeSet<String>,
    pub banned_blessing_ids: BTreeSet<String>,
    pub side_blessings: [GoldenColosseumSideSetup; 2],
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MonsterChaserSetup {
    pub monster_id: String,
    /// Cumulative damage thresholds displayed as each selectable boss level's HP.
    pub cumulative_hp_by_level: Vec<i64>,
    pub selected_level: u8,
    pub party_limit: u8,
    pub turn_sp_recovery: i32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActiveEffect {
    pub instance_id: u64,
    pub source_unit_id: UnitId,
    pub spec: EffectSpec,
    pub remaining: u16,
    pub barrier_remaining: i64,
    #[serde(deserialize_with = "required_option")]
    pub charges_remaining: Option<u16>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UnitState {
    pub id: UnitId,
    pub character_id: String,
    pub side: Side,
    pub position: Cell,
    pub alive: bool,
    pub hp: i64,
    pub base_stats: Stats,
    /// Permanent/equipment combat modifiers that are not baked into `base_stats`.
    ///
    /// HP, attack, magic and the fields represented directly by `Stats` are
    /// applied once while the unit is created.  Runtime-only modifiers such as
    /// damage reduction, evasion, SP/CT adjustment and chain rules must remain
    /// available to the battle resolver for the whole encounter.
    pub passive_modifiers: StatModifiers,
    pub costume_loadout: Vec<CostumeLoadout>,
    pub cooldowns: BTreeMap<String, u16>,
    pub effects: Vec<ActiveEffect>,
    /// Remaining external energy guard configured through BD2DB's shield
    /// inputs. It is kept separate from skill effects so the exact normalized
    /// flat/percent source values remain a build input rather than a fake skill.
    pub external_energy_guard: i64,
    pub ai_priority: Vec<String>,
    pub party_no: u8,
    #[serde(deserialize_with = "required_option")]
    pub hp_owner: Option<UnitId>,
    pub weak_point_bonus_bp: BasisPoints,
    pub is_summon: bool,
    #[serde(deserialize_with = "required_option")]
    pub summoned_by: Option<UnitId>,
    pub triggered_skill_uses: BTreeMap<String, u16>,
    pub can_act: bool,
}

const fn default_party_no() -> u8 {
    1
}
const fn default_potential_mask() -> u8 {
    0b111
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TeamState {
    pub side: Side,
    pub sp: i32,
    pub action_order: Vec<UnitId>,
    pub chain_by_target: BTreeMap<UnitId, u16>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MonsterChaserState {
    pub monster_id: String,
    pub selected_level: u8,
    pub current_level: u8,
    pub battle_hp_remaining: i64,
    pub segment_hp_remaining: i64,
    pub level_hp_segments: Vec<i64>,
    pub cumulative_damage: i64,
    pub current_party: u8,
    pub party_limit: u8,
    pub turn_sp_recovery: i32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GoldenColosseumState {
    pub season_label: String,
    pub initiative: Side,
    pub all_turn: u32,
    pub next_action_index: [usize; 2],
    pub death_time_all_turn: u32,
    pub death_time_stacks: u32,
    /// Loadouts selected after the initiative roll. Some timed Blessings are
    /// selected now but do not activate until a later ALL turn.
    pub active_blessings: [Vec<BlessingSelection>; 2],
    /// Blessings whose activation point has been reached, in application
    /// order. Passive effects must consult this list so the initiative-side
    /// ordering remains observable.
    pub activated_blessings: [Vec<BlessingSelection>; 2],
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BattleState {
    pub ruleset_id: String,
    pub scenario_id: String,
    pub rules: ModeRules,
    pub active_side: Side,
    pub game_turn: u32,
    pub round_no: u32,
    pub action_sequence: u64,
    pub event_sequence: u64,
    pub units: BTreeMap<UnitId, UnitState>,
    pub teams: [TeamState; 2],
    pub event_log: Vec<BattleEvent>,
    pub damage_by_source: BTreeMap<UnitId, i64>,
    pub rng: crate::DeterministicRng,
    #[serde(deserialize_with = "required_option")]
    pub terminal: Option<TerminalResult>,
    #[serde(deserialize_with = "required_option")]
    pub monster_chaser: Option<MonsterChaserState>,
    #[serde(deserialize_with = "required_option")]
    pub golden_colosseum: Option<GoldenColosseumState>,
    pub next_effect_instance_id: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TeamTurnPlan {
    pub side: Side,
    pub order: Vec<UnitId>,
    pub commands: BTreeMap<UnitId, UnitCommand>,
    #[serde(default)]
    pub formation: BTreeMap<UnitId, Cell>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "SCREAMING_SNAKE_CASE", deny_unknown_fields)]
pub enum UnitCommand {
    NormalAttack,
    Knockback,
    UseCostume {
        costume_id: String,
        burst_level: u8,
        #[serde(default)]
        explicit_target: Option<UnitId>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LegalUnitActions {
    pub unit_id: UnitId,
    pub commands: Vec<UnitCommand>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Transition {
    pub events: Vec<BattleEvent>,
    pub terminal: Option<TerminalResult>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BattleEvent {
    pub sequence: u64,
    pub kind: BattleEventKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum BattleEventKind {
    BattleStarted {
        first_side: Side,
    },
    InitiativeRolled {
        first_side: Side,
        draw_id: u64,
    },
    AllTurnStarted {
        all_turn: u32,
    },
    AllTurnEnded {
        all_turn: u32,
    },
    BlessingActivated {
        side: Side,
        blessing_id: String,
        level: u8,
    },
    DeathTimeAdvanced {
        all_turn: u32,
        stacks: u32,
    },
    TurnStarted {
        side: Side,
        turn: u32,
        sp: i32,
    },
    FormationChanged {
        unit_id: UnitId,
        from: Cell,
        to: Cell,
    },
    ActionStarted {
        actor_id: UnitId,
        command: UnitCommand,
    },
    ActionEnded {
        actor_id: UnitId,
    },
    TargetLocked {
        actor_id: UnitId,
        target_id: UnitId,
    },
    TargetCellLocked {
        actor_id: UnitId,
        cell: Cell,
    },
    TargetAreaResolved {
        actor_id: UnitId,
        target_side: Side,
        anchor: Cell,
        cells: Vec<Cell>,
        target_ids: Vec<UnitId>,
    },
    RngRolled {
        draw_id: u64,
        purpose: String,
        threshold_bp: i32,
        success: bool,
    },
    DamageApplied {
        actor_id: UnitId,
        target_id: UnitId,
        amount: i64,
        hp_before: i64,
        hp_after: i64,
        critical: bool,
        hit: u16,
    },
    DamageEvaded {
        actor_id: UnitId,
        target_id: UnitId,
        draw_id: u64,
    },
    BarrierAbsorbed {
        target_id: UnitId,
        effect_id: String,
        amount: i64,
        remaining: i64,
    },
    HealApplied {
        actor_id: UnitId,
        target_id: UnitId,
        amount: i64,
        hp_before: i64,
        hp_after: i64,
    },
    EffectApplied {
        source_id: UnitId,
        target_id: UnitId,
        effect_id: String,
        instance_id: u64,
    },
    EffectExpired {
        target_id: UnitId,
        effect_id: String,
        instance_id: u64,
    },
    SpChanged {
        side: Side,
        before: i32,
        after: i32,
        reason: String,
    },
    CooldownChanged {
        unit_id: UnitId,
        costume_id: String,
        before: u16,
        after: u16,
    },
    ChainChanged {
        side: Side,
        target_id: UnitId,
        before: u16,
        after: u16,
    },
    UnitMoved {
        unit_id: UnitId,
        from: Cell,
        to: Cell,
    },
    CollisionDamage {
        source_id: UnitId,
        moving_id: UnitId,
        occupant_id: UnitId,
        amount: i64,
    },
    ActionSkipped {
        actor_id: UnitId,
        reason: String,
    },
    UnitDied {
        unit_id: UnitId,
    },
    UnitRevived {
        unit_id: UnitId,
        hp: i64,
    },
    UnitSummoned {
        source_id: UnitId,
        unit_id: UnitId,
        character_id: String,
        position: Cell,
    },
    MonsterPartyActivated {
        party_no: u8,
        unit_ids: Vec<UnitId>,
    },
    MonsterLevelAdvanced {
        from_level: u8,
        to_level: u8,
        carry_damage: i64,
    },
    TurnEnded {
        side: Side,
        turn: u32,
    },
    BattleEnded {
        result: TerminalResult,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Outcome {
    Win,
    Loss,
    Draw,
    ScoreOnly,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalResult {
    pub outcome: Outcome,
    pub reason: String,
    pub turns: u32,
    pub damage_by_source: BTreeMap<String, i64>,
    #[serde(deserialize_with = "required_option")]
    pub defeated_boss_level: Option<u8>,
    pub carry_damage: i64,
    pub mode_score: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Observation {
    pub active_side: Side,
    pub turn: u32,
    pub round: u32,
    pub sp: [i32; 2],
    pub units: Vec<UnitObservation>,
    pub action_mask: Vec<Vec<bool>>,
    pub terminal: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UnitObservation {
    pub id: UnitId,
    pub side: Side,
    pub alive: bool,
    pub hp_ratio: f32,
    pub row: i8,
    pub depth: i8,
    pub cooldowns: Vec<u16>,
    pub effect_count: usize,
}
