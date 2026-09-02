//! Deterministic, headless BrownDust2 battle simulation core.
//!
//! The core has no GUI, database, Python, wall-clock, or OS dependencies. Every
//! transition is a pure function of catalog data, serialized state, action, and
//! RNG state. This is the boundary required for reproducible training.

mod engine;
mod error;
mod model;
mod rng;

pub use engine::{BattleEngine, SimulatorBatch, resolve_equipment_modifiers, validate_catalog};
pub use error::{BattleError, Result};
pub use model::*;
pub use rng::DeterministicRng;
