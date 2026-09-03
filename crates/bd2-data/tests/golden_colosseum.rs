use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::PathBuf,
    sync::Arc,
};

use bd2_core::{
    BattleEngine, BattleEventKind, BattleMode, BattleSetup, BlessingEffect, BlessingSelection,
    EquipmentLoadout, Side, Stats,
};

fn workspace_path(relative: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(relative)
}

fn load() -> (Arc<bd2_core::Catalog>, BattleSetup) {
    let catalog = serde_json::from_str(
        &fs::read_to_string(workspace_path("data/generated/catalog.json")).unwrap(),
    )
    .unwrap();
    let setup = serde_json::from_str(
        &fs::read_to_string(workspace_path(
            "data/scenarios/golden-colosseum-reference.json",
        ))
        .unwrap(),
    )
    .unwrap();
    (Arc::new(catalog), setup)
}

fn durable_setup(mut setup: BattleSetup) -> BattleSetup {
    for unit in &mut setup.units {
        unit.stat_overrides = Some(Stats {
            max_hp: 1_000_000_000,
            attack: 100,
            magic: 100,
            crit_rate_bp: 0,
            crit_damage_bp: 0,
            defense_bp: 0,
            magic_resist_bp: 0,
            property_damage_bp: 0,
            outgoing_damage_bp: 0,
            incoming_damage_bp: 0,
            amplification_bp: 0,
        });
    }
    setup
}

#[test]
fn current_bd2db_blessing_catalog_is_complete_and_localized() {
    let (catalog, setup) = load();
    assert_eq!(catalog.blessings.len(), 47);
    for number in 1..=47 {
        let id = format!("blessing_{number:03}");
        let blessing = &catalog.blessings[&id];
        for locale in ["ja", "ko", "en"] {
            assert!(!blessing.names[locale].is_empty(), "{id} {locale}");
            assert!(!blessing.descriptions[locale].is_empty(), "{id} {locale}");
        }
        assert!(
            blessing
                .levels
                .iter()
                .enumerate()
                .all(|(index, level)| usize::from(level.level) == index + 1 && level.point_cost > 0)
        );
    }
    assert_eq!(catalog.blessings["blessing_001"].names["ja"], "力の加護");
    assert_eq!(catalog.blessings["blessing_027"].names["ko"], "언령의 축복");
    assert!(matches!(
        catalog.blessings["blessing_029"].levels[0].effect,
        BlessingEffect::ForceFixedDamage
    ));
    assert!(matches!(
        catalog.blessings["blessing_047"].levels[0].effect,
        BlessingEffect::ChainCap { maximum: 2 }
    ));
    let surprise_preparation = &catalog.blessings["blessing_045"].levels[0].effect;
    assert!(matches!(
        surprise_preparation,
        BlessingEffect::TimedEffect { effect, .. }
            if effect.modifiers.attack_bp == 30_000
                && effect.modifiers.magic_bp == 30_000
    ));
    assert!(matches!(
        catalog.blessings["blessing_046"].levels[0].effect,
        BlessingEffect::ConditionalDamage {
            amount_bp: 15_000,
            ..
        }
    ));
    assert!(
        catalog.blessings["blessing_045"].descriptions["ja"]
            .iter()
            .any(|line| line.contains("300%"))
    );
    assert!(
        catalog.blessings["blessing_045"].descriptions["ja"]
            .iter()
            .all(|line| !line.contains("100％") && !line.contains("100%"))
    );

    let golden = setup.golden_colosseum.unwrap();
    assert_eq!(setup.rules.grid.rows, 4);
    assert_eq!(setup.rules.grid.depths, 4);
    assert_eq!(setup.rules.grid.deployment_limit, 3);
    assert_eq!(setup.rules.grid.blocked.len(), 6);
    assert_eq!(setup.rules.max_game_turns, u32::MAX);
    assert_eq!(golden.season_label, "TRIAL-SEASON-40-2026-09-03");
    assert_eq!(golden.weekly_attempts, 100);
    assert_eq!(golden.refill_limit, 3);
    assert_eq!(golden.starting_rating, 1_000);
    assert_eq!(golden.undeployable_grid_count, 6);
    assert_eq!(golden.death_time_all_turn, 5);
    assert_eq!(golden.banned_costume_ids.len(), 5);
    assert!(golden.banned_blessing_ids.is_empty());
    for side in golden.side_blessings {
        assert_eq!(side.going_first.point_limit, 3);
        assert_eq!(side.going_second.point_limit, 4);
    }
}

#[test]
fn every_current_blessing_level_passes_budget_validation_and_activates() {
    let (catalog, setup) = load();
    for blessing in catalog.blessings.values() {
        for level in &blessing.levels {
            let mut current = durable_setup(setup.clone());
            let selection = vec![BlessingSelection {
                blessing_id: blessing.id.clone(),
                level: level.level,
            }];
            let config = current.golden_colosseum.as_mut().unwrap();
            for side in &mut config.side_blessings {
                side.going_first.point_limit = 13;
                side.going_first.selected = selection.clone();
                side.going_second.point_limit = 15;
                side.going_second.selected = selection.clone();
            }
            let mut engine =
                BattleEngine::new(Arc::clone(&catalog), current, 7).unwrap_or_else(|error| {
                    panic!("{} level {} failed: {error}", blessing.id, level.level)
                });
            let first_activation_turn = match &level.effect {
                BlessingEffect::TimedEffect { start_all_turn, .. } => *start_all_turn,
                _ => 1,
            };
            while engine.state().golden_colosseum.as_ref().unwrap().all_turn < first_activation_turn
                && engine.state().terminal.is_none()
            {
                engine.step_auto().unwrap();
            }
            let activated = engine
                .state()
                .event_log
                .iter()
                .filter(|event| {
                    matches!(
                        &event.kind,
                        BattleEventKind::BlessingActivated {
                            blessing_id,
                            level: activated_level,
                            ..
                        } if blessing_id == &blessing.id && *activated_level == level.level
                    )
                })
                .count();
            assert!(activated >= 2, "{} level {}", blessing.id, level.level);
        }
    }
}

#[test]
fn gear_is_validated_but_has_no_effect_and_costume_bond_is_forced_to_self() {
    let (catalog, setup) = load();
    let baseline = BattleEngine::new(Arc::clone(&catalog), setup.clone(), 11).unwrap();
    let baseline_stats = baseline.state().units[&1].base_stats.clone();

    let (equipment_id, definition) = catalog
        .equipment
        .iter()
        .find(|(_, definition)| definition.owner_character_id.is_none())
        .unwrap();
    let mut equipped = setup.clone();
    equipped.units[0].equipment = BTreeMap::from([(
        definition.slot,
        EquipmentLoadout {
            equipment_id: equipment_id.clone(),
            refinement_score: 24,
            primary_stat: None,
            secondary_stat: None,
            substats: vec![definition.allowed_substats[0]; 3],
        },
    )]);
    let with_equipment = BattleEngine::new(Arc::clone(&catalog), equipped, 11).unwrap();
    assert_eq!(with_equipment.state().units[&1].base_stats, baseline_stats);

    let mut without_bond_catalog = (*catalog).clone();
    without_bond_catalog
        .costumes
        .get_mut("Loen_1")
        .unwrap()
        .bonding_modifiers = Default::default();
    let without_bond = BattleEngine::new(Arc::new(without_bond_catalog), setup, 11).unwrap();
    assert_ne!(without_bond.state().units[&1].base_stats, baseline_stats);
}

#[test]
fn initiative_is_seeded_and_selects_the_matching_blessing_loadout() {
    let (catalog, setup) = load();
    let engines: Vec<_> = (0..64)
        .map(|seed| BattleEngine::new(Arc::clone(&catalog), setup.clone(), seed).unwrap())
        .collect();
    assert!(
        engines
            .iter()
            .any(|engine| engine.state().active_side == Side::Player)
    );
    assert!(
        engines
            .iter()
            .any(|engine| engine.state().active_side == Side::Enemy)
    );
    for (seed, engine) in engines.iter().enumerate() {
        assert_eq!(engine.state().rules.mode, BattleMode::GoldenColosseum);
        assert_eq!(engine.state().teams[0].sp, 0, "seed {seed}");
        assert_eq!(engine.state().teams[1].sp, 0, "seed {seed}");
        let progress = engine.state().golden_colosseum.as_ref().unwrap();
        assert_eq!(progress.initiative, engine.state().active_side);
        let initiative = engine
            .state()
            .event_log
            .iter()
            .find_map(|event| match event.kind {
                BattleEventKind::InitiativeRolled { first_side, .. } => Some(first_side),
                _ => None,
            })
            .unwrap();
        assert_eq!(initiative, progress.initiative);
        for side in [Side::Player, Side::Enemy] {
            let expected_first = side == progress.initiative;
            let configured = &setup.golden_colosseum.as_ref().unwrap().side_blessings[side.index()];
            let expected = if expected_first {
                &configured.going_first.selected
            } else {
                &configured.going_second.selected
            };
            assert_eq!(
                &progress.active_blessings[side.index()],
                expected,
                "seed {seed} side {side:?}"
            );
        }
        let activation_sides: Vec<_> = engine
            .state()
            .event_log
            .iter()
            .filter_map(|event| match event.kind {
                BattleEventKind::BlessingActivated { side, .. } => Some(side),
                _ => None,
            })
            .collect();
        let first_count = progress.active_blessings[progress.initiative.index()].len();
        assert_eq!(
            &activation_sides[..first_count],
            vec![progress.initiative; first_count],
            "seed {seed}: initiative side blessings must resolve first"
        );
        assert!(
            activation_sides[first_count..]
                .iter()
                .all(|side| *side == progress.initiative.opponent()),
            "seed {seed}: second side blessings must not interleave"
        );
    }
}

#[test]
fn initiative_blessing_order_changes_later_stat_boost_pressure() {
    let (catalog, setup) = load();
    let mut setup = durable_setup(setup);
    let config = setup.golden_colosseum.as_mut().unwrap();
    for loadout in [
        &mut config.side_blessings[Side::Player.index()].going_first,
        &mut config.side_blessings[Side::Player.index()].going_second,
    ] {
        loadout.selected = vec![BlessingSelection {
            blessing_id: "blessing_001".into(),
            level: 1,
        }];
    }
    for loadout in [
        &mut config.side_blessings[Side::Enemy.index()].going_first,
        &mut config.side_blessings[Side::Enemy.index()].going_second,
    ] {
        loadout.selected = vec![BlessingSelection {
            blessing_id: "blessing_035".into(),
            level: 2,
        }];
    }

    let mut observed = BTreeMap::new();
    for seed in 0..64 {
        let engine = BattleEngine::new(Arc::clone(&catalog), setup.clone(), seed).unwrap();
        let progress = engine.state().golden_colosseum.as_ref().unwrap();
        let applied_attack_bp = engine.state().units[&1]
            .effects
            .iter()
            .find(|effect| effect.spec.effect_id == "blessing_001[1]")
            .unwrap()
            .spec
            .modifiers
            .attack_bp;
        observed.insert(progress.initiative, applied_attack_bp);
    }
    assert_eq!(observed[&Side::Player], 5_000);
    assert_eq!(observed[&Side::Enemy], 2_500);
}

#[test]
fn rectangular_rotating_grid_is_accepted_without_square_coercion() {
    let (catalog, mut setup) = load();
    setup.rules.grid.depths = 3;
    setup.rules.grid.blocked = BTreeSet::from([(0, 1), (0, 2), (1, 2), (2, 2), (3, 1), (3, 2)]);
    assert!(BattleEngine::new(catalog, setup, 1).is_ok());
}

#[test]
fn blessing_durations_use_all_turn_boundaries_and_permanent_effects_do_not_expire() {
    let (catalog, mut setup) = load();
    setup = durable_setup(setup);
    let config = setup.golden_colosseum.as_mut().unwrap();
    for side in &mut config.side_blessings {
        side.going_first.selected.clear();
        side.going_second.selected.clear();
    }
    for loadout in [
        &mut config.side_blessings[Side::Player.index()].going_first,
        &mut config.side_blessings[Side::Player.index()].going_second,
    ] {
        loadout.selected = vec![
            BlessingSelection {
                blessing_id: "blessing_041".into(),
                level: 1,
            },
            BlessingSelection {
                blessing_id: "blessing_038".into(),
                level: 1,
            },
        ];
        loadout.point_limit = 3;
    }
    let mut engine = BattleEngine::new(catalog, setup, 17).unwrap();
    assert!(
        engine.state().units[&1]
            .effects
            .iter()
            .any(|effect| effect.spec.effect_id == "blessing_041[1]")
    );
    assert!(
        !engine.state().units[&1]
            .effects
            .iter()
            .any(|effect| effect.spec.effect_id == "blessing_038[1]")
    );

    while engine.state().golden_colosseum.as_ref().unwrap().all_turn < 2 {
        engine.step_auto().unwrap();
    }
    assert!(
        !engine.state().units[&1]
            .effects
            .iter()
            .any(|effect| effect.spec.effect_id == "blessing_041[1]")
    );
    assert!(
        engine.state().units[&1]
            .effects
            .iter()
            .any(|effect| effect.spec.effect_id == "blessing_038[1]")
    );

    while engine.state().golden_colosseum.as_ref().unwrap().all_turn < 3 {
        engine.step_auto().unwrap();
    }
    assert!(
        engine.state().units[&1]
            .effects
            .iter()
            .any(|effect| effect.spec.effect_id == "blessing_038[1]")
    );
}

#[test]
fn costume_actions_alternate_individually_and_exhausted_side_does_not_repeat() {
    let (catalog, mut setup) = load();
    setup = durable_setup(setup);
    setup
        .units
        .retain(|unit| unit.side == Side::Player || matches!(unit.unit_id, 101 | 102));
    let mut engine = (0..64)
        .find_map(|seed| {
            let candidate = BattleEngine::new(Arc::clone(&catalog), setup.clone(), seed).unwrap();
            (candidate.state().active_side == Side::Player).then_some(candidate)
        })
        .unwrap();
    let mut actors = Vec::new();
    while engine.state().golden_colosseum.as_ref().unwrap().all_turn == 1
        && engine.state().terminal.is_none()
    {
        let transition = engine.step_auto().unwrap();
        actors.extend(
            transition
                .events
                .into_iter()
                .filter_map(|event| match event.kind {
                    BattleEventKind::ActionStarted { actor_id, .. } => Some(actor_id),
                    _ => None,
                }),
        );
    }
    assert_eq!(&actors[..4], &[1, 101, 2, 102]);
    assert_eq!(&actors[4..], &[3]);
    assert_eq!(
        engine.state().golden_colosseum.as_ref().unwrap().all_turn,
        2
    );
    assert!(
        engine
            .state()
            .units
            .values()
            .all(|unit| unit.cooldowns.values().all(|cooldown| *cooldown == 0))
    );
}

#[test]
fn dead_next_costume_is_skipped_and_chain_never_resets() {
    let (catalog, mut setup) = load();
    setup = durable_setup(setup);
    let mut engine = (0..64)
        .find_map(|seed| {
            let candidate = BattleEngine::new(Arc::clone(&catalog), setup.clone(), seed).unwrap();
            (candidate.state().active_side == Side::Player).then_some(candidate)
        })
        .unwrap();
    let mut state = engine.snapshot();
    state.units.get_mut(&101).unwrap().alive = false;
    state.units.get_mut(&101).unwrap().hp = 0;
    engine = BattleEngine::from_state(Arc::clone(&catalog), state).unwrap();
    engine.step_auto().unwrap();
    assert_eq!(engine.state().active_side, Side::Enemy);
    let legal = engine.legal_actions(Side::Enemy);
    assert!(
        legal
            .iter()
            .find(|entry| entry.unit_id == 101)
            .unwrap()
            .commands
            .is_empty()
    );
    assert!(
        !legal
            .iter()
            .find(|entry| entry.unit_id == 102)
            .unwrap()
            .commands
            .is_empty()
    );

    let target = 102;
    let mut state = engine.snapshot();
    state.teams[0].chain_by_target.insert(target, 7);
    engine = BattleEngine::from_state(Arc::clone(&catalog), state).unwrap();
    while engine.state().golden_colosseum.as_ref().unwrap().all_turn == 1
        && engine.state().terminal.is_none()
    {
        engine.step_auto().unwrap();
    }
    assert!(engine.state().teams[0].chain_by_target[&target] >= 7);
}

#[test]
fn death_time_stacks_every_two_all_turns_and_disables_skills() {
    let (catalog, setup) = load();
    let mut engine = BattleEngine::new(Arc::clone(&catalog), durable_setup(setup), 3).unwrap();
    while engine.state().golden_colosseum.as_ref().unwrap().all_turn < 7
        && engine.state().terminal.is_none()
    {
        engine.step_auto().unwrap();
    }
    let progress = engine.state().golden_colosseum.as_ref().unwrap();
    assert_eq!(progress.all_turn, 7);
    assert_eq!(progress.death_time_stacks, 2);
    let actor = engine.state().teams[engine.state().active_side.index()]
        .action_order
        .iter()
        .copied()
        .find(|id| engine.state().units[id].alive)
        .unwrap();
    let commands = engine.legal_actions_for_unit(actor).unwrap().commands;
    assert_eq!(commands, vec![bd2_core::UnitCommand::NormalAttack]);
    assert!(engine.state().units[&actor].effects.iter().any(|effect| {
        effect.spec.tags.contains("DEATH_TIME")
            && effect.spec.modifiers.attack_bp == 10_000
            && effect.spec.modifiers.defense_bp == -10_000
    }));
}

#[test]
fn invalid_colosseum_configs_fail_closed() {
    let (catalog, setup) = load();
    let mut multiple_costumes = setup.clone();
    let extra = multiple_costumes.units[0].costume_loadout[0].clone();
    multiple_costumes.units[0].costume_loadout.push(extra);
    assert!(BattleEngine::new(Arc::clone(&catalog), multiple_costumes, 1).is_err());

    let mut over_budget = setup.clone();
    over_budget
        .golden_colosseum
        .as_mut()
        .unwrap()
        .side_blessings[0]
        .going_first
        .point_limit = 1;
    assert!(BattleEngine::new(Arc::clone(&catalog), over_budget, 1).is_err());

    let mut banned = setup.clone();
    let deployed = banned.units[0].costume_loadout[0].costume_id.clone();
    banned
        .golden_colosseum
        .as_mut()
        .unwrap()
        .banned_costume_ids
        .insert(deployed);
    assert!(BattleEngine::new(Arc::clone(&catalog), banned, 1).is_err());

    let mut duplicate_costume = setup.clone();
    duplicate_costume.units[1].character_id = duplicate_costume.units[0].character_id.clone();
    duplicate_costume.units[1].costume_loadout = duplicate_costume.units[0].costume_loadout.clone();
    duplicate_costume.units[1].ai_priority = duplicate_costume.units[0].ai_priority.clone();
    assert!(BattleEngine::new(Arc::clone(&catalog), duplicate_costume, 1).is_err());

    let mut configurable_bond = setup.clone();
    configurable_bond.units[0].costume_loadout[0].costume_link_target = Some(
        configurable_bond.units[0].costume_loadout[0]
            .costume_id
            .clone(),
    );
    assert!(BattleEngine::new(Arc::clone(&catalog), configurable_bond, 1).is_err());

    let mut malformed_flow = setup;
    malformed_flow.rules.cooldowns_disabled = false;
    assert!(BattleEngine::new(catalog, malformed_flow, 1).is_err());
}

#[test]
fn undeployable_cell_count_mismatch_fails_closed() {
    let (catalog, mut setup) = load();
    let blocked = *setup.rules.grid.blocked.iter().next().unwrap();
    setup.rules.grid.blocked.remove(&blocked);
    assert!(BattleEngine::new(catalog, setup, 1).is_err());
}
