use std::collections::BTreeMap;

use bd2_core::{
    ActiveEffect, AttackType, BattleEngine, BattleMode, DamageKind, DurationClock, EffectPolarity,
    EffectRecipient, Element, KnockbackDirection, Side, StackRule, StatModifiers, StatReference,
    Stats, TargetSelector, UnitCommand, UnitId,
};
use serde::Serialize;

pub const MAX_UNITS: usize = 32;
pub const UNIT_FEATURES: usize = 89;
pub const MAX_TEAM: usize = 11;
pub const MAX_ACTIONS: usize = 80;
pub const ACTION_FEATURES: usize = 50;
pub const GLOBAL_FEATURES: usize = 44;
pub const MAX_COSTUMES: usize = 20;
pub const COSTUME_FEATURES: usize = 14;
pub const MAX_EFFECTS: usize = 256;
pub const EFFECT_FEATURES: usize = 94;
pub const MONSTER_FEATURES: usize = 14;
pub const MAX_MONSTER_LEVELS: usize = 25;
pub const MONSTER_LEVEL_FEATURES: usize = 3;
pub const GOLDEN_FEATURES: usize = 15;
pub const MAX_BLESSINGS: usize = 64;
pub const BLESSING_FEATURES: usize = 12;
pub const MAX_GRID: usize = 5;
pub const GRID_FEATURES: usize = 5;

type FeatureMatrix = Vec<Vec<f32>>;
type FeatureTensor = Vec<FeatureMatrix>;
type MaskMatrix = Vec<Vec<bool>>;
type ActionObservation = (FeatureTensor, MaskMatrix, Vec<usize>);
type MonsterObservation = (Vec<f32>, FeatureMatrix, Vec<bool>);
type GoldenObservation = (Vec<f32>, FeatureTensor, MaskMatrix);
type TeamOrderObservation = (Vec<Vec<usize>>, MaskMatrix);

#[derive(Serialize)]
pub struct TrainingFrame {
    pub units: Vec<Vec<f32>>,
    pub unit_mask: Vec<bool>,
    pub costumes: Vec<Vec<Vec<f32>>>,
    pub costume_mask: Vec<Vec<bool>>,
    pub effects: Vec<Vec<f32>>,
    pub effect_mask: Vec<bool>,
    pub global: Vec<f32>,
    pub monster: Vec<f32>,
    pub monster_levels: Vec<Vec<f32>>,
    pub monster_level_mask: Vec<bool>,
    pub golden: Vec<f32>,
    pub blessings: Vec<Vec<Vec<f32>>>,
    pub blessing_mask: Vec<Vec<bool>>,
    pub grid: Vec<Vec<Vec<f32>>>,
    pub action_features: Vec<Vec<Vec<f32>>>,
    pub action_mask: Vec<Vec<bool>>,
    pub actor_indices: Vec<usize>,
    pub team_order_indices: Vec<Vec<usize>>,
    pub team_order_mask: Vec<Vec<bool>>,
}

pub fn training_frame(engine: &BattleEngine, side: Side) -> Result<TrainingFrame, String> {
    let state = engine.state();
    ensure_capacity("units", state.units.len(), MAX_UNITS)?;
    for team in &state.teams {
        ensure_capacity("team action order", team.action_order.len(), MAX_TEAM)?;
    }
    if usize::try_from(state.rules.grid.rows).unwrap_or(MAX_GRID + 1) > MAX_GRID
        || usize::try_from(state.rules.grid.depths).unwrap_or(MAX_GRID + 1) > MAX_GRID
    {
        return Err(format!(
            "grid {}x{} exceeds observation capacity {}x{}",
            state.rules.grid.rows, state.rules.grid.depths, MAX_GRID, MAX_GRID
        ));
    }

    let mut unit_index_by_id = BTreeMap::new();
    for (index, unit) in state.units.values().enumerate() {
        unit_index_by_id.insert(unit.id, index);
    }

    let mut units = vec![vec![0.0; UNIT_FEATURES]; MAX_UNITS];
    let mut unit_mask = vec![false; MAX_UNITS];
    let mut costumes = vec![vec![vec![0.0; COSTUME_FEATURES]; MAX_COSTUMES]; MAX_UNITS];
    let mut costume_mask = vec![vec![false; MAX_COSTUMES]; MAX_UNITS];
    for (index, unit) in state.units.values().enumerate() {
        let character = engine
            .catalog()
            .characters
            .get(&unit.character_id)
            .ok_or_else(|| {
                format!(
                    "unit {} references unknown character '{}'",
                    unit.id, unit.character_id
                )
            })?;
        let effective_stats = engine
            .effective_stats_for_unit(unit.id)
            .map_err(|error| error.to_string())?;
        let effective_modifiers = engine
            .effective_modifiers_for_unit(unit.id)
            .map_err(|error| error.to_string())?;
        let mut features = Vec::with_capacity(UNIT_FEATURES);
        features.push(if unit.side == side { 1.0 } else { -1.0 });
        features.push(bool_f32(unit.alive));
        features.push(log_value(unit.hp));
        features.push(unit.hp as f32 / effective_stats.max_hp.max(1) as f32);
        features.push(unit.position.row as f32 / state.rules.grid.rows.max(1) as f32);
        features.push(unit.position.depth as f32 / state.rules.grid.depths.max(1) as f32);
        features.extend(stable_id_features(&unit.character_id));
        push_element(&mut features, character.element);
        push_attack_type(&mut features, character.attack_type);
        push_stats(&mut features, &unit.base_stats);
        push_stats(&mut features, &effective_stats);
        push_modifiers(&mut features, &effective_modifiers);
        features.push(unit.external_energy_guard as f32 / effective_stats.max_hp.max(1) as f32);
        features.push(unit.party_no as f32 / 10.0);
        features.push(bool_f32(state.monster_chaser.as_ref().is_none_or(
            |monster| unit.side == Side::Enemy || unit.party_no == monster.current_party,
        )));
        features.push(unit_reference_feature(unit.hp_owner, &unit_index_by_id)?);
        features.push(unit.weak_point_bonus_bp as f32 / 10_000.0);
        features.push(bool_f32(unit.is_summon));
        features.push(unit_reference_feature(unit.summoned_by, &unit_index_by_id)?);
        features.push(bool_f32(unit.can_act));
        features.push(log_value(
            state.damage_by_source.get(&unit.id).copied().unwrap_or(0),
        ));
        features.push(order_rank(state, side, unit.id));
        features.push(order_rank(state, side.opponent(), unit.id));
        features.push(
            state.teams[side.index()]
                .chain_by_target
                .get(&unit.id)
                .copied()
                .unwrap_or(0) as f32
                / 50.0,
        );
        features.push(
            state.teams[side.opponent().index()]
                .chain_by_target
                .get(&unit.id)
                .copied()
                .unwrap_or(0) as f32
                / 50.0,
        );
        features.push(unit.effects.len() as f32 / MAX_EFFECTS as f32);
        features.push(unit.costume_loadout.len() as f32 / MAX_COSTUMES as f32);
        exact_len("unit features", &features, UNIT_FEATURES)?;
        units[index] = features;
        unit_mask[index] = true;

        ensure_capacity(
            &format!("unit {} costume loadout", unit.id),
            unit.costume_loadout.len(),
            MAX_COSTUMES,
        )?;
        for (costume_index, loadout) in unit.costume_loadout.iter().enumerate() {
            let mut value = Vec::with_capacity(COSTUME_FEATURES);
            value.extend(stable_id_features(&loadout.costume_id));
            value.push(loadout.enhancement as f32 / 5.0);
            value.push(loadout.burst_level as f32 / 3.0);
            for bit in 0..3 {
                value.push(bool_f32(loadout.potential_mask & (1 << bit) != 0));
            }
            value.push(bool_f32(loadout.permanent_potential_enabled));
            value.push(
                unit.cooldowns
                    .get(&loadout.costume_id)
                    .copied()
                    .ok_or_else(|| {
                        format!(
                            "unit {} has no cooldown state for '{}'",
                            unit.id, loadout.costume_id
                        )
                    })? as f32
                    / 20.0,
            );
            value.push(
                unit.triggered_skill_uses
                    .get(&loadout.costume_id)
                    .copied()
                    .unwrap_or(0) as f32
                    / 20.0,
            );
            value.push(
                unit.ai_priority
                    .iter()
                    .position(|id| id == &loadout.costume_id)
                    .map(|rank| (rank + 1) as f32 / MAX_COSTUMES as f32)
                    .unwrap_or(0.0),
            );
            value.push(bool_f32(loadout.costume_link_target.is_some()));
            exact_len("costume features", &value, COSTUME_FEATURES)?;
            costumes[index][costume_index] = value;
            costume_mask[index][costume_index] = true;
        }
    }

    let total_effects: usize = state.units.values().map(|unit| unit.effects.len()).sum();
    ensure_capacity("active effects", total_effects, MAX_EFFECTS)?;
    let mut effects = vec![vec![0.0; EFFECT_FEATURES]; MAX_EFFECTS];
    let mut effect_mask = vec![false; MAX_EFFECTS];
    let mut effect_index = 0;
    for unit in state.units.values() {
        for effect in &unit.effects {
            effects[effect_index] = effect_features(effect, unit.id, &unit_index_by_id)?;
            effect_mask[effect_index] = true;
            effect_index += 1;
        }
    }

    let (action_features, action_mask, actor_indices) =
        action_observation(engine, side, &unit_index_by_id)?;
    let (team_order_indices, team_order_mask) = team_orders(state, side, &unit_index_by_id)?;
    let global = global_features(engine, side, total_effects)?;
    let (monster, monster_levels, monster_level_mask) = monster_features(engine)?;
    let (golden, blessings, blessing_mask) = golden_features(engine, side)?;
    let grid = grid_features(engine, side, &unit_index_by_id)?;

    Ok(TrainingFrame {
        units,
        unit_mask,
        costumes,
        costume_mask,
        effects,
        effect_mask,
        global,
        monster,
        monster_levels,
        monster_level_mask,
        golden,
        blessings,
        blessing_mask,
        grid,
        action_features,
        action_mask,
        actor_indices,
        team_order_indices,
        team_order_mask,
    })
}

fn action_observation(
    engine: &BattleEngine,
    side: Side,
    unit_indices: &BTreeMap<UnitId, usize>,
) -> Result<ActionObservation, String> {
    let state = engine.state();
    let order = &state.teams[side.index()].action_order;
    let mut features = vec![vec![vec![0.0; ACTION_FEATURES]; MAX_ACTIONS]; MAX_TEAM];
    let mut mask = vec![vec![false; MAX_ACTIONS]; MAX_TEAM];
    let mut actors = vec![MAX_UNITS; MAX_TEAM];
    if state.rules.action_flow == bd2_core::ActionFlow::AlternatingCostume {
        for slot in 0..MAX_TEAM {
            features[slot][0][49] = 1.0;
            mask[slot][0] = true;
        }
    }
    for (slot, unit_id) in order.iter().enumerate() {
        actors[slot] = *unit_indices
            .get(unit_id)
            .ok_or_else(|| format!("action order references unobserved unit {unit_id}"))?;
        if state.rules.action_flow == bd2_core::ActionFlow::AlternatingCostume {
            continue;
        }
        let legal = engine
            .legal_actions_for_unit(*unit_id)
            .map_err(|error| error.to_string())?;
        ensure_capacity(
            &format!("unit {unit_id} legal actions"),
            legal.commands.len(),
            MAX_ACTIONS,
        )?;
        if legal.commands.is_empty() {
            // Dead and temporarily inactive units remain in action_order so
            // revival preserves their position.  Their placeholder is not a
            // game command: Python omits the slot when submitting the plan.
            features[slot][0][49] = 1.0;
            mask[slot][0] = true;
            continue;
        }
        for (action_index, command) in legal.commands.iter().enumerate() {
            features[slot][action_index] =
                command_features(engine, *unit_id, command, unit_indices)?;
            mask[slot][action_index] = true;
        }
    }
    for slot in order.len()..MAX_TEAM {
        mask[slot][0] = true;
        features[slot][0][49] = 1.0;
    }
    Ok((features, mask, actors))
}

fn command_features(
    engine: &BattleEngine,
    unit_id: UnitId,
    command: &UnitCommand,
    unit_indices: &BTreeMap<UnitId, usize>,
) -> Result<Vec<f32>, String> {
    let state = engine.state();
    let unit = state
        .units
        .get(&unit_id)
        .ok_or_else(|| format!("legal action references missing unit {unit_id}"))?;
    let character = engine
        .catalog()
        .characters
        .get(&unit.character_id)
        .ok_or_else(|| {
            format!(
                "unit {unit_id} references unknown character '{}'",
                unit.character_id
            )
        })?;
    let mut result = vec![0.0; ACTION_FEATURES];
    match command {
        UnitCommand::NormalAttack => {
            result[0] = 1.0;
            result[16 + selector_index(character.target_selector)] = 1.0;
        }
        UnitCommand::Knockback => {
            result[1] = 1.0;
            result[16 + selector_index(character.target_selector)] = 1.0;
            result[38 + knockback_index(character.knockback_direction)] = 1.0;
        }
        UnitCommand::UseCostume {
            costume_id,
            burst_level,
            explicit_target,
        } => {
            result[2] = 1.0;
            result[3..7].copy_from_slice(&stable_id_features(costume_id));
            result[7] = *burst_level as f32 / 3.0;
            result[8] = unit_reference_feature(*explicit_target, unit_indices)?;
            let loadout = unit
                .costume_loadout
                .iter()
                .find(|item| item.costume_id == *costume_id)
                .ok_or_else(|| format!("unit {unit_id} has no loadout for '{costume_id}'"))?;
            let costume = engine
                .catalog()
                .costumes
                .get(costume_id)
                .ok_or_else(|| format!("catalog has no costume '{costume_id}'"))?;
            let variant = costume
                .variants
                .iter()
                .find(|variant| {
                    variant.enhancement == loadout.enhancement
                        && variant.burst_level == *burst_level
                        && variant.potential_mask == loadout.potential_mask
                })
                .ok_or_else(|| format!("catalog has no exact variant for '{costume_id}'"))?;
            let modifiers = engine
                .effective_modifiers_for_unit(unit_id)
                .map_err(|error| error.to_string())?;
            result[9] = (variant.sp_cost + modifiers.sp_cost_delta).max(0) as f32 / 20.0;
            result[10] = variant.sp_cost as f32 / 20.0;
            result[11] =
                (variant.cooldown as i32 + modifiers.cooldown_delta as i32).max(0) as f32 / 20.0;
            result[12] = bool_f32(variant.consume_remaining_sp);
            result[13] = bool_f32(variant.preemptive);
            result[14] = bool_f32(variant.executable);
            result[15] = bool_f32(variant.target_all);
            result[16 + selector_index(variant.selector)] = 1.0;
            if let Some(cell) = variant.fixed_target_cell {
                result[22] = 1.0;
                result[23] = cell.row as f32 / state.rules.grid.rows.max(1) as f32;
                result[24] = cell.depth as f32 / state.rules.grid.depths.max(1) as f32;
            }
            let range = variant.range_override.as_ref().unwrap_or(&costume.range);
            result[25] = range.len() as f32 / 25.0;
            if !range.is_empty() {
                result[26] = range.iter().map(|offset| offset.row).min().unwrap() as f32 / 5.0;
                result[27] = range.iter().map(|offset| offset.row).max().unwrap() as f32 / 5.0;
                result[28] = range.iter().map(|offset| offset.depth).min().unwrap() as f32 / 5.0;
                result[29] = range.iter().map(|offset| offset.depth).max().unwrap() as f32 / 5.0;
            }
            result[30..34].copy_from_slice(&stable_hash_features(range));
            result[34..38].copy_from_slice(&stable_hash_features(&variant.operations));
            result[46] = bool_f32(variant.activation_condition.is_some());
            result[47] = variant.max_uses_per_party.unwrap_or(0) as f32 / 20.0;
            result[48] = variant.ai_sequence_index.unwrap_or(0) as f32 / 20.0;
        }
    }
    Ok(result)
}

fn effect_features(
    effect: &ActiveEffect,
    owner_id: UnitId,
    unit_indices: &BTreeMap<UnitId, usize>,
) -> Result<Vec<f32>, String> {
    let spec = &effect.spec;
    let mut value = Vec::with_capacity(EFFECT_FEATURES);
    value.push(unit_reference_feature(Some(owner_id), unit_indices)?);
    value.push(unit_reference_feature(
        Some(effect.source_unit_id),
        unit_indices,
    )?);
    value.extend(stable_id_features(&spec.effect_id));
    value.extend(stable_hash_features(spec));
    value.push((effect.instance_id & 0xffff) as f32 / 65_535.0);
    value.push(((effect.instance_id >> 16) & 0xffff) as f32 / 65_535.0);
    value.push(effect.remaining as f32 / 100.0);
    value.push(log_value(effect.barrier_remaining));
    value.push(bool_f32(effect.charges_remaining.is_some()));
    value.push(effect.charges_remaining.unwrap_or(0) as f32 / 100.0);
    value.push(polarity_index(spec.polarity) as f32 / 2.0);
    value.push(recipient_index(spec.recipient) as f32 / 3.0);
    value.push(spec.duration as f32 / 100.0);
    value.push(duration_index(spec.duration_clock) as f32 / 4.0);
    value.push(stack_index(spec.stack_rule) as f32 / 4.0);
    value.push(spec.evasion_decay_bp as f32 / 10_000.0);
    value.push(bool_f32(spec.revive_hp_bp.is_some()));
    value.push(spec.revive_hp_bp.unwrap_or(0) as f32 / 10_000.0);
    value.push(bool_f32(spec.max_stacks.is_some()));
    value.push(spec.max_stacks.unwrap_or(0) as f32 / 100.0);
    value.push(bool_f32(spec.barrier.is_some()));
    value.push(
        spec.barrier
            .as_ref()
            .map_or(0.0, |barrier| barrier.coefficient_bp as f32 / 10_000.0),
    );
    value.push(spec.barrier.as_ref().map_or(0.0, |barrier| {
        reference_index(barrier.reference) as f32 / 10.0
    }));
    value.push(bool_f32(spec.periodic.is_some()));
    value.push(
        spec.periodic
            .as_ref()
            .map_or(0.0, |periodic| damage_index(periodic.kind) as f32 / 5.0),
    );
    value.push(
        spec.periodic
            .as_ref()
            .map_or(0.0, |periodic| periodic.coefficient_bp as f32 / 10_000.0),
    );
    value.push(spec.periodic.as_ref().map_or(0.0, |periodic| {
        reference_index(periodic.reference) as f32 / 10.0
    }));
    value.push(
        spec.periodic
            .as_ref()
            .map_or(0.0, |periodic| periodic.stacks as f32 / 100.0),
    );
    value.push(bool_f32(spec.counter.is_some()));
    value.push(
        spec.counter
            .as_ref()
            .map_or(0.0, |counter| damage_index(counter.kind) as f32 / 5.0),
    );
    value.push(
        spec.counter
            .as_ref()
            .map_or(0.0, |counter| counter.coefficient_bp as f32 / 10_000.0),
    );
    value.push(spec.counter.as_ref().map_or(0.0, |counter| {
        reference_index(counter.reference) as f32 / 10.0
    }));
    value.push(bool_f32(
        spec.counter
            .as_ref()
            .is_some_and(|counter| counter.target_all),
    ));
    value.push(spec.conditional_outgoing.len() as f32 / 20.0);
    value.push(bool_f32(spec.on_hit_received_allies.is_some()));
    value.push(spec.on_hit_received_operations.len() as f32 / 20.0);
    value.push(spec.on_turn_end_operations.len() as f32 / 20.0);
    value.push(bool_f32(spec.aura_allies.is_some()));
    value.push(bool_f32(spec.aura_opponents.is_some()));
    value.push(bool_f32(spec.on_chain_dealt.is_some()));
    value.push(spec.tags.len() as f32 / 20.0);
    push_modifiers(&mut value, &spec.modifiers);
    for tag in [
        "SILENCE",
        "TAUNT",
        "FOCUS",
        "EVASION",
        "MARK",
        "ENERGY_GUARD",
        "BARRIER",
        "TRANSFORMATION",
        "ACCELERATION",
        "COUNTER",
        "REVIVE",
        "DOT",
    ] {
        value.push(bool_f32(spec.tags.contains(tag)));
    }
    exact_len("effect features", &value, EFFECT_FEATURES)?;
    Ok(value)
}

fn global_features(
    engine: &BattleEngine,
    side: Side,
    total_effects: usize,
) -> Result<Vec<f32>, String> {
    let state = engine.state();
    let mut value = Vec::with_capacity(GLOBAL_FEATURES);
    for mode in [
        BattleMode::Normal,
        BattleMode::MirrorWar,
        BattleMode::MonsterChaser,
        BattleMode::GoldenColosseum,
    ] {
        value.push(bool_f32(state.rules.mode == mode));
    }
    value.push(if state.active_side == side { 1.0 } else { -1.0 });
    value.push(if state.rules.max_game_turns == u32::MAX {
        0.0
    } else {
        state.game_turn as f32 / state.rules.max_game_turns.max(1) as f32
    });
    value.push(state.round_no as f32 / 50.0);
    value.push(log_value(state.action_sequence as i64));
    value.push(log_value(state.event_sequence as i64));
    value.push(log_value(state.next_effect_instance_id as i64));
    let cap = state.rules.sp_cap.max(1) as f32;
    value.push(state.teams[side.index()].sp as f32 / cap);
    value.push(state.teams[side.opponent().index()].sp as f32 / cap);
    value.push(state.rules.sp_cap as f32 / 20.0);
    value.push(state.rules.recovery_after_team_turn[side.index()] as f32 / 20.0);
    value.push(state.rules.recovery_after_team_turn[side.opponent().index()] as f32 / 20.0);
    value.push(if state.rules.first_side == side {
        1.0
    } else {
        -1.0
    });
    value.push((state.rules.max_game_turns as f32).ln_1p() / 25.0);
    value.push(bool_f32(state.rules.chain_reset_on_team_turn));
    value.push(bool_f32(state.rules.sp_costs_bypassed));
    value.push(bool_f32(state.rules.cooldowns_disabled));
    value.push(bool_f32(
        state.rules.action_flow == bd2_core::ActionFlow::TeamTurn,
    ));
    value.push(bool_f32(
        state.rules.action_flow == bd2_core::ActionFlow::AlternatingCostume,
    ));
    value.push(bool_f32(state.rules.allow_formation_change));
    value.push(bool_f32(state.rules.allow_manual_commands[side.index()]));
    value.push(bool_f32(
        state.rules.allow_manual_commands[side.opponent().index()],
    ));
    value.push(state.rules.grid.rows as f32 / MAX_GRID as f32);
    value.push(state.rules.grid.depths as f32 / MAX_GRID as f32);
    value.push(state.rules.grid.deployment_limit as f32 / MAX_TEAM as f32);
    value.push(state.rules.grid.blocked.len() as f32 / (MAX_GRID * MAX_GRID) as f32);
    for observed_side in [side, side.opponent()] {
        value.push(
            state
                .units
                .values()
                .filter(|unit| unit.side == observed_side && unit.alive)
                .count() as f32
                / MAX_UNITS as f32,
        );
    }
    value.push(total_effects as f32 / MAX_EFFECTS as f32);
    value.push(
        state
            .units
            .values()
            .map(|unit| unit.costume_loadout.len())
            .sum::<usize>() as f32
            / (MAX_UNITS * MAX_COSTUMES) as f32,
    );
    value.push(bool_f32(state.terminal.is_some()));
    for outcome in [
        bd2_core::Outcome::Win,
        bd2_core::Outcome::Loss,
        bd2_core::Outcome::Draw,
        bd2_core::Outcome::ScoreOnly,
    ] {
        value.push(bool_f32(
            state
                .terminal
                .as_ref()
                .is_some_and(|terminal| terminal.outcome == outcome),
        ));
    }
    value.push(state.terminal.as_ref().map_or(0.0, |terminal| {
        terminal.turns as f32 / state.rules.max_game_turns.max(1) as f32
    }));
    value.push(
        state
            .terminal
            .as_ref()
            .map_or(0.0, |terminal| log_value(terminal.carry_damage)),
    );
    value.push(
        state
            .terminal
            .as_ref()
            .map_or(0.0, |terminal| log_value(terminal.mode_score)),
    );
    value.push(
        state
            .terminal
            .as_ref()
            .and_then(|terminal| terminal.defeated_boss_level)
            .unwrap_or(0) as f32
            / 25.0,
    );
    value.push(bool_f32(state.monster_chaser.is_some()));
    value.push(bool_f32(state.golden_colosseum.is_some()));
    exact_len("global features", &value, GLOBAL_FEATURES)?;
    Ok(value)
}

fn monster_features(engine: &BattleEngine) -> Result<MonsterObservation, String> {
    let mut value = vec![0.0; MONSTER_FEATURES];
    let mut levels = vec![vec![0.0; MONSTER_LEVEL_FEATURES]; MAX_MONSTER_LEVELS];
    let mut mask = vec![false; MAX_MONSTER_LEVELS];
    if let Some(monster) = &engine.state().monster_chaser {
        ensure_capacity(
            "Monster Chaser HP levels",
            monster.level_hp_segments.len(),
            MAX_MONSTER_LEVELS,
        )?;
        value[0] = 1.0;
        value[1..5].copy_from_slice(&stable_id_features(&monster.monster_id));
        value[5] = monster.selected_level as f32 / 25.0;
        value[6] = monster.current_level as f32 / 25.0;
        value[7] = log_value(monster.battle_hp_remaining);
        value[8] = log_value(monster.segment_hp_remaining);
        value[9] = log_value(monster.cumulative_damage);
        value[10] = monster.current_party as f32 / 10.0;
        value[11] = monster.party_limit as f32 / 10.0;
        value[12] = monster.turn_sp_recovery as f32 / 20.0;
        value[13] = monster.level_hp_segments.len() as f32 / MAX_MONSTER_LEVELS as f32;
        for (index, segment) in monster.level_hp_segments.iter().enumerate() {
            levels[index] = vec![
                log_value(*segment),
                if index + 1 == monster.current_level as usize {
                    log_value(monster.segment_hp_remaining)
                } else {
                    0.0
                },
                if index + 1 < monster.current_level as usize {
                    -1.0
                } else if index + 1 == monster.current_level as usize {
                    0.0
                } else {
                    1.0
                },
            ];
            mask[index] = true;
        }
    }
    Ok((value, levels, mask))
}

fn golden_features(engine: &BattleEngine, side: Side) -> Result<GoldenObservation, String> {
    let mut value = vec![0.0; GOLDEN_FEATURES];
    let mut blessings = vec![vec![vec![0.0; BLESSING_FEATURES]; MAX_BLESSINGS]; 2];
    let mut mask = vec![vec![false; MAX_BLESSINGS]; 2];
    if let Some(golden) = &engine.state().golden_colosseum {
        value[0] = 1.0;
        value[1..5].copy_from_slice(&stable_id_features(&golden.season_label));
        value[5] = if golden.initiative == side { 1.0 } else { -1.0 };
        value[6] = golden.all_turn as f32 / 100.0;
        value[7] = golden.next_action_index[side.index()] as f32 / MAX_TEAM as f32;
        value[8] = golden.next_action_index[side.opponent().index()] as f32 / MAX_TEAM as f32;
        value[9] = golden.death_time_all_turn as f32 / 100.0;
        value[10] = golden.death_time_stacks as f32 / 100.0;
        for (relative_index, observed_side) in [side, side.opponent()].into_iter().enumerate() {
            let selected = &golden.active_blessings[observed_side.index()];
            let activated = &golden.activated_blessings[observed_side.index()];
            ensure_capacity(
                "Golden Colosseum selected blessings",
                selected.len(),
                MAX_BLESSINGS,
            )?;
            ensure_capacity(
                "Golden Colosseum activated blessings",
                activated.len(),
                MAX_BLESSINGS,
            )?;
            value[11 + relative_index] = selected.len() as f32 / MAX_BLESSINGS as f32;
            value[13 + relative_index] = activated.len() as f32 / MAX_BLESSINGS as f32;
            for (index, selection) in selected.iter().enumerate() {
                let definition = engine
                    .catalog()
                    .blessings
                    .get(&selection.blessing_id)
                    .ok_or_else(|| format!("unknown blessing '{}'", selection.blessing_id))?;
                let activated_rank = activated.iter().position(|item| item == selection);
                let mut row = Vec::with_capacity(BLESSING_FEATURES);
                row.extend(stable_id_features(&selection.blessing_id));
                row.push(selection.level as f32 / 5.0);
                row.push((index + 1) as f32 / MAX_BLESSINGS as f32);
                row.push(bool_f32(activated_rank.is_some()));
                row.push(
                    activated_rank
                        .map(|rank| (rank + 1) as f32 / MAX_BLESSINGS as f32)
                        .unwrap_or(0.0),
                );
                row.extend(stable_hash_features(definition));
                exact_len("blessing features", &row, BLESSING_FEATURES)?;
                blessings[relative_index][index] = row;
                mask[relative_index][index] = true;
            }
        }
    }
    Ok((value, blessings, mask))
}

fn grid_features(
    engine: &BattleEngine,
    side: Side,
    unit_indices: &BTreeMap<UnitId, usize>,
) -> Result<Vec<Vec<Vec<f32>>>, String> {
    let state = engine.state();
    let mut grid = vec![vec![vec![0.0; GRID_FEATURES]; MAX_GRID]; MAX_GRID];
    for (row, row_features) in grid.iter_mut().enumerate() {
        for (depth, cell_features) in row_features.iter_mut().enumerate() {
            let inside =
                row < state.rules.grid.rows as usize && depth < state.rules.grid.depths as usize;
            let blocked = inside && state.rules.grid.blocked.contains(&(row as i8, depth as i8));
            cell_features[0] = bool_f32(inside);
            cell_features[1] = bool_f32(blocked);
            for unit in state.units.values().filter(|unit| {
                unit.alive && unit.position.row == row as i8 && unit.position.depth == depth as i8
            }) {
                let observed_index = *unit_indices
                    .get(&unit.id)
                    .ok_or_else(|| format!("grid references unobserved unit {}", unit.id))?;
                let offset = if unit.side == side { 2 } else { 3 };
                cell_features[offset] = (observed_index + 1) as f32 / (MAX_UNITS + 1) as f32;
                cell_features[4] += 1.0;
            }
        }
    }
    Ok(grid)
}

fn team_orders(
    state: &bd2_core::BattleState,
    side: Side,
    indices: &BTreeMap<UnitId, usize>,
) -> Result<TeamOrderObservation, String> {
    let mut orders = vec![vec![MAX_UNITS; MAX_TEAM]; 2];
    let mut masks = vec![vec![false; MAX_TEAM]; 2];
    for (relative, observed_side) in [side, side.opponent()].into_iter().enumerate() {
        for (slot, unit_id) in state.teams[observed_side.index()]
            .action_order
            .iter()
            .enumerate()
        {
            orders[relative][slot] = *indices
                .get(unit_id)
                .ok_or_else(|| format!("team order references unobserved unit {unit_id}"))?;
            masks[relative][slot] = true;
        }
    }
    Ok((orders, masks))
}

fn push_stats(target: &mut Vec<f32>, stats: &Stats) {
    target.push(log_value(stats.max_hp));
    target.push(log_value(stats.attack));
    target.push(log_value(stats.magic));
    target.push(stats.crit_rate_bp as f32 / 10_000.0);
    target.push(stats.crit_damage_bp as f32 / 10_000.0);
    target.push(stats.defense_bp as f32 / 10_000.0);
    target.push(stats.magic_resist_bp as f32 / 10_000.0);
    target.push(stats.property_damage_bp as f32 / 10_000.0);
    target.push(stats.outgoing_damage_bp as f32 / 10_000.0);
    target.push(stats.incoming_damage_bp as f32 / 10_000.0);
    target.push(stats.amplification_bp as f32 / 10_000.0);
}

fn push_modifiers(target: &mut Vec<f32>, value: &StatModifiers) {
    target.extend([
        log_value(value.max_hp_flat),
        value.max_hp_bp as f32 / 10_000.0,
        log_value(value.attack_flat),
        value.attack_bp as f32 / 10_000.0,
        log_value(value.magic_flat),
        value.magic_bp as f32 / 10_000.0,
        value.defense_bp as f32 / 10_000.0,
        value.magic_resist_bp as f32 / 10_000.0,
        value.crit_rate_bp as f32 / 10_000.0,
        value.crit_damage_bp as f32 / 10_000.0,
        value.property_damage_bp as f32 / 10_000.0,
        value.outgoing_damage_bp as f32 / 10_000.0,
        value.incoming_damage_bp as f32 / 10_000.0,
        value.amplification_bp as f32 / 10_000.0,
        value.damage_reduction_bp as f32 / 10_000.0,
        value.physical_damage_reduction_bp as f32 / 10_000.0,
        value.magical_damage_reduction_bp as f32 / 10_000.0,
        value.physical_incoming_damage_bp as f32 / 10_000.0,
        value.magical_incoming_damage_bp as f32 / 10_000.0,
        value.fire_incoming_damage_bp as f32 / 10_000.0,
        value.water_incoming_damage_bp as f32 / 10_000.0,
        value.wind_incoming_damage_bp as f32 / 10_000.0,
        value.light_incoming_damage_bp as f32 / 10_000.0,
        value.dark_incoming_damage_bp as f32 / 10_000.0,
        value.dot_incoming_damage_bp as f32 / 10_000.0,
        value.chain_damage_incoming_bp as f32 / 10_000.0,
        value.evasion_bp as f32 / 10_000.0,
        value.sp_cost_delta as f32 / 20.0,
        value.cooldown_delta as f32 / 20.0,
        value.chain_received_delta as f32 / 20.0,
        value.chain_dealt_delta as f32 / 20.0,
        value.chain_retention as f32 / 50.0,
        value.normal_attack_damage_bp as f32 / 10_000.0,
        value.summon_incoming_damage_bp as f32 / 10_000.0,
        value.chain_damage_outgoing_bp as f32 / 10_000.0,
    ]);
}

fn push_element(target: &mut Vec<f32>, value: Element) {
    for item in [
        Element::Fire,
        Element::Water,
        Element::Wind,
        Element::Light,
        Element::Dark,
    ] {
        target.push(bool_f32(value == item));
    }
}

fn push_attack_type(target: &mut Vec<f32>, value: AttackType) {
    target.push(bool_f32(value == AttackType::Physical));
    target.push(bool_f32(value == AttackType::Magical));
}

fn stable_id_features(value: &str) -> [f32; 4] {
    hash_parts(fnv1a(value.as_bytes()))
}
fn stable_hash_features(value: &impl Serialize) -> [f32; 4] {
    hash_parts(fnv1a(
        &serde_json::to_vec(value).expect("serializable observation metadata"),
    ))
}
fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x1000_0000_01b3)
    })
}
fn hash_parts(value: u64) -> [f32; 4] {
    [0, 16, 32, 48].map(|shift| ((value >> shift) & 0xffff) as f32 / 65_535.0)
}
fn log_value(value: i64) -> f32 {
    (value.signum() as f32) * (value.unsigned_abs() as f32).ln_1p() / 25.0
}
fn bool_f32(value: bool) -> f32 {
    if value { 1.0 } else { 0.0 }
}
fn unit_reference_feature(
    value: Option<UnitId>,
    indices: &BTreeMap<UnitId, usize>,
) -> Result<f32, String> {
    value
        .map(|id| {
            indices
                .get(&id)
                .copied()
                .ok_or_else(|| format!("unit reference points to unobserved unit {id}"))
        })
        .transpose()
        .map(|index| {
            index
                .map(|value| (value + 1) as f32 / (MAX_UNITS + 1) as f32)
                .unwrap_or(0.0)
        })
}
fn order_rank(state: &bd2_core::BattleState, side: Side, unit_id: UnitId) -> f32 {
    state.teams[side.index()]
        .action_order
        .iter()
        .position(|id| *id == unit_id)
        .map(|rank| (rank + 1) as f32 / MAX_TEAM as f32)
        .unwrap_or(0.0)
}
fn ensure_capacity(name: &str, actual: usize, capacity: usize) -> Result<(), String> {
    if actual > capacity {
        Err(format!(
            "{name} count {actual} exceeds observation capacity {capacity}"
        ))
    } else {
        Ok(())
    }
}
fn exact_len(name: &str, values: &[f32], expected: usize) -> Result<(), String> {
    if values.len() != expected {
        Err(format!(
            "internal {name} schema mismatch: got {}, expected {expected}",
            values.len()
        ))
    } else {
        Ok(())
    }
}
fn selector_index(value: TargetSelector) -> usize {
    match value {
        TargetSelector::Front => 0,
        TargetSelector::Skip => 1,
        TargetSelector::SelfUnit => 2,
        TargetSelector::AllyFront => 3,
        TargetSelector::NextAllyInOrder => 4,
        TargetSelector::Explicit => 5,
    }
}
fn knockback_index(value: KnockbackDirection) -> usize {
    match value {
        KnockbackDirection::Back => 0,
        KnockbackDirection::Front => 1,
        KnockbackDirection::Up => 2,
        KnockbackDirection::Down => 3,
        KnockbackDirection::UpBack => 4,
        KnockbackDirection::DownBack => 5,
        KnockbackDirection::UpFront => 6,
        KnockbackDirection::DownFront => 7,
    }
}
fn polarity_index(value: EffectPolarity) -> usize {
    match value {
        EffectPolarity::Beneficial => 0,
        EffectPolarity::Harmful => 1,
        EffectPolarity::Neutral => 2,
    }
}
fn recipient_index(value: EffectRecipient) -> usize {
    match value {
        EffectRecipient::ActorSide => 0,
        EffectRecipient::TargetSide => 1,
        EffectRecipient::ActorTeam => 2,
        EffectRecipient::OpponentTeam => 3,
    }
}
fn duration_index(value: DurationClock) -> usize {
    match value {
        DurationClock::GameTurn => 0,
        DurationClock::AllTurn => 1,
        DurationClock::Round => 2,
        DurationClock::Action => 3,
        DurationClock::Permanent => 4,
    }
}
fn stack_index(value: StackRule) -> usize {
    match value {
        StackRule::Independent => 0,
        StackRule::ReplaceSameSource => 1,
        StackRule::KeepStrongest => 2,
        StackRule::Extend => 3,
        StackRule::Accumulate => 4,
    }
}
fn damage_index(value: DamageKind) -> usize {
    match value {
        DamageKind::Physical => 0,
        DamageKind::Magical => 1,
        DamageKind::Fixed => 2,
        DamageKind::HpConsumption => 3,
        DamageKind::Collision => 4,
        DamageKind::Dot => 5,
    }
}
fn reference_index(value: StatReference) -> usize {
    match value {
        StatReference::Attack => 0,
        StatReference::Magic => 1,
        StatReference::MaxHp => 2,
        StatReference::CurrentHp => 3,
        StatReference::Fixed => 4,
        StatReference::TargetMaxHp => 5,
        StatReference::TargetCurrentHp => 6,
        StatReference::TargetAttack => 7,
        StatReference::TargetMagic => 8,
        StatReference::EnergyGuard => 9,
        StatReference::ReceivedDamage => 10,
    }
}
