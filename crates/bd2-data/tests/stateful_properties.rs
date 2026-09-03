use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    sync::{Arc, OnceLock},
};

use bd2_core::{
    ActiveEffect, AttackType, BattleEngine, BattleEventKind, BattleSetup, BattleState, Catalog,
    Cell, ModeRules, Side, SkillOperation, Stats, TeamTurnPlan, UnitBuildSettings, UnitCommand,
    UnitSetup,
};
use proptest::prelude::*;

const SCENARIOS: [&str; 4] = [
    "data/scenarios/normal-demo.json",
    "data/scenarios/mirror-war-demo.json",
    "data/scenarios/monster-chaser-current.json",
    "data/scenarios/golden-colosseum-reference.json",
];

const MONSTER_ACTOR_ID: u32 = 1001;
const MONSTER_CONDITIONAL_COSTUME: &str = "fiend:10072:hunt-72-skill-5";

fn workspace_path(relative: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(relative)
}

fn load_catalog() -> Arc<Catalog> {
    static CATALOG: OnceLock<Arc<Catalog>> = OnceLock::new();
    Arc::clone(CATALOG.get_or_init(|| {
        Arc::new(
            serde_json::from_str(
                &fs::read_to_string(workspace_path("data/generated/catalog.json")).unwrap(),
            )
            .unwrap(),
        )
    }))
}

fn load_scenario(index: usize) -> BattleSetup {
    static SETUPS: OnceLock<Vec<BattleSetup>> = OnceLock::new();
    SETUPS.get_or_init(|| {
        SCENARIOS
            .iter()
            .map(|path| {
                serde_json::from_str(&fs::read_to_string(workspace_path(path)).unwrap()).unwrap()
            })
            .collect()
    })[index]
        .clone()
}

fn monster_state_with_trigger_ready() -> (Arc<Catalog>, BattleState) {
    let catalog = load_catalog();
    let mut state = BattleEngine::new(Arc::clone(&catalog), load_scenario(2), 7)
        .unwrap()
        .snapshot();
    state.teams[Side::Player.index()]
        .chain_by_target
        .insert(MONSTER_ACTOR_ID, 8);
    (catalog, state)
}

fn all_player_normals(state: &BattleState) -> TeamTurnPlan {
    let order = state.teams[Side::Player.index()].action_order.clone();
    TeamTurnPlan {
        side: Side::Player,
        commands: order
            .iter()
            .map(|unit_id| (*unit_id, UnitCommand::NormalAttack))
            .collect(),
        order,
        formation: BTreeMap::new(),
    }
}

#[test]
fn monster_conditional_fires_once_when_its_condition_first_becomes_true() {
    let (catalog, state) = monster_state_with_trigger_ready();
    let player_actions = state.teams[Side::Player.index()].action_order.len() as u64;
    let action_sequence_before = state.action_sequence;
    let mut engine = BattleEngine::from_state(catalog, state).unwrap();

    let transition = engine.step(all_player_normals(engine.state())).unwrap();

    let conditional_actions = transition
        .events
        .iter()
        .filter(|event| {
            matches!(
                &event.kind,
                BattleEventKind::ActionStarted {
                    actor_id: MONSTER_ACTOR_ID,
                    command: UnitCommand::UseCostume { costume_id, .. },
                } if costume_id == MONSTER_CONDITIONAL_COSTUME
            )
        })
        .count();
    assert_eq!(conditional_actions, 1);
    assert_eq!(
        engine.state().units[&MONSTER_ACTOR_ID].triggered_skill_uses[MONSTER_CONDITIONAL_COSTUME],
        1
    );
    assert_eq!(
        engine.state().action_sequence,
        action_sequence_before + player_actions + 1
    );
}

#[test]
fn silenced_monster_conditional_does_not_invalidate_an_already_reserved_player_turn() {
    let (catalog, mut state) = monster_state_with_trigger_ready();
    let silence = catalog.costumes["Scheherazade_3"]
        .variants
        .iter()
        .flat_map(|variant| &variant.operations)
        .find_map(|operation| match operation {
            SkillOperation::ApplyEffect { effect } if effect.tags.contains("SILENCE") => {
                Some(effect.clone())
            }
            _ => None,
        })
        .unwrap();
    let instance_id = state.next_effect_instance_id;
    state.next_effect_instance_id += 1;
    state
        .units
        .get_mut(&MONSTER_ACTOR_ID)
        .unwrap()
        .effects
        .push(ActiveEffect {
            instance_id,
            source_unit_id: 3,
            remaining: silence.duration,
            barrier_remaining: 0,
            charges_remaining: silence.charges,
            spec: silence,
        });
    let mut engine = BattleEngine::from_state(catalog, state).unwrap();
    let transition = engine.step(all_player_normals(engine.state())).unwrap();
    assert!(
        engine.state().units[&MONSTER_ACTOR_ID]
            .effects
            .iter()
            .any(|effect| effect.spec.tags.contains("SILENCE"))
    );
    assert!(!transition.events.iter().any(|event| matches!(
        event.kind,
        BattleEventKind::ActionStarted {
            actor_id: MONSTER_ACTOR_ID,
            ..
        }
    )));
    assert!(
        engine.state().units[&MONSTER_ACTOR_ID]
            .triggered_skill_uses
            .values()
            .all(|uses| *uses == 0)
    );
}

proptest! {
    #![proptest_config(ProptestConfig {
        cases: 256,
        max_shrink_iters: 10_000,
        .. ProptestConfig::default()
    })]

    #[test]
    fn seeded_transitions_restore_bit_exactly_and_replay_deterministically(
        seed in any::<u64>(),
        scenario_index in 0usize..SCENARIOS.len(),
        requested_steps in 1usize..32,
    ) {
        let catalog = load_catalog();
        let setup = load_scenario(scenario_index);
        let mut original = BattleEngine::new(Arc::clone(&catalog), setup, seed).unwrap();
        for _ in 0..requested_steps {
            if original.state().terminal.is_some() {
                break;
            }
            let encoded = serde_json::to_vec(&original.snapshot()).unwrap();
            let decoded: BattleState = serde_json::from_slice(&encoded).unwrap();
            prop_assert_eq!(serde_json::to_vec(&decoded).unwrap(), encoded);
            let mut restored = BattleEngine::from_state(Arc::clone(&catalog), decoded).unwrap();
            let plan = original.auto_plan(original.state().active_side);
            let first = original.step(plan.clone()).unwrap();
            let second = restored.step(plan).unwrap();
            prop_assert_eq!(first, second);
            prop_assert_eq!(original.state(), restored.state());
            for team in &original.state().teams {
                prop_assert!((0..=bd2_core::SP_CAP).contains(&team.sp));
            }
        }
    }

    #[test]
    fn corrupted_snapshots_are_rejected_without_mutating_the_live_engine(
        seed in any::<u64>(),
        scenario_index in 0usize..SCENARIOS.len(),
        corruption in 0u8..6,
    ) {
        let catalog = load_catalog();
        let setup = load_scenario(scenario_index);
        let engine = BattleEngine::new(Arc::clone(&catalog), setup, seed).unwrap();
        let baseline = engine.snapshot();
        let mut corrupted = baseline.clone();
        match corruption {
            0 => corrupted.teams[0].sp = bd2_core::SP_CAP + 1,
            1 => corrupted.event_sequence = corrupted.event_sequence.saturating_add(1),
            2 => corrupted.teams.swap(0, 1),
            3 => {
                let id = *corrupted.units.keys().next().unwrap();
                corrupted.units.get_mut(&id).unwrap().position.row = corrupted.rules.grid.rows;
            }
            4 => {
                let team = &mut corrupted.teams[corrupted.active_side.index()];
                if let Some(id) = team.action_order.first().copied() {
                    team.action_order.push(id);
                } else {
                    corrupted.game_turn = 0;
                }
            }
            _ => {
                let unit = corrupted.units.values_mut().next().unwrap();
                if let Some(costume) = unit.cooldowns.keys().next().cloned() {
                    unit.cooldowns.remove(&costume);
                } else {
                    unit.hp = -1;
                }
            }
        }
        prop_assert!(BattleEngine::from_state(catalog, corrupted).is_err());
        prop_assert_eq!(engine.state(), &baseline);
    }

    #[test]
    fn normal_attack_damage_matches_an_independent_integer_oracle(
        attack in 1i64..5_000_000,
        defense_bp in -20_000i32..9_001,
    ) {
        let catalog = load_catalog();
        let character = catalog.characters.values()
            .find(|character| character.rarity == 5 && !character.id.contains(':'))
            .unwrap()
            .clone();
        let mut actor_stats = neutral_stats();
        match character.attack_type {
            AttackType::Physical => actor_stats.attack = attack,
            AttackType::Magical => actor_stats.magic = attack,
        }
        let mut target_stats = neutral_stats();
        match character.attack_type {
            AttackType::Physical => target_stats.defense_bp = defense_bp,
            AttackType::Magical => target_stats.magic_resist_bp = defense_bp,
        }
        let make_unit = |unit_id, side, stats| UnitSetup {
            unit_id,
            character_id: character.id.clone(),
            side,
            position: Cell { row: 0, depth: 0 },
            costume_loadout: Vec::new(),
            build_settings: UnitBuildSettings::unmodified(),
            stat_overrides: Some(stats),
            equipment: BTreeMap::new(),
            ai_priority: Vec::new(),
            party_no: 1,
            hp_owner: None,
            weak_point_bonus_bp: 0,
            can_act: true,
        };
        let mut engine = BattleEngine::new(
            catalog,
            BattleSetup {
                scenario_id: "damage-oracle".into(),
                rules: ModeRules::normal(),
                units: vec![
                    make_unit(1, Side::Player, actor_stats),
                    make_unit(2, Side::Enemy, target_stats),
                ],
                monster_chaser: None,
                golden_colosseum: None,
            },
            0,
        ).unwrap();
        let transition = engine.step(TeamTurnPlan {
            side: Side::Player,
            order: vec![1],
            commands: BTreeMap::from([(1, UnitCommand::NormalAttack)]),
            formation: BTreeMap::new(),
        }).unwrap();
        let actual = transition.events.iter().find_map(|event| match event.kind {
            BattleEventKind::DamageApplied { actor_id: 1, target_id: 2, amount, .. } => Some(amount),
            _ => None,
        }).unwrap();
        let expected = (i128::from(attack) * i128::from(10_000 - defense_bp) / 10_000) as i64;
        prop_assert_eq!(actual, expected);
    }
}

fn neutral_stats() -> Stats {
    Stats {
        max_hp: 10_000_000_000,
        attack: 0,
        magic: 0,
        crit_rate_bp: 0,
        crit_damage_bp: 0,
        defense_bp: 0,
        magic_resist_bp: 0,
        property_damage_bp: 0,
        outgoing_damage_bp: 0,
        incoming_damage_bp: 0,
        amplification_bp: 0,
    }
}
