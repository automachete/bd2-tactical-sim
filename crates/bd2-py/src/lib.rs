use std::sync::Arc;

use std::collections::BTreeMap;

use bd2_core::{BattleEngine, BattleSetup, Side, TeamTurnPlan};
use bd2_data::Database;
use pyo3::{exceptions::PyValueError, prelude::*};
use rayon::prelude::*;
use serde_json::json;

fn py_error(error: impl std::fmt::Display) -> PyErr {
    PyValueError::new_err(error.to_string())
}

#[pyclass(name = "Simulator")]
struct PySimulator {
    engine: BattleEngine,
}

struct BatchSlot {
    engine: BattleEngine,
    episode: u64,
    last_damage: i64,
}

#[pyclass(name = "BatchSimulator")]
struct PyBatchSimulator {
    catalog: Arc<bd2_core::Catalog>,
    setup: BattleSetup,
    seed: u64,
    slots: Vec<BatchSlot>,
}

#[pymethods]
impl PySimulator {
    #[new]
    #[pyo3(signature = (database_path, setup_json, seed=0))]
    fn new(database_path: &str, setup_json: &str, seed: u64) -> PyResult<Self> {
        let database = Database::open(database_path).map_err(py_error)?;
        let catalog = Arc::new(database.load_active_catalog().map_err(py_error)?);
        let setup: BattleSetup = serde_json::from_str(setup_json).map_err(py_error)?;
        let engine = BattleEngine::new(catalog, setup, seed).map_err(py_error)?;
        Ok(Self { engine })
    }

    fn observation_json(&self) -> PyResult<String> {
        serde_json::to_string(&self.engine.observation()).map_err(py_error)
    }

    fn training_frame_json(&self, side: &str) -> PyResult<String> {
        let side = parse_side(side)?;
        serde_json::to_string(&training_frame(&self.engine, side)).map_err(py_error)
    }

    fn state_json(&self) -> PyResult<String> {
        self.engine.state_json().map_err(py_error)
    }

    fn restore_json(&mut self, state_json: &str) -> PyResult<()> {
        self.engine.restore_json(state_json).map_err(py_error)
    }

    fn legal_actions_json(&self, side: &str) -> PyResult<String> {
        let side = parse_side(side)?;
        serde_json::to_string(&self.engine.legal_actions(side)).map_err(py_error)
    }

    fn auto_plan_json(&self, side: &str) -> PyResult<String> {
        let side = parse_side(side)?;
        serde_json::to_string(&self.engine.auto_plan(side)).map_err(py_error)
    }

    fn step_json(&mut self, plan_json: &str) -> PyResult<String> {
        let plan: TeamTurnPlan = serde_json::from_str(plan_json).map_err(py_error)?;
        let transition = self.engine.step(plan).map_err(py_error)?;
        serde_json::to_string(&transition).map_err(py_error)
    }

    fn step_auto_json(&mut self) -> PyResult<String> {
        let transition = self.engine.step_auto().map_err(py_error)?;
        serde_json::to_string(&transition).map_err(py_error)
    }
}

#[pymethods]
impl PyBatchSimulator {
    #[new]
    #[pyo3(signature = (database_path, setup_json, num_envs, seed=0))]
    fn new(database_path: &str, setup_json: &str, num_envs: usize, seed: u64) -> PyResult<Self> {
        if num_envs == 0 {
            return Err(PyValueError::new_err("num_envs must be positive"));
        }
        let database = Database::open(database_path).map_err(py_error)?;
        let catalog = Arc::new(database.load_active_catalog().map_err(py_error)?);
        let setup: BattleSetup = serde_json::from_str(setup_json).map_err(py_error)?;
        let slots = (0..num_envs)
            .map(|index| {
                BattleEngine::new(
                    Arc::clone(&catalog),
                    setup.clone(),
                    seed.wrapping_add(index as u64),
                )
                .map(|engine| BatchSlot {
                    engine,
                    episode: 0,
                    last_damage: 0,
                })
            })
            .collect::<bd2_core::Result<Vec<_>>>()
            .map_err(py_error)?;
        Ok(Self {
            catalog,
            setup,
            seed,
            slots,
        })
    }

    fn len(&self) -> usize {
        self.slots.len()
    }

    fn observations_json(&self) -> PyResult<String> {
        let frames: Vec<_> = self
            .slots
            .iter()
            .map(|slot| training_frame(&slot.engine, Side::Player))
            .collect();
        serde_json::to_string(&frames).map_err(py_error)
    }

    fn reset_all_json(&mut self) -> PyResult<String> {
        let catalog = Arc::clone(&self.catalog);
        let setup = self.setup.clone();
        let seed = self.seed;
        self.slots
            .par_iter_mut()
            .enumerate()
            .try_for_each(|(index, slot)| -> Result<(), String> {
                slot.episode = slot.episode.wrapping_add(1);
                slot.engine = BattleEngine::new(
                    Arc::clone(&catalog),
                    setup.clone(),
                    episode_seed(seed, index, slot.episode),
                )
                .map_err(|error| error.to_string())?;
                slot.last_damage = 0;
                Ok(())
            })
            .map_err(py_error)?;
        self.observations_json()
    }

    fn step_json(&mut self, actions_json: &str) -> PyResult<String> {
        let actions: Vec<Vec<usize>> = serde_json::from_str(actions_json).map_err(py_error)?;
        if actions.len() != self.slots.len() {
            return Err(PyValueError::new_err("action batch size mismatch"));
        }
        let catalog = Arc::clone(&self.catalog);
        let setup = self.setup.clone();
        let base_seed = self.seed;
        let outputs: Result<Vec<_>, String> = self.slots.par_iter_mut().zip(actions.par_iter()).enumerate().map(|(index, (slot, indices))| {
            if slot.engine.state().terminal.is_some() {
                slot.episode = slot.episode.wrapping_add(1);
                slot.engine = BattleEngine::new(Arc::clone(&catalog), setup.clone(), episode_seed(base_seed, index, slot.episode)).map_err(|error| error.to_string())?;
                slot.last_damage = 0;
            }
            let side = slot.engine.state().active_side;
            let order = slot.engine.state().teams[side.index()].action_order.clone();
            let mut commands = BTreeMap::new();
            for (position, unit_id) in order.iter().enumerate() {
                let legal = slot.engine.legal_actions_for_unit(*unit_id).map_err(|error| error.to_string())?.commands;
                let selected = indices.get(position).copied().unwrap_or(0);
                let command = legal.get(selected).cloned().ok_or_else(|| format!("masked action selected at slot {position}: {selected}"))?;
                commands.insert(*unit_id, command);
            }
            slot.engine.step(TeamTurnPlan { side, order, commands, formation: BTreeMap::new() }).map_err(|error| error.to_string())?;
            while slot.engine.state().terminal.is_none() && slot.engine.state().active_side != Side::Player {
                slot.engine.step_auto().map_err(|error| error.to_string())?;
            }
            let total_damage: i64 = slot.engine.state().damage_by_source.iter().filter(|(unit_id, _)| slot.engine.state().units.get(unit_id).is_some_and(|unit| unit.side == Side::Player)).map(|(_, damage)| *damage).sum();
            let dense = ((total_damage - slot.last_damage) as f32 / 1_000_000.0).clamp(-0.1, 0.1);
            slot.last_damage = total_damage;
            let terminal = slot.engine.state().terminal.clone();
            let terminal_reward = terminal.as_ref().map(|result| match result.outcome { bd2_core::Outcome::Win => 1.0, bd2_core::Outcome::Loss => -1.0, _ => 0.0 }).unwrap_or(0.0);
            let done = terminal.is_some();
            let terminal_json = terminal.as_ref().map(|result| serde_json::to_value(result).unwrap_or_default());
            if done {
                slot.episode = slot.episode.wrapping_add(1);
                slot.engine = BattleEngine::new(Arc::clone(&catalog), setup.clone(), episode_seed(base_seed, index, slot.episode)).map_err(|error| error.to_string())?;
                slot.last_damage = 0;
            }
            Ok(json!({ "observation": training_frame(&slot.engine, Side::Player), "reward": terminal_reward + dense, "done": done, "terminal": terminal_json }))
        }).collect();
        serde_json::to_string(&outputs.map_err(py_error)?).map_err(py_error)
    }
}

fn episode_seed(base: u64, index: usize, episode: u64) -> u64 {
    base ^ (index as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15) ^ episode.rotate_left(29)
}

fn training_frame(engine: &BattleEngine, side: Side) -> serde_json::Value {
    const MAX_UNITS: usize = 32;
    const FEATURES: usize = 56;
    const MAX_TEAM: usize = 5;
    const MAX_ACTIONS: usize = 32;
    let state = engine.state();
    let mut units = vec![vec![0.0_f32; FEATURES]; MAX_UNITS];
    let mut unit_mask = vec![false; MAX_UNITS];
    let mut unit_index_by_id = BTreeMap::new();
    for (index, unit) in state.units.values().take(MAX_UNITS).enumerate() {
        let stats = &unit.base_stats;
        let bp = |select: fn(&bd2_core::StatModifiers) -> i32| -> i32 {
            unit.effects
                .iter()
                .map(|effect| select(&effect.spec.modifiers))
                .sum()
        };
        let flat = |select: fn(&bd2_core::StatModifiers) -> i64| -> i64 {
            unit.effects
                .iter()
                .map(|effect| select(&effect.spec.modifiers))
                .sum()
        };
        let apply_bp = |value: i64, basis_points: i32| -> i64 {
            (i128::from(value) * i128::from(basis_points) / 10_000)
                .clamp(i128::from(i64::MIN), i128::from(i64::MAX)) as i64
        };
        let effective_max_hp = apply_bp(
            stats.max_hp.saturating_add(flat(|mods| mods.max_hp_flat)),
            10_000 + bp(|mods| mods.max_hp_bp),
        )
        .max(1);
        let effective_attack = apply_bp(
            stats.attack.saturating_add(flat(|mods| mods.attack_flat)),
            10_000 + bp(|mods| mods.attack_bp),
        )
        .max(0);
        let effective_magic = apply_bp(
            stats.magic.saturating_add(flat(|mods| mods.magic_flat)),
            10_000 + bp(|mods| mods.magic_bp),
        )
        .max(0);
        let beneficial = unit
            .effects
            .iter()
            .filter(|effect| effect.spec.polarity == bd2_core::EffectPolarity::Beneficial)
            .count();
        let harmful = unit.effects.len().saturating_sub(beneficial);
        let barrier_total: i64 = unit
            .effects
            .iter()
            .map(|effect| effect.barrier_remaining)
            .sum();
        let duration_total: u32 = unit
            .effects
            .iter()
            .map(|effect| u32::from(effect.remaining))
            .sum();
        let charge_total: u32 = unit
            .effects
            .iter()
            .filter_map(|effect| effect.charges_remaining)
            .map(u32::from)
            .sum();
        let has_tag = |tag: &str| {
            if unit
                .effects
                .iter()
                .any(|effect| effect.spec.tags.contains(tag))
            {
                1.0
            } else {
                0.0
            }
        };
        units[index] = vec![
            if unit.side == side { 1.0 } else { -1.0 },
            if unit.alive { 1.0 } else { 0.0 },
            unit.hp as f32 / effective_max_hp as f32,
            unit.position.row as f32 / 2.0,
            unit.position.depth as f32 / 3.0,
            (effective_max_hp as f32).ln_1p() / 25.0,
            (effective_attack as f32).ln_1p() / 15.0,
            (effective_magic as f32).ln_1p() / 15.0,
            (stats.crit_rate_bp + bp(|mods| mods.crit_rate_bp)) as f32 / 10_000.0,
            (stats.crit_damage_bp + bp(|mods| mods.crit_damage_bp)) as f32 / 20_000.0,
            (stats.defense_bp + bp(|mods| mods.defense_bp)) as f32 / 10_000.0,
            (stats.magic_resist_bp + bp(|mods| mods.magic_resist_bp)) as f32 / 10_000.0,
            (stats.property_damage_bp + bp(|mods| mods.property_damage_bp)) as f32 / 10_000.0,
            (stats.outgoing_damage_bp + bp(|mods| mods.outgoing_damage_bp)) as f32 / 10_000.0,
            (stats.incoming_damage_bp + bp(|mods| mods.incoming_damage_bp)) as f32 / 10_000.0,
            (stats.amplification_bp + bp(|mods| mods.amplification_bp)) as f32 / 10_000.0,
            bp(|mods| mods.damage_reduction_bp) as f32 / 10_000.0,
            bp(|mods| mods.physical_damage_reduction_bp) as f32 / 10_000.0,
            bp(|mods| mods.magical_damage_reduction_bp) as f32 / 10_000.0,
            bp(|mods| mods.physical_incoming_damage_bp) as f32 / 10_000.0,
            bp(|mods| mods.magical_incoming_damage_bp) as f32 / 10_000.0,
            bp(|mods| mods.dot_incoming_damage_bp) as f32 / 10_000.0,
            bp(|mods| mods.chain_damage_incoming_bp) as f32 / 10_000.0,
            bp(|mods| mods.chain_damage_outgoing_bp) as f32 / 10_000.0,
            bp(|mods| mods.evasion_bp) as f32 / 10_000.0,
            bp(|mods| mods.sp_cost_delta) as f32 / 10.0,
            bp(|mods| i32::from(mods.chain_received_delta)) as f32 / 10.0,
            bp(|mods| i32::from(mods.chain_dealt_delta)) as f32 / 10.0,
            unit.effects
                .iter()
                .map(|effect| effect.spec.modifiers.chain_retention)
                .max()
                .unwrap_or(0) as f32
                / 50.0,
            barrier_total as f32 / effective_max_hp as f32,
            unit.effects.len() as f32 / 16.0,
            beneficial as f32 / 16.0,
            harmful as f32 / 16.0,
            unit.cooldowns
                .values()
                .map(|value| *value as u32)
                .sum::<u32>() as f32
                / 50.0,
            unit.party_no as f32 / 10.0,
            unit.weak_point_bonus_bp as f32 / 20_000.0,
            if unit.is_summon { 1.0 } else { 0.0 },
            if unit.can_act { 1.0 } else { 0.0 },
            unit.costume_loadout.len() as f32 / 8.0,
            unit.id as f32 / 10_000.0,
            duration_total as f32 / 64.0,
            charge_total as f32 / 32.0,
            state.teams[side.index()]
                .chain_by_target
                .get(&unit.id)
                .copied()
                .unwrap_or(0) as f32
                / 50.0,
            state.teams[side.opponent().index()]
                .chain_by_target
                .get(&unit.id)
                .copied()
                .unwrap_or(0) as f32
                / 50.0,
            has_tag("SILENCE"),
            has_tag("TAUNT"),
            has_tag("FOCUS"),
            has_tag("EVASION"),
            has_tag("MARK"),
            has_tag("ENERGY_GUARD"),
            has_tag("BARRIER"),
            has_tag("TRANSFORMATION"),
            has_tag("ACCELERATION"),
            has_tag("COUNTER"),
            has_tag("REVIVE"),
            has_tag("DOT"),
        ];
        unit_mask[index] = true;
        unit_index_by_id.insert(unit.id, index);
    }
    let mut action_mask = vec![vec![false; MAX_ACTIONS]; MAX_TEAM];
    for (slot, unit_id) in state.teams[side.index()]
        .action_order
        .iter()
        .take(MAX_TEAM)
        .enumerate()
    {
        if let Ok(legal) = engine.legal_actions_for_unit(*unit_id) {
            for action in action_mask[slot]
                .iter_mut()
                .take(legal.commands.len().min(MAX_ACTIONS))
            {
                *action = true;
            }
        }
    }
    for slot_mask in action_mask
        .iter_mut()
        .skip(state.teams[side.index()].action_order.len().min(MAX_TEAM))
    {
        slot_mask[0] = true;
    }
    let mut actor_indices = vec![MAX_UNITS; MAX_TEAM];
    for (slot, unit_id) in state.teams[side.index()]
        .action_order
        .iter()
        .take(MAX_TEAM)
        .enumerate()
    {
        actor_indices[slot] = unit_index_by_id.get(unit_id).copied().unwrap_or(MAX_UNITS);
    }
    let own_alive = state
        .units
        .values()
        .filter(|unit| unit.side == side && unit.alive)
        .count();
    let opponent_alive = state
        .units
        .values()
        .filter(|unit| unit.side == side.opponent() && unit.alive)
        .count();
    let monster = state.monster_chaser.as_ref();
    let monster_total_hp = monster
        .map(|progress| progress.level_hp_segments.iter().sum::<i64>())
        .unwrap_or(0);
    let global = vec![
        state.game_turn as f32 / state.rules.max_game_turns.max(1) as f32,
        state.round_no as f32 / 50.0,
        state.teams[side.index()].sp as f32 / 50.0,
        state.teams[side.opponent().index()].sp as f32 / 50.0,
        if state.active_side == side { 1.0 } else { -1.0 },
        if state.rules.mode == bd2_core::BattleMode::Normal {
            1.0
        } else {
            0.0
        },
        if state.rules.mode == bd2_core::BattleMode::MirrorWar {
            1.0
        } else {
            0.0
        },
        if state.rules.mode == bd2_core::BattleMode::MonsterChaser {
            1.0
        } else {
            0.0
        },
        own_alive as f32 / MAX_UNITS as f32,
        opponent_alive as f32 / MAX_UNITS as f32,
        monster.map(|progress| progress.current_level).unwrap_or(0) as f32 / 25.0,
        monster.map(|progress| progress.selected_level).unwrap_or(0) as f32 / 25.0,
        monster
            .map(|progress| progress.battle_hp_remaining)
            .unwrap_or(0) as f32
            / monster_total_hp.max(1) as f32,
        monster.map(|progress| progress.current_party).unwrap_or(0) as f32
            / monster
                .map(|progress| progress.party_limit)
                .unwrap_or(1)
                .max(1) as f32,
        state.teams[side.index()]
            .chain_by_target
            .values()
            .map(|value| u32::from(*value))
            .sum::<u32>() as f32
            / 100.0,
        state.teams[side.opponent().index()]
            .chain_by_target
            .values()
            .map(|value| u32::from(*value))
            .sum::<u32>() as f32
            / 100.0,
    ];
    json!({ "units": units, "unit_mask": unit_mask, "global": global, "action_mask": action_mask, "actor_indices": actor_indices })
}

fn parse_side(value: &str) -> PyResult<Side> {
    match value.to_ascii_uppercase().as_str() {
        "PLAYER" => Ok(Side::Player),
        "ENEMY" => Ok(Side::Enemy),
        _ => Err(PyValueError::new_err("side must be PLAYER or ENEMY")),
    }
}

#[pymodule]
fn _native(module: &Bound<'_, PyModule>) -> PyResult<()> {
    module.add_class::<PySimulator>()?;
    module.add_class::<PyBatchSimulator>()?;
    module.add("CORE_VERSION", env!("CARGO_PKG_VERSION"))?;
    Ok(())
}
