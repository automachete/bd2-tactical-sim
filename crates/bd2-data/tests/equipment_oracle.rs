use std::{collections::BTreeMap, fs, path::PathBuf, sync::Arc};

use bd2_core::{
    BattleEngine, BattleSetup, Catalog, Cell, EquipmentLoadout, EquipmentSlot, EquipmentStat,
    ModeRules, Side, StatModifiers, Stats, UnitBuildSettings, UnitSetup,
    resolve_equipment_modifiers,
};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct Oracle {
    scope: Scope,
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
struct Scope {
    equipment_count: usize,
    case_count: usize,
    crafted_legendary_count: usize,
    exclusive_count: usize,
}

#[derive(Debug, Deserialize)]
struct Case {
    equipment_id: String,
    owner_character_id: Option<String>,
    slot: EquipmentSlot,
    refinement_score: u8,
    primary_stat: Option<EquipmentStat>,
    secondary_stat: Option<EquipmentStat>,
    modifiers: StatModifiers,
}

fn workspace_path(relative: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(relative)
}

fn load() -> (Catalog, Oracle) {
    let catalog = serde_json::from_str(
        &fs::read_to_string(workspace_path("data/generated/catalog.json")).unwrap(),
    )
    .unwrap();
    let oracle = serde_json::from_str(
        &fs::read_to_string(workspace_path(
            "docs/validation/bd2db-current-equipment-oracle.json",
        ))
        .unwrap(),
    )
    .unwrap();
    (catalog, oracle)
}

#[test]
fn every_current_bd2db_equipment_main_stat_case_passes_the_battle_resolver() {
    let (catalog, oracle) = load();
    assert_eq!(catalog.equipment.len(), oracle.scope.equipment_count);
    assert_eq!(oracle.cases.len(), oracle.scope.case_count);
    assert_eq!(oracle.scope.equipment_count, 91);
    assert_eq!(oracle.scope.case_count, 3_626);
    assert_eq!(oracle.scope.crafted_legendary_count, 30);
    assert_eq!(oracle.scope.exclusive_count, 61);

    let fallback_character = catalog
        .characters
        .values()
        .find(|character| character.rarity == 5 && !character.id.contains(':'))
        .unwrap()
        .id
        .clone();
    let catalog = Arc::new(catalog);
    for case in oracle.cases {
        let definition = &catalog.equipment[&case.equipment_id];
        let substat = definition.allowed_substats[0];
        let loadout = EquipmentLoadout {
            equipment_id: case.equipment_id.clone(),
            refinement_score: case.refinement_score,
            primary_stat: case.primary_stat,
            secondary_stat: case.secondary_stat,
            substats: vec![substat; 3],
        };
        let character_id = case
            .owner_character_id
            .as_deref()
            .unwrap_or(&fallback_character);
        let actual = resolve_equipment_modifiers(
            &catalog,
            character_id,
            &BTreeMap::from([(case.slot, loadout)]),
        )
        .unwrap();
        let mut expected = case.modifiers;
        let substat_modifier = &definition.substat_modifiers[&substat];
        for _ in 0..3 {
            add(&mut expected, substat_modifier);
        }
        assert_eq!(
            actual, expected,
            "{} score {}",
            case.equipment_id, case.refinement_score
        );

        let mut all_modifiers = catalog.characters[character_id].engraving_modifiers.clone();
        add(
            &mut all_modifiers,
            &catalog.characters[character_id].awakening_modifiers,
        );
        all_modifiers.max_hp_bp += 8_000;
        all_modifiers.attack_bp += 8_000;
        all_modifiers.magic_bp += 8_000;
        all_modifiers.crit_rate_bp += 5_000;
        add(&mut all_modifiers, &expected);
        let expected_stats = apply(&catalog.characters[character_id].level_100, &all_modifiers);
        let engine = BattleEngine::new(
            Arc::clone(&catalog),
            BattleSetup {
                scenario_id: format!(
                    "equipment-oracle-{}-{}",
                    case.equipment_id, case.refinement_score
                ),
                rules: ModeRules::normal(),
                units: vec![
                    UnitSetup {
                        unit_id: 1,
                        character_id: character_id.to_string(),
                        side: Side::Player,
                        position: Cell { row: 0, depth: 0 },
                        costume_loadout: vec![],
                        build_settings: UnitBuildSettings::default(),
                        stat_overrides: None,
                        equipment: BTreeMap::from([(
                            case.slot,
                            EquipmentLoadout {
                                equipment_id: case.equipment_id.clone(),
                                refinement_score: case.refinement_score,
                                primary_stat: case.primary_stat,
                                secondary_stat: case.secondary_stat,
                                substats: vec![substat; 3],
                            },
                        )]),
                        ai_priority: vec![],
                        party_no: 1,
                        hp_owner: None,
                        weak_point_bonus_bp: 0,
                        can_act: true,
                    },
                    UnitSetup {
                        unit_id: 2,
                        character_id: character_id.to_string(),
                        side: Side::Enemy,
                        position: Cell { row: 0, depth: 0 },
                        costume_loadout: vec![],
                        build_settings: UnitBuildSettings::unmodified(),
                        stat_overrides: None,
                        equipment: BTreeMap::new(),
                        ai_priority: vec![],
                        party_no: 1,
                        hp_owner: None,
                        weak_point_bonus_bp: 0,
                        can_act: true,
                    },
                ],
                monster_chaser: None,
                golden_colosseum: None,
            },
            1,
        )
        .unwrap();
        assert_eq!(
            engine.state().units[&1].base_stats,
            expected_stats,
            "full BD2DB stat mismatch for {} score {}",
            case.equipment_id,
            case.refinement_score,
        );
    }
}

#[test]
fn exclusive_owner_and_main_ability_constraints_fail_closed() {
    let (catalog, _) = load();
    let definition = catalog
        .equipment
        .values()
        .find(|equipment| equipment.owner_character_id.is_some())
        .unwrap();
    let valid = EquipmentLoadout {
        equipment_id: definition.id.clone(),
        refinement_score: 18,
        primary_stat: Some(definition.primary_stat_options[0]),
        secondary_stat: Some(definition.secondary_stat_options[0]),
        substats: vec![definition.allowed_substats[0]; 3],
    };
    let owner = definition.owner_character_id.as_deref().unwrap();

    assert!(
        resolve_equipment_modifiers(
            &catalog,
            "not-the-owner",
            &BTreeMap::from([(definition.slot, valid.clone())]),
        )
        .is_err()
    );

    let mut missing_primary = valid.clone();
    missing_primary.primary_stat = None;
    assert!(
        resolve_equipment_modifiers(
            &catalog,
            owner,
            &BTreeMap::from([(definition.slot, missing_primary)]),
        )
        .is_err()
    );

    let mut wrong_score = valid;
    wrong_score.refinement_score = 17;
    assert!(
        resolve_equipment_modifiers(
            &catalog,
            owner,
            &BTreeMap::from([(definition.slot, wrong_score)]),
        )
        .is_err()
    );
}

fn add(total: &mut StatModifiers, value: &StatModifiers) {
    total.max_hp_flat += value.max_hp_flat;
    total.max_hp_bp += value.max_hp_bp;
    total.attack_flat += value.attack_flat;
    total.attack_bp += value.attack_bp;
    total.magic_flat += value.magic_flat;
    total.magic_bp += value.magic_bp;
    total.defense_bp += value.defense_bp;
    total.magic_resist_bp += value.magic_resist_bp;
    total.crit_rate_bp += value.crit_rate_bp;
    total.crit_damage_bp += value.crit_damage_bp;
    total.property_damage_bp += value.property_damage_bp;
    total.outgoing_damage_bp += value.outgoing_damage_bp;
    total.incoming_damage_bp += value.incoming_damage_bp;
    total.amplification_bp += value.amplification_bp;
}

fn apply(base: &Stats, modifiers: &StatModifiers) -> Stats {
    let scaled = |value: i64, flat: i64, bp: i32| {
        (i128::from(value.saturating_add(flat)) * i128::from(10_000 + bp) / 10_000) as i64
    };
    Stats {
        max_hp: scaled(base.max_hp, modifiers.max_hp_flat, modifiers.max_hp_bp).max(1),
        attack: scaled(base.attack, modifiers.attack_flat, modifiers.attack_bp).max(0),
        magic: scaled(base.magic, modifiers.magic_flat, modifiers.magic_bp).max(0),
        crit_rate_bp: base.crit_rate_bp + modifiers.crit_rate_bp,
        crit_damage_bp: base.crit_damage_bp + modifiers.crit_damage_bp,
        defense_bp: base.defense_bp + modifiers.defense_bp,
        magic_resist_bp: base.magic_resist_bp + modifiers.magic_resist_bp,
        property_damage_bp: base.property_damage_bp + modifiers.property_damage_bp,
        outgoing_damage_bp: base.outgoing_damage_bp + modifiers.outgoing_damage_bp,
        incoming_damage_bp: base.incoming_damage_bp + modifiers.incoming_damage_bp,
        amplification_bp: base.amplification_bp + modifiers.amplification_bp,
    }
}
