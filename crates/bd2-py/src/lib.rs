use std::sync::Arc;

use std::collections::BTreeMap;

use bd2_core::{
    BattleEngine, BattleSetup, KnockbackDirection, Offset, Side, TeamTurnPlan, TerminalResult,
};
use bd2_data::Database;
use numpy::{IntoPyArray, ndarray::Array1, ndarray::Array2, ndarray::Array3, ndarray::Array4};
use pyo3::{exceptions::PyValueError, prelude::*, types::PyDict};
use rayon::prelude::*;
use serde::Serialize;

mod observation;
use observation::{
    ACTION_FEATURES, BLESSING_FEATURES, COSTUME_FEATURES, EFFECT_FEATURES, GLOBAL_FEATURES,
    GOLDEN_FEATURES, GRID_FEATURES, MAX_ACTIONS, MAX_BLESSINGS, MAX_COSTUMES, MAX_EFFECTS,
    MAX_GRID, MAX_MONSTER_LEVELS, MAX_TEAM, MAX_UNITS, MONSTER_FEATURES, MONSTER_LEVEL_FEATURES,
    TrainingFrame, UNIT_FEATURES, training_frame,
};

type PyBatchStep<'py> = (
    Bound<'py, PyDict>,
    Bound<'py, numpy::PyArray1<f32>>,
    Bound<'py, numpy::PyArray1<bool>>,
);

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

#[derive(Serialize)]
struct BatchStepOutput {
    observation: TrainingFrame,
    reward: f32,
    done: bool,
    terminal: Option<TerminalResult>,
}

#[derive(Serialize)]
struct KnockbackOffsetMetadata {
    direction: KnockbackDirection,
    offset: Offset,
}

#[pyfunction]
fn knockback_offsets_json() -> PyResult<String> {
    let metadata = KnockbackDirection::ALL.map(|direction| KnockbackOffsetMetadata {
        direction,
        offset: direction.offset(),
    });
    serde_json::to_string(&metadata).map_err(py_error)
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
        serde_json::to_string(&training_frame(&self.engine, side).map_err(py_error)?)
            .map_err(py_error)
    }

    fn state_json(&self) -> PyResult<String> {
        self.engine.state_json().map_err(py_error)
    }

    fn restore_json(&mut self, state_json: &str) -> PyResult<()> {
        self.engine.restore_json(state_json).map_err(py_error)
    }

    #[pyo3(signature = (setup_json, seed=0))]
    fn new_battle(&self, setup_json: &str, seed: u64) -> PyResult<Self> {
        let setup: BattleSetup = serde_json::from_str(setup_json).map_err(py_error)?;
        let engine = self.engine.new_battle(setup, seed).map_err(py_error)?;
        Ok(Self { engine })
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
            .collect::<Result<Vec<_>, _>>()
            .map_err(py_error)?;
        serde_json::to_string(&frames).map_err(py_error)
    }

    fn observations_numpy<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyDict>> {
        let frames: Vec<_> = self
            .slots
            .iter()
            .map(|slot| training_frame(&slot.engine, Side::Player))
            .collect::<Result<Vec<_>, _>>()
            .map_err(py_error)?;
        frames_to_numpy(py, &frames)
    }

    fn reset_all_json(&mut self) -> PyResult<String> {
        self.reset_slots()?;
        self.observations_json()
    }

    fn reset_all_numpy<'py>(&mut self, py: Python<'py>) -> PyResult<Bound<'py, PyDict>> {
        self.reset_slots()?;
        self.observations_numpy(py)
    }

    fn step_json(&mut self, actions_json: &str) -> PyResult<String> {
        let actions: Vec<Vec<usize>> = serde_json::from_str(actions_json).map_err(py_error)?;
        let outputs = self.advance(&actions).map_err(py_error)?;
        serde_json::to_string(&outputs).map_err(py_error)
    }

    fn step_numpy<'py>(
        &mut self,
        py: Python<'py>,
        actions: Vec<Vec<usize>>,
    ) -> PyResult<PyBatchStep<'py>> {
        let outputs = self.advance(&actions).map_err(py_error)?;
        let rewards = Array1::from_iter(outputs.iter().map(|output| output.reward));
        let dones = Array1::from_iter(outputs.iter().map(|output| output.done));
        let frames: Vec<_> = outputs
            .into_iter()
            .map(|output| output.observation)
            .collect();
        Ok((
            frames_to_numpy(py, &frames)?,
            rewards.into_pyarray(py),
            dones.into_pyarray(py),
        ))
    }
}

impl PyBatchSimulator {
    fn reset_slots(&mut self) -> PyResult<()> {
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
            .map_err(py_error)
    }

    fn advance(&mut self, actions: &[Vec<usize>]) -> Result<Vec<BatchStepOutput>, String> {
        if actions.len() != self.slots.len() {
            return Err("action batch size mismatch".into());
        }
        let catalog = Arc::clone(&self.catalog);
        let setup = self.setup.clone();
        let base_seed = self.seed;
        self.slots
            .par_iter_mut()
            .zip(actions.par_iter())
            .enumerate()
            .map(|(index, (slot, indices))| {
                if slot.engine.state().terminal.is_some() {
                    slot.episode = slot.episode.wrapping_add(1);
                    slot.engine = BattleEngine::new(
                        Arc::clone(&catalog),
                        setup.clone(),
                        episode_seed(base_seed, index, slot.episode),
                    )
                    .map_err(|error| error.to_string())?;
                    slot.last_damage = 0;
                }
                let side = slot.engine.state().active_side;
                if slot.engine.state().rules.action_flow == bd2_core::ActionFlow::AlternatingCostume
                {
                    // Golden Colosseum combat is fully automatic; an environment
                    // step advances the single authoritative costume action.
                    slot.engine.step_auto().map_err(|error| error.to_string())?;
                } else {
                    let order = slot.engine.state().teams[side.index()].action_order.clone();
                    let mut commands = BTreeMap::new();
                    for (position, unit_id) in order.iter().enumerate() {
                        let legal = slot
                            .engine
                            .legal_actions_for_unit(*unit_id)
                            .map_err(|error| error.to_string())?
                            .commands;
                        if legal.is_empty() {
                            continue;
                        }
                        let selected = indices
                            .get(position)
                            .copied()
                            .ok_or_else(|| format!("missing action at slot {position}"))?;
                        let command = legal.get(selected).cloned().ok_or_else(|| {
                            format!("masked action selected at slot {position}: {selected}")
                        })?;
                        commands.insert(*unit_id, command);
                    }
                    slot.engine
                        .step(TeamTurnPlan {
                            side,
                            order,
                            commands,
                            formation: BTreeMap::new(),
                        })
                        .map_err(|error| error.to_string())?;
                }
                while slot.engine.state().terminal.is_none()
                    && slot.engine.state().active_side != Side::Player
                {
                    slot.engine.step_auto().map_err(|error| error.to_string())?;
                }
                let total_damage: i64 = slot
                    .engine
                    .state()
                    .damage_by_source
                    .iter()
                    .filter(|(unit_id, _)| {
                        slot.engine
                            .state()
                            .units
                            .get(unit_id)
                            .is_some_and(|unit| unit.side == Side::Player)
                    })
                    .map(|(_, damage)| *damage)
                    .sum();
                let dense =
                    ((total_damage - slot.last_damage) as f32 / 1_000_000.0).clamp(-0.1, 0.1);
                slot.last_damage = total_damage;
                let terminal = slot.engine.state().terminal.clone();
                let terminal_reward = terminal
                    .as_ref()
                    .map(|result| match result.outcome {
                        bd2_core::Outcome::Win => 1.0,
                        bd2_core::Outcome::Loss => -1.0,
                        _ => 0.0,
                    })
                    .unwrap_or(0.0);
                let done = terminal.is_some();
                if done {
                    slot.episode = slot.episode.wrapping_add(1);
                    slot.engine = BattleEngine::new(
                        Arc::clone(&catalog),
                        setup.clone(),
                        episode_seed(base_seed, index, slot.episode),
                    )
                    .map_err(|error| error.to_string())?;
                    slot.last_damage = 0;
                }
                Ok(BatchStepOutput {
                    observation: training_frame(&slot.engine, Side::Player)?,
                    reward: terminal_reward + dense,
                    done,
                    terminal,
                })
            })
            .collect()
    }
}

fn episode_seed(base: u64, index: usize, episode: u64) -> u64 {
    base ^ (index as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15) ^ episode.rotate_left(29)
}

fn frames_to_numpy<'py>(py: Python<'py>, frames: &[TrainingFrame]) -> PyResult<Bound<'py, PyDict>> {
    let batch = frames.len();
    let float2 = |name: &str, width: usize, select: fn(&TrainingFrame) -> &Vec<f32>| {
        Array2::from_shape_vec(
            (batch, width),
            frames
                .iter()
                .flat_map(|frame| select(frame).iter().copied())
                .collect(),
        )
        .map_err(|error| py_error(format!("{name}: {error}")))
    };
    let float3 =
        |name: &str, outer: usize, width: usize, select: fn(&TrainingFrame) -> &Vec<Vec<f32>>| {
            Array3::from_shape_vec(
                (batch, outer, width),
                frames
                    .iter()
                    .flat_map(|frame| select(frame).iter().flatten().copied())
                    .collect(),
            )
            .map_err(|error| py_error(format!("{name}: {error}")))
        };
    let float4 = |name: &str,
                  outer: usize,
                  inner: usize,
                  width: usize,
                  select: fn(&TrainingFrame) -> &Vec<Vec<Vec<f32>>>| {
        Array4::from_shape_vec(
            (batch, outer, inner, width),
            frames
                .iter()
                .flat_map(|frame| select(frame).iter().flatten().flatten().copied())
                .collect(),
        )
        .map_err(|error| py_error(format!("{name}: {error}")))
    };
    let bool2 = |name: &str, width: usize, select: fn(&TrainingFrame) -> &Vec<bool>| {
        Array2::from_shape_vec(
            (batch, width),
            frames
                .iter()
                .flat_map(|frame| select(frame).iter().copied())
                .collect(),
        )
        .map_err(|error| py_error(format!("{name}: {error}")))
    };
    let bool3 =
        |name: &str, outer: usize, width: usize, select: fn(&TrainingFrame) -> &Vec<Vec<bool>>| {
            Array3::from_shape_vec(
                (batch, outer, width),
                frames
                    .iter()
                    .flat_map(|frame| select(frame).iter().flatten().copied())
                    .collect(),
            )
            .map_err(|error| py_error(format!("{name}: {error}")))
        };
    let index2 = |name: &str, width: usize, select: fn(&TrainingFrame) -> &Vec<usize>| {
        Array2::from_shape_vec(
            (batch, width),
            frames
                .iter()
                .flat_map(|frame| select(frame).iter().map(|value| *value as i64))
                .collect(),
        )
        .map_err(|error| py_error(format!("{name}: {error}")))
    };
    let index3 =
        |name: &str, outer: usize, width: usize, select: fn(&TrainingFrame) -> &Vec<Vec<usize>>| {
            Array3::from_shape_vec(
                (batch, outer, width),
                frames
                    .iter()
                    .flat_map(|frame| select(frame).iter().flatten().map(|value| *value as i64))
                    .collect(),
            )
            .map_err(|error| py_error(format!("{name}: {error}")))
        };

    let result = PyDict::new(py);
    result.set_item(
        "units",
        float3("units", MAX_UNITS, UNIT_FEATURES, |f| &f.units)?.into_pyarray(py),
    )?;
    result.set_item(
        "unit_mask",
        bool2("unit_mask", MAX_UNITS, |f| &f.unit_mask)?.into_pyarray(py),
    )?;
    result.set_item(
        "costumes",
        float4("costumes", MAX_UNITS, MAX_COSTUMES, COSTUME_FEATURES, |f| {
            &f.costumes
        })?
        .into_pyarray(py),
    )?;
    result.set_item(
        "costume_mask",
        bool3("costume_mask", MAX_UNITS, MAX_COSTUMES, |f| &f.costume_mask)?.into_pyarray(py),
    )?;
    result.set_item(
        "effects",
        float3("effects", MAX_EFFECTS, EFFECT_FEATURES, |f| &f.effects)?.into_pyarray(py),
    )?;
    result.set_item(
        "effect_mask",
        bool2("effect_mask", MAX_EFFECTS, |f| &f.effect_mask)?.into_pyarray(py),
    )?;
    result.set_item(
        "global",
        float2("global", GLOBAL_FEATURES, |f| &f.global)?.into_pyarray(py),
    )?;
    result.set_item(
        "monster",
        float2("monster", MONSTER_FEATURES, |f| &f.monster)?.into_pyarray(py),
    )?;
    result.set_item(
        "monster_levels",
        float3(
            "monster_levels",
            MAX_MONSTER_LEVELS,
            MONSTER_LEVEL_FEATURES,
            |f| &f.monster_levels,
        )?
        .into_pyarray(py),
    )?;
    result.set_item(
        "monster_level_mask",
        bool2("monster_level_mask", MAX_MONSTER_LEVELS, |f| {
            &f.monster_level_mask
        })?
        .into_pyarray(py),
    )?;
    result.set_item(
        "golden",
        float2("golden", GOLDEN_FEATURES, |f| &f.golden)?.into_pyarray(py),
    )?;
    result.set_item(
        "blessings",
        float4("blessings", 2, MAX_BLESSINGS, BLESSING_FEATURES, |f| {
            &f.blessings
        })?
        .into_pyarray(py),
    )?;
    result.set_item(
        "blessing_mask",
        bool3("blessing_mask", 2, MAX_BLESSINGS, |f| &f.blessing_mask)?.into_pyarray(py),
    )?;
    result.set_item(
        "grid",
        float4("grid", MAX_GRID, MAX_GRID, GRID_FEATURES, |f| &f.grid)?.into_pyarray(py),
    )?;
    result.set_item(
        "action_features",
        float4(
            "action_features",
            MAX_TEAM,
            MAX_ACTIONS,
            ACTION_FEATURES,
            |f| &f.action_features,
        )?
        .into_pyarray(py),
    )?;
    result.set_item(
        "action_mask",
        bool3("action_mask", MAX_TEAM, MAX_ACTIONS, |f| &f.action_mask)?.into_pyarray(py),
    )?;
    result.set_item(
        "actor_indices",
        index2("actor_indices", MAX_TEAM, |f| &f.actor_indices)?.into_pyarray(py),
    )?;
    result.set_item(
        "team_order_indices",
        index3("team_order_indices", 2, MAX_TEAM, |f| &f.team_order_indices)?.into_pyarray(py),
    )?;
    result.set_item(
        "team_order_mask",
        bool3("team_order_mask", 2, MAX_TEAM, |f| &f.team_order_mask)?.into_pyarray(py),
    )?;
    Ok(result)
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
    module.add_function(wrap_pyfunction!(knockback_offsets_json, module)?)?;
    module.add_class::<PySimulator>()?;
    module.add_class::<PyBatchSimulator>()?;
    module.add("CORE_VERSION", env!("CARGO_PKG_VERSION"))?;
    module.add("MAX_TEAM_UNITS", MAX_TEAM)?;
    module.add("MAX_TOTAL_UNITS", MAX_UNITS)?;
    module.add("MAX_ACTIONS_PER_UNIT", MAX_ACTIONS)?;
    module.add("UNIT_FEATURES", UNIT_FEATURES)?;
    module.add("ACTION_FEATURES", ACTION_FEATURES)?;
    module.add("GLOBAL_FEATURES", GLOBAL_FEATURES)?;
    module.add("MAX_COSTUMES_PER_UNIT", MAX_COSTUMES)?;
    module.add("COSTUME_FEATURES", COSTUME_FEATURES)?;
    module.add("MAX_ACTIVE_EFFECTS", MAX_EFFECTS)?;
    module.add("EFFECT_FEATURES", EFFECT_FEATURES)?;
    module.add("MONSTER_FEATURES", MONSTER_FEATURES)?;
    module.add("MAX_MONSTER_LEVELS", MAX_MONSTER_LEVELS)?;
    module.add("MONSTER_LEVEL_FEATURES", MONSTER_LEVEL_FEATURES)?;
    module.add("GOLDEN_FEATURES", GOLDEN_FEATURES)?;
    module.add("MAX_BLESSINGS_PER_SIDE", MAX_BLESSINGS)?;
    module.add("BLESSING_FEATURES", BLESSING_FEATURES)?;
    module.add("MAX_GRID_SIZE", MAX_GRID)?;
    module.add("GRID_FEATURES", GRID_FEATURES)?;
    Ok(())
}
