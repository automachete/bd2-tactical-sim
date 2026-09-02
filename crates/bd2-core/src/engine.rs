use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

use crate::{
    ActiveEffect, AttackType, BattleError, BattleEvent, BattleEventKind, BattleMode, BattleSetup,
    BattleState, Catalog, Cell, CostumeDefinition, DamageKind, DurationClock, EffectPolarity,
    EffectRecipient, EquipmentKind, EquipmentLoadout, EquipmentSlot, LegalUnitActions, Observation,
    Outcome, Result, Side, SkillOperation, SkillVariant, StatModifiers, StatReference, Stats,
    TargetSelector, TeamState, TeamTurnPlan, TerminalResult, Transition, UnitCommand, UnitId,
    UnitObservation, UnitState,
};

#[derive(Debug, Clone)]
pub struct BattleEngine {
    catalog: Arc<Catalog>,
    state: BattleState,
    reaction_depth: u8,
    current_skill_sp_cost: i32,
    current_skill_base_sp_cost: i32,
    current_received_damage: i64,
    current_skill_successful_hits: u32,
    current_skill_actor: Option<UnitId>,
}

impl BattleEngine {
    pub fn new(catalog: Arc<Catalog>, setup: BattleSetup, seed: u64) -> Result<Self> {
        validate_setup(&catalog, &setup)?;
        let mut units = BTreeMap::new();
        let mut orders = [Vec::new(), Vec::new()];

        for unit in &setup.units {
            let character = catalog.characters.get(&unit.character_id).ok_or_else(|| {
                BattleError::MissingCatalogEntry {
                    kind: "character",
                    id: unit.character_id.clone(),
                }
            })?;
            let mut stats = unit
                .stat_overrides
                .clone()
                .unwrap_or_else(|| character.level_100.clone());
            let mut loadout_modifiers = StatModifiers::default();
            if unit.build_settings.engraving_enabled {
                accumulate_modifiers(&mut loadout_modifiers, &character.engraving_modifiers);
            }
            if unit.build_settings.awakening_enabled {
                accumulate_modifiers(&mut loadout_modifiers, &character.awakening_modifiers);
            }
            accumulate_modifiers(
                &mut loadout_modifiers,
                &build_settings_modifiers(character.attack_type, &unit.build_settings),
            );
            for loadout in &unit.costume_loadout {
                let costume = &catalog.costumes[&loadout.costume_id];
                if loadout.permanent_potential_enabled {
                    accumulate_modifiers(
                        &mut loadout_modifiers,
                        &costume.permanent_potential_modifiers,
                    );
                }
            }
            if let Some(bond_id) = unit
                .costume_loadout
                .iter()
                .find_map(|loadout| loadout.costume_link_target.as_deref())
            {
                accumulate_modifiers(
                    &mut loadout_modifiers,
                    &catalog.costumes[bond_id].bonding_modifiers,
                );
            }
            let equipment_modifiers =
                resolve_equipment_modifiers(&catalog, &unit.character_id, &unit.equipment)?;
            accumulate_modifiers(&mut loadout_modifiers, &equipment_modifiers);
            apply_permanent_modifiers(&mut stats, &loadout_modifiers);
            let external_energy_guard = unit
                .build_settings
                .external_buffs
                .shield_flat
                .saturating_add(mul_floor(
                    stats.max_hp,
                    unit.build_settings.external_buffs.shield_percent_bp,
                ))
                .max(0);
            let passive_modifiers = runtime_passive_modifiers(&loadout_modifiers);
            let initially_active = setup.rules.mode != BattleMode::MonsterChaser
                || unit.side == Side::Enemy
                || unit.party_no == 1;
            units.insert(
                unit.unit_id,
                UnitState {
                    id: unit.unit_id,
                    character_id: unit.character_id.clone(),
                    side: unit.side,
                    position: unit.position,
                    alive: initially_active,
                    hp: stats.max_hp,
                    base_stats: stats,
                    passive_modifiers,
                    costume_loadout: unit.costume_loadout.clone(),
                    cooldowns: unit
                        .costume_loadout
                        .iter()
                        .map(|costume| (costume.costume_id.clone(), 0))
                        .collect(),
                    effects: Vec::new(),
                    external_energy_guard,
                    ai_priority: unit.ai_priority.clone(),
                    party_no: unit.party_no,
                    hp_owner: unit.hp_owner,
                    weak_point_bonus_bp: unit.weak_point_bonus_bp,
                    is_summon: false,
                    summoned_by: None,
                    triggered_skill_uses: BTreeMap::new(),
                    can_act: unit.can_act,
                },
            );
            if initially_active && unit.can_act {
                orders[unit.side.index()].push(unit.unit_id);
            }
        }

        let monster_chaser = setup.monster_chaser.as_ref().map(|config| {
            let selected_index = config.selected_level.saturating_sub(1) as usize;
            let mut previous = 0_i64;
            let level_hp_segments: Vec<_> = config
                .cumulative_hp_by_level
                .iter()
                .take(selected_index + 1)
                .map(|threshold| {
                    let segment = threshold.saturating_sub(previous);
                    previous = *threshold;
                    segment
                })
                .collect();
            crate::MonsterChaserState {
                monster_id: config.monster_id.clone(),
                selected_level: config.selected_level,
                current_level: 1,
                battle_hp_remaining: config
                    .cumulative_hp_by_level
                    .get(selected_index)
                    .copied()
                    .unwrap_or_default(),
                segment_hp_remaining: level_hp_segments.first().copied().unwrap_or_default(),
                level_hp_segments,
                cumulative_damage: 0,
                current_party: 1,
                party_limit: config.party_limit,
                turn_sp_recovery: config.turn_sp_recovery,
            }
        });

        let mut engine = Self {
            catalog: Arc::clone(&catalog),
            state: BattleState {
                ruleset_id: catalog.ruleset_id.clone(),
                scenario_id: setup.scenario_id,
                active_side: setup.rules.first_side,
                game_turn: 1,
                round_no: 1,
                action_sequence: 0,
                event_sequence: 0,
                units,
                teams: [
                    TeamState {
                        side: Side::Player,
                        sp: setup.rules.initial_sp[0],
                        action_order: orders[0].clone(),
                        chain_by_target: BTreeMap::new(),
                    },
                    TeamState {
                        side: Side::Enemy,
                        sp: setup.rules.initial_sp[1],
                        action_order: orders[1].clone(),
                        chain_by_target: BTreeMap::new(),
                    },
                ],
                rules: setup.rules,
                pending_events: Vec::new(),
                event_log: Vec::new(),
                damage_by_source: BTreeMap::new(),
                rng: crate::DeterministicRng::new(seed),
                terminal: None,
                monster_chaser,
                next_effect_instance_id: 1,
            },
            reaction_depth: 0,
            current_skill_sp_cost: 0,
            current_skill_base_sp_cost: 0,
            current_received_damage: 0,
            current_skill_successful_hits: 0,
            current_skill_actor: None,
        };
        engine.emit(BattleEventKind::BattleStarted {
            first_side: engine.state.active_side,
        });
        if let Some(level) = engine
            .state
            .monster_chaser
            .as_ref()
            .map(|progress| progress.selected_level)
        {
            engine.update_monster_stats(level);
            engine.sync_monster_part_hp();
        }
        engine.execute_preemptives()?;
        Ok(engine)
    }

    pub fn from_state(catalog: Arc<Catalog>, state: BattleState) -> Result<Self> {
        if state.ruleset_id != catalog.ruleset_id {
            return Err(BattleError::InvalidScenario(format!(
                "state ruleset '{}' does not match catalog '{}'",
                state.ruleset_id, catalog.ruleset_id
            )));
        }
        Ok(Self {
            catalog,
            state,
            reaction_depth: 0,
            current_skill_sp_cost: 0,
            current_skill_base_sp_cost: 0,
            current_received_damage: 0,
            current_skill_successful_hits: 0,
            current_skill_actor: None,
        })
    }

    pub fn state(&self) -> &BattleState {
        &self.state
    }

    pub fn snapshot(&self) -> BattleState {
        self.state.clone()
    }

    pub fn state_json(&self) -> Result<String> {
        Ok(serde_json::to_string(&self.state)?)
    }

    pub fn restore_json(&mut self, json: &str) -> Result<()> {
        let state: BattleState = serde_json::from_str(json)?;
        if state.ruleset_id != self.catalog.ruleset_id {
            return Err(BattleError::InvalidScenario("ruleset mismatch".into()));
        }
        self.state = state;
        Ok(())
    }

    pub fn observation(&self) -> Observation {
        let mut units = Vec::with_capacity(self.state.units.len());
        let mut action_mask = Vec::with_capacity(self.state.units.len());
        for unit in self.state.units.values() {
            let hp_unit = unit
                .hp_owner
                .and_then(|owner| self.state.units.get(&owner))
                .unwrap_or(unit);
            units.push(UnitObservation {
                id: unit.id,
                side: unit.side,
                alive: unit.alive,
                hp_ratio: if hp_unit.base_stats.max_hp > 0 {
                    hp_unit.hp as f32 / hp_unit.base_stats.max_hp as f32
                } else {
                    0.0
                },
                row: unit.position.row,
                depth: unit.position.depth,
                cooldowns: unit.cooldowns.values().copied().collect(),
                effect_count: unit.effects.len(),
            });
            action_mask.push(
                self.legal_actions_for_unit(unit.id)
                    .map(|actions| vec![true; actions.commands.len()])
                    .unwrap_or_default(),
            );
        }
        Observation {
            active_side: self.state.active_side,
            turn: self.state.game_turn,
            round: self.state.round_no,
            sp: [self.state.teams[0].sp, self.state.teams[1].sp],
            units,
            action_mask,
            terminal: self.state.terminal.is_some(),
        }
    }

    pub fn legal_actions(&self, side: Side) -> Vec<LegalUnitActions> {
        self.state.teams[side.index()]
            .action_order
            .iter()
            .filter_map(|id| self.legal_actions_for_unit(*id).ok())
            .collect()
    }

    pub fn legal_actions_for_unit(&self, unit_id: UnitId) -> Result<LegalUnitActions> {
        let unit = self
            .state
            .units
            .get(&unit_id)
            .ok_or_else(|| BattleError::IllegalAction(format!("unknown unit {unit_id}")))?;
        if !unit.alive {
            return Ok(LegalUnitActions {
                unit_id,
                commands: Vec::new(),
            });
        }
        if !unit.can_act {
            return Ok(LegalUnitActions {
                unit_id,
                commands: Vec::new(),
            });
        }
        let mut commands = vec![UnitCommand::NormalAttack, UnitCommand::Knockback];
        if !has_tag(unit, "SILENCE") {
            let available_sp = self.state.teams[unit.side.index()].sp;
            for loadout in &unit.costume_loadout {
                if unit
                    .cooldowns
                    .get(&loadout.costume_id)
                    .copied()
                    .unwrap_or(0)
                    > 0
                {
                    continue;
                }
                let Some(costume) = self.catalog.costumes.get(&loadout.costume_id) else {
                    continue;
                };
                if !costume.executable {
                    continue;
                }
                for burst_level in 0..=loadout.burst_level {
                    let Some(variant) = select_variant(
                        costume,
                        loadout.enhancement,
                        burst_level,
                        loadout.potential_mask,
                    ) else {
                        continue;
                    };
                    if variant.burst_level != burst_level || !variant.executable {
                        continue;
                    }
                    let cost = adjusted_sp_cost(variant.sp_cost, &effective_modifiers(unit));
                    if available_sp >= cost {
                        commands.push(UnitCommand::UseCostume {
                            costume_id: loadout.costume_id.clone(),
                            burst_level,
                            explicit_target: None,
                        });
                    }
                }
            }
        }
        Ok(LegalUnitActions { unit_id, commands })
    }

    pub fn auto_plan(&self, side: Side) -> TeamTurnPlan {
        let order = self.state.teams[side.index()].action_order.clone();
        let mut commands = BTreeMap::new();
        let mut reserved_sp = self.state.teams[side.index()].sp;
        for unit_id in &order {
            let Some(unit) = self.state.units.get(unit_id) else {
                continue;
            };
            if !unit.alive || !unit.can_act {
                continue;
            }
            let legal = self.legal_actions_for_unit(*unit_id).ok();
            let mut candidates = legal.map(|x| x.commands).unwrap_or_default();
            candidates.retain(|command| match command {
                UnitCommand::UseCostume {
                    costume_id,
                    burst_level,
                    ..
                } => self
                    .resolve_variant(unit, costume_id, *burst_level)
                    .map(|variant| {
                        adjusted_sp_cost(variant.sp_cost, &effective_modifiers(unit)) <= reserved_sp
                            && !(self.state.rules.mode == BattleMode::MonsterChaser
                                && side == Side::Enemy
                                && variant.activation_condition.is_some())
                    })
                    .unwrap_or(false),
                _ => true,
            });
            let scripted =
                if self.state.rules.mode == BattleMode::MonsterChaser && side == Side::Enemy {
                    let sequence_len = unit
                        .costume_loadout
                        .iter()
                        .filter_map(|loadout| {
                            self.resolve_variant(unit, &loadout.costume_id, loadout.burst_level)
                                .ok()?
                                .ai_sequence_index
                        })
                        .max()
                        .unwrap_or(0);
                    let wanted = if sequence_len == 0 {
                        0
                    } else {
                        ((self.state.round_no.saturating_sub(1) as u16) % sequence_len) + 1
                    };
                    candidates
                        .iter()
                        .rev()
                        .find(|command| match command {
                            UnitCommand::UseCostume {
                                costume_id,
                                burst_level,
                                ..
                            } => {
                                self.resolve_variant(unit, costume_id, *burst_level)
                                    .ok()
                                    .and_then(|variant| variant.ai_sequence_index)
                                    == Some(wanted)
                            }
                            _ => false,
                        })
                        .cloned()
                } else {
                    None
                };
            let selected = scripted.or_else(|| unit
                .ai_priority
                .iter()
                .find_map(|wanted| {
                    candidates.iter().rev().find(|command| matches!(command, UnitCommand::UseCostume { costume_id, .. } if costume_id == wanted)).cloned()
                })
                .or_else(|| candidates.iter().rev().find(|command| matches!(command, UnitCommand::UseCostume { .. })).cloned())
            ).unwrap_or(UnitCommand::NormalAttack);
            if let UnitCommand::UseCostume {
                costume_id,
                burst_level,
                ..
            } = &selected
                && let Ok(variant) = self.resolve_variant(unit, costume_id, *burst_level)
            {
                if variant.consume_remaining_sp {
                    reserved_sp = 0;
                } else {
                    reserved_sp -= adjusted_sp_cost(variant.sp_cost, &effective_modifiers(unit));
                }
            }
            commands.insert(*unit_id, selected);
        }
        TeamTurnPlan {
            side,
            order,
            commands,
            formation: BTreeMap::new(),
        }
    }

    pub fn step_auto(&mut self) -> Result<Transition> {
        let plan = self.auto_plan(self.state.active_side);
        self.step(plan)
    }

    fn execute_preemptives(&mut self) -> Result<()> {
        for side in [
            self.state.rules.first_side,
            self.state.rules.first_side.opponent(),
        ] {
            let ids = self.state.teams[side.index()].action_order.clone();
            for id in ids {
                let Some(unit) = self.state.units.get(&id).cloned() else {
                    continue;
                };
                if !unit.alive {
                    continue;
                }
                let ordered_costumes: Vec<_> = unit
                    .ai_priority
                    .iter()
                    .chain(
                        unit.costume_loadout
                            .iter()
                            .map(|loadout| &loadout.costume_id),
                    )
                    .collect();
                let mut seen = BTreeSet::new();
                for costume_id in ordered_costumes {
                    if !seen.insert(costume_id.clone()) {
                        continue;
                    }
                    let Some(loadout) = unit
                        .costume_loadout
                        .iter()
                        .find(|loadout| &loadout.costume_id == costume_id)
                    else {
                        continue;
                    };
                    let Some(costume) = self.catalog.costumes.get(costume_id) else {
                        continue;
                    };
                    let Some(variant) = select_variant(
                        costume,
                        loadout.enhancement,
                        loadout.burst_level,
                        loadout.potential_mask,
                    ) else {
                        continue;
                    };
                    if variant.preemptive && variant.executable {
                        self.execute_command(
                            id,
                            UnitCommand::UseCostume {
                                costume_id: costume_id.clone(),
                                burst_level: loadout.burst_level,
                                explicit_target: None,
                            },
                        )?;
                        self.state.action_sequence += 1;
                    }
                }
            }
        }
        self.evaluate_terminal();
        Ok(())
    }

    pub fn step(&mut self, plan: TeamTurnPlan) -> Result<Transition> {
        let checkpoint = self.clone();
        match self.step_inner(plan) {
            Ok(transition) => Ok(transition),
            Err(error) => {
                *self = checkpoint;
                Err(error)
            }
        }
    }

    fn step_inner(&mut self, plan: TeamTurnPlan) -> Result<Transition> {
        if self.state.terminal.is_some() {
            return Err(BattleError::AlreadyTerminal);
        }
        if plan.side != self.state.active_side {
            return Err(BattleError::IllegalAction(format!(
                "expected {:?} plan, got {:?}",
                self.state.active_side, plan.side
            )));
        }

        let start_log = self.state.event_log.len();
        let side = self.state.active_side;
        self.emit(BattleEventKind::TurnStarted {
            side,
            turn: self.state.game_turn,
            sp: self.state.teams[side.index()].sp,
        });
        self.apply_formation(side, &plan.formation)?;
        let order = if plan.order.is_empty() {
            self.state.teams[side.index()].action_order.clone()
        } else {
            self.validate_order(side, &plan.order)?;
            plan.order.clone()
        };
        self.state.teams[side.index()].action_order = order.clone();

        for unit_id in order {
            if self.state.terminal.is_some() {
                break;
            }
            let Some(actor) = self.state.units.get(&unit_id) else {
                continue;
            };
            if !actor.alive {
                self.emit(BattleEventKind::ActionSkipped {
                    actor_id: unit_id,
                    reason: "DEAD".into(),
                });
                continue;
            }
            if !actor.can_act {
                self.emit(BattleEventKind::ActionSkipped {
                    actor_id: unit_id,
                    reason: "CANNOT_ACT".into(),
                });
                continue;
            }
            let command = plan
                .commands
                .get(&unit_id)
                .cloned()
                .unwrap_or(UnitCommand::NormalAttack);
            if let Err(error) = self.execute_command(unit_id, command.clone()) {
                self.emit(BattleEventKind::ActionSkipped {
                    actor_id: unit_id,
                    reason: error.to_string(),
                });
                self.execute_command(unit_id, UnitCommand::NormalAttack)?;
            }
            self.state.action_sequence += 1;
            self.tick_action_effects(unit_id);
            self.evaluate_terminal();
            if side == Side::Player
                && self.state.rules.mode == BattleMode::MonsterChaser
                && self.state.terminal.is_none()
            {
                self.trigger_monster_conditionals()?;
                self.evaluate_terminal();
            }
        }

        self.finish_turn(side);
        self.evaluate_terminal();
        let events = self.state.event_log[start_log..].to_vec();
        Ok(Transition {
            events,
            terminal: self.state.terminal.clone(),
        })
    }

    fn trigger_monster_conditionals(&mut self) -> Result<()> {
        let enemy_ids = self.state.teams[Side::Enemy.index()].action_order.clone();
        for actor_id in enemy_ids {
            let Some(unit) = self.state.units.get(&actor_id).cloned() else {
                continue;
            };
            if !unit.alive {
                continue;
            }
            for loadout in &unit.costume_loadout {
                let variant = self
                    .resolve_variant(&unit, &loadout.costume_id, loadout.burst_level)?
                    .clone();
                let Some(condition) = variant.activation_condition.as_ref() else {
                    continue;
                };
                let used = self.state.units[&actor_id]
                    .triggered_skill_uses
                    .get(&loadout.costume_id)
                    .copied()
                    .unwrap_or(0);
                if variant
                    .max_uses_per_party
                    .is_some_and(|limit| used >= limit)
                {
                    continue;
                }
                if !self.condition_matches(actor_id, actor_id, actor_id, condition) {
                    continue;
                }
                self.execute_command(
                    actor_id,
                    UnitCommand::UseCostume {
                        costume_id: loadout.costume_id.clone(),
                        burst_level: loadout.burst_level,
                        explicit_target: None,
                    },
                )?;
                *self
                    .state
                    .units
                    .get_mut(&actor_id)
                    .unwrap()
                    .triggered_skill_uses
                    .entry(loadout.costume_id.clone())
                    .or_default() += 1;
                self.state.action_sequence += 1;
                self.tick_action_effects(actor_id);
                self.evaluate_terminal();
                if self.state.terminal.is_some() {
                    return Ok(());
                }
            }
        }
        Ok(())
    }

    fn execute_command(&mut self, actor_id: UnitId, command: UnitCommand) -> Result<()> {
        self.emit(BattleEventKind::ActionStarted {
            actor_id,
            command: command.clone(),
        });
        match command {
            UnitCommand::NormalAttack => {
                let selector = self.character_selector(actor_id)?;
                let target = self.select_main_target(actor_id, selector, None)?;
                self.emit(BattleEventKind::TargetLocked {
                    actor_id,
                    target_id: target,
                });
                let kind = match self.character_attack_type(actor_id)? {
                    AttackType::Physical => DamageKind::Physical,
                    AttackType::Magical => DamageKind::Magical,
                };
                let coefficient = 10_000
                    + effective_modifiers(&self.state.units[&actor_id]).normal_attack_damage_bp;
                self.deal_damage(
                    actor_id,
                    target,
                    kind,
                    coefficient,
                    None,
                    true,
                    true,
                    1,
                    1,
                    0,
                )?;
                self.consume_effect_charge(actor_id, "BASIC_ATTACK_AUGMENT");
                self.change_sp(self.state.units[&actor_id].side, 1, "NORMAL_ATTACK");
                Ok(())
            }
            UnitCommand::Knockback => {
                let selector = self.character_selector(actor_id)?;
                let target = self.select_main_target(actor_id, selector, None)?;
                self.emit(BattleEventKind::TargetLocked {
                    actor_id,
                    target_id: target,
                });
                self.apply_raw_damage(actor_id, target, 1, false, 1);
                if self.state.units.get(&target).is_some_and(|unit| unit.alive) {
                    self.knockback(target, crate::KnockbackDirection::Back, 1, 2_500)?;
                }
                self.change_sp(self.state.units[&actor_id].side, 1, "KNOCKBACK");
                Ok(())
            }
            UnitCommand::UseCostume {
                costume_id,
                burst_level,
                explicit_target,
            } => {
                let unit = self
                    .state
                    .units
                    .get(&actor_id)
                    .ok_or_else(|| BattleError::IllegalAction("actor missing".into()))?;
                if has_tag(unit, "SILENCE") {
                    return Err(BattleError::IllegalAction("actor is silenced".into()));
                }
                let variant = self
                    .resolve_variant(unit, &costume_id, burst_level)?
                    .clone();
                if !variant.executable {
                    return Err(BattleError::IllegalAction(
                        "skill variant is not compiled".into(),
                    ));
                }
                let costume = self.catalog.costumes[&costume_id].clone();
                let base_cost = adjusted_sp_cost(variant.sp_cost, &effective_modifiers(unit));
                if self.state.teams[unit.side.index()].sp < base_cost {
                    return Err(BattleError::IllegalAction("insufficient SP".into()));
                }
                if unit.cooldowns.get(&costume_id).copied().unwrap_or(0) > 0 {
                    return Err(BattleError::IllegalAction("costume is on cooldown".into()));
                }
                let side = unit.side;
                let cost = if variant.consume_remaining_sp {
                    self.state.teams[side.index()].sp
                } else {
                    base_cost
                };
                self.change_sp(side, -cost, "COSTUME_SKILL");
                self.current_skill_sp_cost = cost;
                self.current_skill_base_sp_cost = base_cost;
                self.current_skill_successful_hits = 0;
                self.current_skill_actor = Some(actor_id);
                let (target, targets) = if let Some(cell) = variant.fixed_target_cell {
                    let target_side = side.opponent();
                    self.emit(BattleEventKind::TargetCellLocked { actor_id, cell });
                    let targets = self.targets_in_range_cell(
                        cell,
                        target_side,
                        variant.range_override.as_deref().unwrap_or(&costume.range),
                    );
                    let main = self
                        .state
                        .units
                        .values()
                        .find(|target| {
                            target.alive && target.side == target_side && target.position == cell
                        })
                        .map(|target| target.id)
                        .or_else(|| targets.first().copied())
                        .unwrap_or(actor_id);
                    (main, targets)
                } else {
                    let target =
                        self.select_main_target(actor_id, variant.selector, explicit_target)?;
                    self.emit(BattleEventKind::TargetLocked {
                        actor_id,
                        target_id: target,
                    });
                    let target_side = self.state.units[&target].side;
                    let targets = if variant.target_all {
                        self.state
                            .units
                            .values()
                            .filter(|unit| unit.alive && unit.side == target_side)
                            .map(|unit| unit.id)
                            .collect()
                    } else {
                        self.targets_in_range(
                            target,
                            target_side,
                            variant.range_override.as_deref().unwrap_or(&costume.range),
                        )
                    };
                    (target, targets)
                };
                for operation in variant.operations.clone() {
                    self.execute_operation(actor_id, target, &targets, operation)?;
                }
                self.current_skill_sp_cost = 0;
                self.current_skill_base_sp_cost = 0;
                self.current_skill_actor = None;
                self.current_skill_successful_hits = 0;
                let before = self.state.units[&actor_id]
                    .cooldowns
                    .get(&costume_id)
                    .copied()
                    .unwrap_or(0);
                let modifiers = effective_modifiers(&self.state.units[&actor_id]);
                let after =
                    (variant.cooldown as i32 + modifiers.cooldown_delta as i32).max(0) as u16;
                self.state
                    .units
                    .get_mut(&actor_id)
                    .unwrap()
                    .cooldowns
                    .insert(costume_id.clone(), after);
                self.emit(BattleEventKind::CooldownChanged {
                    unit_id: actor_id,
                    costume_id,
                    before,
                    after,
                });
                Ok(())
            }
        }
    }

    fn effect_recipients(
        &self,
        actor_id: UnitId,
        _main_target: UnitId,
        targets: &[UnitId],
        recipient: EffectRecipient,
    ) -> Vec<UnitId> {
        match recipient {
            EffectRecipient::ActorSide => vec![actor_id],
            EffectRecipient::TargetSide => targets.to_vec(),
            EffectRecipient::ActorTeam | EffectRecipient::OpponentTeam => {
                let actor_side = self.state.units[&actor_id].side;
                let side = if recipient == EffectRecipient::ActorTeam {
                    actor_side
                } else {
                    actor_side.opponent()
                };
                self.state
                    .units
                    .values()
                    .filter(|unit| unit.alive && unit.side == side)
                    .map(|unit| unit.id)
                    .collect()
            }
        }
    }

    fn execute_operation(
        &mut self,
        actor_id: UnitId,
        main_target: UnitId,
        targets: &[UnitId],
        operation: SkillOperation,
    ) -> Result<()> {
        match operation {
            SkillOperation::DealDamage {
                kind,
                coefficient_bp,
                reference,
                scaling,
                hits,
                can_crit,
                can_evade,
                chain_per_hit,
                main_target_bonus_bp,
            } => {
                for target in targets.iter().copied() {
                    let scale_units = scaling
                        .as_ref()
                        .map(|scaling| match &scaling.source {
                            crate::DamageScalingSource::TargetCount => targets.len() as i32,
                            crate::DamageScalingSource::TargetCountMinusOne => {
                                targets.len().saturating_sub(1) as i32
                            }
                            crate::DamageScalingSource::ActorEffectCount { polarity } => {
                                self.state.units[&actor_id]
                                    .effects
                                    .iter()
                                    .filter(|effect| effect.spec.polarity == *polarity)
                                    .count() as i32
                            }
                            crate::DamageScalingSource::TargetEffectCount { polarity } => {
                                self.state.units[&target]
                                    .effects
                                    .iter()
                                    .filter(|effect| effect.spec.polarity == *polarity)
                                    .count() as i32
                            }
                            crate::DamageScalingSource::TargetTagStacks { tag } => self.state.units
                                [&target]
                                .effects
                                .iter()
                                .filter(|effect| effect.spec.tags.contains(tag))
                                .map(|effect| {
                                    i32::from(
                                        effect
                                            .spec
                                            .periodic
                                            .as_ref()
                                            .map(|periodic| periodic.stacks)
                                            .unwrap_or(1),
                                    )
                                })
                                .sum(),
                            crate::DamageScalingSource::SkillSpCost => self.current_skill_sp_cost,
                            crate::DamageScalingSource::ExtraSpConsumed => self
                                .current_skill_sp_cost
                                .saturating_sub(self.current_skill_base_sp_cost),
                        })
                        .unwrap_or(0);
                    let scaled_coefficient = coefficient_bp.saturating_add(
                        scaling
                            .as_ref()
                            .map(|scaling| {
                                scaling.coefficient_bp_per_unit.saturating_mul(scale_units)
                            })
                            .unwrap_or(0),
                    );
                    self.deal_damage(
                        actor_id,
                        target,
                        kind,
                        scaled_coefficient,
                        reference,
                        can_crit,
                        can_evade,
                        hits,
                        chain_per_hit,
                        if target == main_target {
                            main_target_bonus_bp
                        } else {
                            0
                        },
                    )?;
                }
            }
            SkillOperation::Heal {
                coefficient_bp,
                reference,
                can_crit,
                recipient,
            } => {
                let heal_targets =
                    self.effect_recipients(actor_id, main_target, targets, recipient);
                for target in heal_targets {
                    self.heal(actor_id, target, coefficient_bp, reference, can_crit);
                }
            }
            SkillOperation::ConsumeHp {
                coefficient_bp,
                reference,
                can_kill,
            } => {
                let base = self.reference_value(actor_id, actor_id, reference);
                let mut amount = mul_floor(base, coefficient_bp).max(0);
                if !can_kill {
                    amount = amount.min(self.state.units[&actor_id].hp.saturating_sub(1));
                }
                self.apply_raw_damage(actor_id, actor_id, amount, false, 1);
            }
            SkillOperation::ApplyEffect { effect } => {
                let recipient_ids =
                    self.effect_recipients(actor_id, main_target, targets, effect.recipient);
                for target in recipient_ids {
                    self.apply_effect(actor_id, target, effect.clone());
                }
            }
            SkillOperation::RemoveEffects { polarity, count } => {
                for target in targets.iter().copied() {
                    self.remove_effects(target, polarity, count);
                }
            }
            SkillOperation::RemoveEffectsByTag { tag } => {
                for target in targets.iter().copied() {
                    self.remove_effects_by_tag(target, &tag);
                }
            }
            SkillOperation::AbsorbEffectsAndApplyStacks {
                polarity,
                recipient,
                effect,
                max_stacks,
            } => {
                let recipient_ids =
                    self.effect_recipients(actor_id, main_target, targets, recipient);
                let removed = recipient_ids
                    .iter()
                    .map(|target_id| self.remove_effects(*target_id, polarity, u16::MAX))
                    .fold(0_u16, u16::saturating_add)
                    .min(max_stacks);
                for target_id in recipient_ids {
                    for _ in 0..removed {
                        self.apply_effect(actor_id, target_id, effect.clone());
                    }
                }
            }
            SkillOperation::ExtendEffects {
                polarity,
                duration,
                recipient,
            } => {
                let recipient_ids =
                    self.effect_recipients(actor_id, main_target, targets, recipient);
                for target_id in recipient_ids {
                    if let Some(unit) = self.state.units.get_mut(&target_id) {
                        for active in &mut unit.effects {
                            if active.spec.polarity == polarity
                                && active.spec.duration_clock != DurationClock::Permanent
                            {
                                active.remaining = active.remaining.saturating_add(duration);
                            }
                        }
                    }
                }
            }
            SkillOperation::ChangeCooldown { amount, recipient } => {
                let recipient_ids =
                    self.effect_recipients(actor_id, main_target, targets, recipient);
                for target_id in recipient_ids {
                    let keys: Vec<_> = self
                        .state
                        .units
                        .get(&target_id)
                        .map(|unit| unit.cooldowns.keys().cloned().collect())
                        .unwrap_or_default();
                    for key in keys {
                        let before = self.state.units[&target_id].cooldowns[&key];
                        let after = (i32::from(before) + i32::from(amount))
                            .clamp(0, i32::from(u16::MAX))
                            as u16;
                        self.state
                            .units
                            .get_mut(&target_id)
                            .unwrap()
                            .cooldowns
                            .insert(key.clone(), after);
                        self.emit(BattleEventKind::CooldownChanged {
                            unit_id: target_id,
                            costume_id: key,
                            before,
                            after,
                        });
                    }
                }
            }
            SkillOperation::ChangeCostumeCooldown { amount, costume_id } => {
                let before = self.state.units[&actor_id]
                    .cooldowns
                    .get(&costume_id)
                    .copied()
                    .unwrap_or(0);
                let after =
                    (i32::from(before) + i32::from(amount)).clamp(0, i32::from(u16::MAX)) as u16;
                self.state
                    .units
                    .get_mut(&actor_id)
                    .unwrap()
                    .cooldowns
                    .insert(costume_id.clone(), after);
                self.emit(BattleEventKind::CooldownChanged {
                    unit_id: actor_id,
                    costume_id,
                    before,
                    after,
                });
            }
            SkillOperation::ChangeSp { amount, side } => {
                let recipient = match side {
                    EffectRecipient::ActorSide | EffectRecipient::ActorTeam => {
                        self.state.units[&actor_id].side
                    }
                    EffectRecipient::TargetSide => self.state.units[&main_target].side,
                    EffectRecipient::OpponentTeam => self.state.units[&actor_id].side.opponent(),
                };
                self.change_sp(recipient, amount, "SKILL_EFFECT");
            }
            SkillOperation::ChangeSpPerSuccessfulHit { amount, side } => {
                let recipient = match side {
                    EffectRecipient::ActorSide | EffectRecipient::ActorTeam => {
                        self.state.units[&actor_id].side
                    }
                    EffectRecipient::TargetSide => self.state.units[&main_target].side,
                    EffectRecipient::OpponentTeam => self.state.units[&actor_id].side.opponent(),
                };
                let total = amount.saturating_mul(
                    i32::try_from(self.current_skill_successful_hits).unwrap_or(i32::MAX),
                );
                self.change_sp(recipient, total, "SKILL_HIT_EFFECT");
            }
            SkillOperation::Knockback {
                direction,
                distance,
                collision_coefficient_bp,
            } => {
                for target in targets.iter().copied() {
                    self.knockback(target, direction, distance, collision_coefficient_bp)?;
                }
            }
            SkillOperation::Conditional {
                condition,
                operations,
            } => {
                for target in targets.iter().copied() {
                    if self.condition_matches(actor_id, target, main_target, &condition) {
                        for nested in operations.clone() {
                            self.execute_operation(actor_id, main_target, &[target], nested)?;
                        }
                    }
                }
            }
            SkillOperation::InstantDeath {
                remove_beneficial_effects,
            } => {
                for target in targets.iter().copied() {
                    if remove_beneficial_effects {
                        self.remove_effects(target, EffectPolarity::Beneficial, u16::MAX);
                    }
                    let hp = self
                        .state
                        .units
                        .get(&target)
                        .map(|unit| unit.hp)
                        .unwrap_or(0);
                    self.apply_raw_damage(actor_id, target, hp, false, 1);
                }
            }
            SkillOperation::Summon {
                character_id,
                costume_id,
                count,
                enhancement,
                inherit_summoner_stats,
            } => {
                for _ in 0..count {
                    self.summon_unit(
                        actor_id,
                        &character_id,
                        &costume_id,
                        enhancement,
                        inherit_summoner_stats,
                    )?;
                }
            }
            SkillOperation::SelfDestruct => {
                let hp = self
                    .state
                    .units
                    .get(&actor_id)
                    .map(|unit| unit.hp)
                    .unwrap_or(0);
                self.apply_raw_damage(actor_id, actor_id, hp, false, 1);
            }
            SkillOperation::ApplyEffectPerMatchingEnemy {
                effect,
                tag,
                stacks_per_unit,
                max_stacks,
            } => {
                let side = self.state.units[&actor_id].side.opponent();
                let matching = self
                    .state
                    .units
                    .values()
                    .filter(|unit| unit.alive && unit.side == side && has_tag(unit, &tag))
                    .count() as u16;
                let count = matching.saturating_mul(stacks_per_unit).min(max_stacks);
                for _ in 0..count {
                    self.apply_effect(actor_id, actor_id, effect.clone());
                }
            }
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn deal_damage(
        &mut self,
        actor_id: UnitId,
        target_id: UnitId,
        kind: DamageKind,
        coefficient_bp: i32,
        reference: Option<StatReference>,
        can_crit: bool,
        can_evade: bool,
        hits: u16,
        chain_per_hit: u16,
        main_target_bonus_bp: i32,
    ) -> Result<()> {
        for hit in 1..=hits {
            if !self
                .state
                .units
                .get(&target_id)
                .is_some_and(|unit| unit.alive)
            {
                break;
            }
            let actor = self.state.units[&actor_id].clone();
            let target = self.state.units[&target_id].clone();
            let actor_stats = effective_stats(&actor);
            let target_stats = effective_stats(&target);
            let base = reference
                .map(|reference| self.reference_value(actor_id, target_id, reference))
                .unwrap_or_else(|| match kind {
                    DamageKind::Physical | DamageKind::Collision => actor_stats.attack,
                    DamageKind::Magical => actor_stats.magic,
                    DamageKind::Fixed => {
                        match self.catalog.characters[&actor.character_id].attack_type {
                            AttackType::Physical => actor_stats.attack,
                            AttackType::Magical => actor_stats.magic,
                        }
                    }
                    DamageKind::HpConsumption | DamageKind::Dot => actor_stats.attack,
                });
            let mut amount = mul_floor(base, coefficient_bp);
            if matches!(
                kind,
                DamageKind::Physical | DamageKind::Magical | DamageKind::Collision
            ) {
                let resistance = match kind {
                    DamageKind::Physical | DamageKind::Collision => target_stats.defense_bp,
                    DamageKind::Magical => target_stats.magic_resist_bp,
                    _ => 0,
                }
                .clamp(-100_000, 9_000);
                amount = mul_floor(amount, 10_000 - resistance);
            }

            let actor_element = self.catalog.characters[&actor.character_id].element;
            let target_element = self.catalog.characters[&target.character_id].element;
            let elemental = if actor_element.is_advantageous_against(target_element) {
                10_000 + actor_stats.property_damage_bp
            } else {
                actor_element.factor_bp(target_element)
            };
            if !matches!(
                kind,
                DamageKind::Fixed | DamageKind::HpConsumption | DamageKind::Collision
            ) {
                amount = mul_floor(amount, elemental);
            }
            amount = mul_floor(
                amount,
                10_000 + target.weak_point_bonus_bp + main_target_bonus_bp,
            );

            let excess_crit = (actor_stats.crit_rate_bp - 10_000).max(0);
            let crit_chance = actor_stats.crit_rate_bp.clamp(0, 10_000);
            let (draw_id, critical) =
                if can_crit && !matches!(kind, DamageKind::Fixed | DamageKind::HpConsumption) {
                    self.state.rng.roll_basis_points(crit_chance)
                } else {
                    (self.state.rng.draws(), false)
                };
            if can_crit {
                self.emit(BattleEventKind::RngRolled {
                    draw_id,
                    purpose: format!("CRITICAL:{actor_id}:{target_id}:{hit}"),
                    threshold_bp: crit_chance,
                    success: critical,
                });
            }
            if critical {
                amount = mul_floor(
                    amount,
                    10_000 + actor_stats.crit_damage_bp + excess_crit.saturating_mul(6),
                );
            }
            let target_mods = effective_modifiers(&target);
            let typed_incoming = match kind {
                DamageKind::Physical | DamageKind::Collision => {
                    target_mods.physical_incoming_damage_bp
                        - target_mods.physical_damage_reduction_bp
                }
                DamageKind::Magical => {
                    target_mods.magical_incoming_damage_bp - target_mods.magical_damage_reduction_bp
                }
                DamageKind::Dot => target_mods.dot_incoming_damage_bp,
                _ => 0,
            };
            let summon_incoming = if actor.is_summon {
                target_mods.summon_incoming_damage_bp
            } else {
                0
            };
            let elemental_incoming = match actor_element {
                crate::Element::Fire => target_mods.fire_incoming_damage_bp,
                crate::Element::Water => target_mods.water_incoming_damage_bp,
                crate::Element::Wind => target_mods.wind_incoming_damage_bp,
                crate::Element::Light => target_mods.light_incoming_damage_bp,
                crate::Element::Dark => target_mods.dark_incoming_damage_bp,
                crate::Element::None => 0,
            };
            let conditional_outgoing: i32 = actor
                .effects
                .iter()
                .flat_map(|effect| &effect.spec.conditional_outgoing)
                .filter(|modifier| {
                    self.condition_matches(actor_id, target_id, target_id, &modifier.condition)
                })
                .map(|modifier| modifier.amount_bp)
                .sum();
            let amplification = 10_000
                + actor_stats.outgoing_damage_bp
                + actor_stats.amplification_bp
                + target_stats.incoming_damage_bp
                - target_mods.damage_reduction_bp
                + typed_incoming
                + elemental_incoming
                + summon_incoming
                + conditional_outgoing;
            amount = mul_floor(amount, amplification.max(0));
            let chain = self.state.teams[actor.side.index()]
                .chain_by_target
                .get(&target_id)
                .copied()
                .unwrap_or(0);
            amount = mul_floor(
                amount,
                10_000
                    + chain as i32
                        * (1_000
                            + target_mods.chain_damage_incoming_bp
                            + effective_modifiers(&actor).chain_damage_outgoing_bp),
            );
            if can_evade
                && target_mods.evasion_bp > 0
                && !has_tag(&target, "MARK")
                && !matches!(kind, DamageKind::Dot | DamageKind::HpConsumption)
            {
                let (draw_id, evaded) = self
                    .state
                    .rng
                    .roll_basis_points(target_mods.evasion_bp.clamp(0, 10_000));
                self.emit(BattleEventKind::RngRolled {
                    draw_id,
                    purpose: format!("EVASION:{actor_id}:{target_id}:{hit}"),
                    threshold_bp: target_mods.evasion_bp.clamp(0, 10_000),
                    success: evaded,
                });
                if evaded {
                    self.emit(BattleEventKind::DamageEvaded {
                        actor_id,
                        target_id,
                        draw_id,
                    });
                    self.consume_effect_charge(target_id, "EVASION");
                    continue;
                }
            }
            if self.reaction_depth == 0 && self.current_skill_actor == Some(actor_id) {
                self.current_skill_successful_hits =
                    self.current_skill_successful_hits.saturating_add(1);
            }
            self.apply_raw_damage(actor_id, target_id, amount.max(0), critical, hit);
            *self.state.damage_by_source.entry(actor_id).or_default() += amount.max(0);
            self.change_chain(actor_id, target_id, chain_per_hit);
        }
        Ok(())
    }

    fn apply_raw_damage(
        &mut self,
        actor_id: UnitId,
        target_id: UnitId,
        mut amount: i64,
        critical: bool,
        hit: u16,
    ) {
        let hp_owner = self
            .state
            .units
            .get(&target_id)
            .and_then(|unit| unit.hp_owner)
            .unwrap_or(target_id);
        let mut barrier_events = Vec::new();
        if let Some(target) = self.state.units.get_mut(&hp_owner) {
            if target.external_energy_guard > 0 && amount > 0 {
                let absorbed = amount.min(target.external_energy_guard);
                amount -= absorbed;
                target.external_energy_guard -= absorbed;
                barrier_events.push((
                    "external:energy_guard".to_string(),
                    absorbed,
                    target.external_energy_guard,
                ));
            }
            for effect in &mut target.effects {
                if amount == 0 {
                    break;
                }
                if effect.barrier_remaining > 0 {
                    let absorbed = amount.min(effect.barrier_remaining);
                    amount -= absorbed;
                    effect.barrier_remaining -= absorbed;
                    barrier_events.push((
                        effect.spec.effect_id.clone(),
                        absorbed,
                        effect.barrier_remaining,
                    ));
                }
            }
        }
        for (effect_id, absorbed, remaining) in barrier_events {
            self.emit(BattleEventKind::BarrierAbsorbed {
                target_id,
                effect_id,
                amount: absorbed,
                remaining,
            });
        }
        if self.state.rules.mode == BattleMode::MonsterChaser
            && self
                .state
                .units
                .get(&target_id)
                .is_some_and(|unit| unit.side == Side::Enemy)
        {
            let before = self
                .state
                .monster_chaser
                .as_ref()
                .map(|progress| progress.battle_hp_remaining)
                .unwrap_or(0);
            let (advances, exhausted) = self.apply_monster_segment_damage(amount);
            let after = self
                .state
                .monster_chaser
                .as_ref()
                .map(|progress| progress.battle_hp_remaining)
                .unwrap_or(0);
            self.emit(BattleEventKind::DamageApplied {
                actor_id,
                target_id,
                amount,
                hp_before: before,
                hp_after: after,
                critical,
                hit,
            });
            self.consume_effect_charge(target_id, "RECEIVED_HIT_CHARGE");
            for (from, carry_damage) in advances {
                self.emit(BattleEventKind::MonsterLevelAdvanced {
                    from_level: from,
                    to_level: from + 1,
                    carry_damage,
                });
            }
            self.sync_monster_part_hp();
            if exhausted {
                let linked: Vec<_> = self
                    .state
                    .units
                    .values()
                    .filter(|unit| unit.id == hp_owner || unit.hp_owner == Some(hp_owner))
                    .map(|unit| unit.id)
                    .collect();
                for id in linked {
                    if let Some(unit) = self.state.units.get_mut(&id)
                        && unit.alive
                    {
                        unit.alive = false;
                        unit.hp = 0;
                        self.emit(BattleEventKind::UnitDied { unit_id: id });
                    }
                }
            } else if actor_id != target_id
                && self
                    .state
                    .units
                    .get(&target_id)
                    .is_some_and(|unit| unit.alive)
            {
                self.trigger_on_hit_received(target_id, actor_id);
                if self.reaction_depth == 0 {
                    self.trigger_counter(target_id, actor_id, amount);
                }
            }
            return;
        }
        let Some(owner) = self.state.units.get_mut(&hp_owner) else {
            return;
        };
        let before = owner.hp;
        owner.hp = owner.hp.saturating_sub(amount).max(0);
        let after = owner.hp;
        self.emit(BattleEventKind::DamageApplied {
            actor_id,
            target_id,
            amount,
            hp_before: before,
            hp_after: after,
            critical,
            hit,
        });
        self.consume_effect_charge(target_id, "RECEIVED_HIT_CHARGE");
        if after == 0 {
            let revive = self.state.units.get(&hp_owner).and_then(|unit| {
                unit.effects
                    .iter()
                    .find(|effect| effect.spec.revive_hp_bp.is_some())
                    .map(|effect| (effect.instance_id, effect.spec.revive_hp_bp.unwrap()))
            });
            if let Some((instance_id, revive_bp)) = revive {
                let revived_hp =
                    mul_floor(self.state.units[&hp_owner].base_stats.max_hp, revive_bp).max(1);
                if let Some(owner) = self.state.units.get_mut(&hp_owner) {
                    owner.hp = revived_hp;
                    owner.alive = true;
                    owner
                        .effects
                        .retain(|effect| effect.instance_id != instance_id);
                }
                self.emit(BattleEventKind::UnitRevived {
                    unit_id: hp_owner,
                    hp: revived_hp,
                });
                return;
            }
            let linked: Vec<_> = self
                .state
                .units
                .values()
                .filter(|unit| unit.id == hp_owner || unit.hp_owner == Some(hp_owner))
                .map(|unit| unit.id)
                .collect();
            for id in linked {
                if let Some(unit) = self.state.units.get_mut(&id)
                    && unit.alive
                {
                    unit.alive = false;
                    unit.hp = 0;
                    self.emit(BattleEventKind::UnitDied { unit_id: id });
                }
            }
        }
        if actor_id != target_id
            && self
                .state
                .units
                .get(&target_id)
                .is_some_and(|unit| unit.alive)
        {
            self.trigger_on_hit_received(target_id, actor_id);
        }
        if self.reaction_depth == 0
            && actor_id != target_id
            && self
                .state
                .units
                .get(&target_id)
                .is_some_and(|unit| unit.alive)
        {
            self.trigger_counter(target_id, actor_id, amount);
        }
    }

    fn trigger_on_hit_received(&mut self, defender_id: UnitId, attacker_id: UnitId) {
        let triggers: Vec<_> = self
            .state
            .units
            .get(&defender_id)
            .into_iter()
            .flat_map(|unit| unit.effects.iter())
            .filter(|effect| {
                effect.spec.on_hit_received_allies.is_some()
                    || !effect.spec.on_hit_received_operations.is_empty()
            })
            .map(|effect| {
                (
                    effect.instance_id,
                    effect.source_unit_id,
                    effect.spec.on_hit_received_allies.as_deref().cloned(),
                    effect.spec.on_hit_received_operations.clone(),
                    effect.charges_remaining.is_some(),
                )
            })
            .collect();
        let side = self.state.units.get(&defender_id).map(|unit| unit.side);
        let Some(side) = side else { return };
        let allies: Vec<_> = self
            .state
            .units
            .values()
            .filter(|unit| unit.alive && unit.side == side)
            .map(|unit| unit.id)
            .collect();
        for (instance_id, source_id, ally_effect, operations, consumes_charge) in triggers {
            if let Some(spec) = ally_effect {
                for ally in &allies {
                    self.apply_effect(source_id, *ally, spec.clone());
                }
            }
            for operation in operations {
                let _ = self.execute_operation(defender_id, attacker_id, &[attacker_id], operation);
            }
            if consumes_charge {
                self.consume_effect_instance_charge(defender_id, instance_id);
            }
        }
    }

    fn consume_effect_instance_charge(&mut self, target_id: UnitId, instance_id: u64) {
        let mut expired = None;
        if let Some(unit) = self.state.units.get_mut(&target_id)
            && let Some(effect) = unit
                .effects
                .iter_mut()
                .find(|effect| effect.instance_id == instance_id)
            && let Some(charges) = effect.charges_remaining
        {
            let next = charges.saturating_sub(1);
            effect.charges_remaining = Some(next);
            if next == 0 {
                expired = Some(effect.spec.effect_id.clone());
            }
        }
        if let Some(effect_id) = expired {
            if let Some(unit) = self.state.units.get_mut(&target_id) {
                unit.effects
                    .retain(|effect| effect.instance_id != instance_id);
            }
            self.emit(BattleEventKind::EffectExpired {
                target_id,
                effect_id,
                instance_id,
            });
        }
    }

    fn trigger_counter(&mut self, defender_id: UnitId, attacker_id: UnitId, received_damage: i64) {
        let counter = self.state.units.get(&defender_id).and_then(|unit| {
            unit.effects.iter().find_map(|effect| {
                effect
                    .spec
                    .counter
                    .clone()
                    .map(|counter| (effect.instance_id, counter))
            })
        });
        let Some((instance_id, counter)) = counter else {
            return;
        };
        let targets = if counter.target_all {
            let side = self.state.units[&defender_id].side.opponent();
            self.state
                .units
                .values()
                .filter(|unit| unit.alive && unit.side == side)
                .map(|unit| unit.id)
                .collect::<Vec<_>>()
        } else {
            vec![attacker_id]
        };
        self.current_received_damage = received_damage;
        self.reaction_depth = self.reaction_depth.saturating_add(1);
        for target in targets {
            let _ = self.deal_damage(
                defender_id,
                target,
                counter.kind,
                counter.coefficient_bp,
                Some(counter.reference),
                false,
                true,
                1,
                0,
                0,
            );
        }
        self.reaction_depth = self.reaction_depth.saturating_sub(1);
        self.current_received_damage = 0;
        if self
            .state
            .units
            .get(&defender_id)
            .and_then(|unit| {
                unit.effects
                    .iter()
                    .find(|effect| effect.instance_id == instance_id)
            })
            .and_then(|effect| effect.charges_remaining)
            .is_some()
        {
            self.consume_effect_charge(defender_id, "COUNTER");
        }
    }

    fn heal(
        &mut self,
        actor_id: UnitId,
        target_id: UnitId,
        coefficient_bp: i32,
        reference: StatReference,
        can_crit: bool,
    ) {
        let actor = self.state.units[&actor_id].clone();
        let stats = effective_stats(&actor);
        let base = self.reference_value(actor_id, target_id, reference);
        let mut amount = mul_floor(base, coefficient_bp);
        if can_crit {
            let (_, critical) = self
                .state
                .rng
                .roll_basis_points(stats.crit_rate_bp.clamp(0, 10_000));
            if critical {
                amount = mul_floor(amount, 10_000 + stats.crit_damage_bp);
            }
        }
        let Some(target) = self.state.units.get_mut(&target_id) else {
            return;
        };
        if !target.alive {
            return;
        }
        let before = target.hp;
        target.hp = (target.hp + amount).min(target.base_stats.max_hp);
        let applied = target.hp - before;
        let after = target.hp;
        self.emit(BattleEventKind::HealApplied {
            actor_id,
            target_id,
            amount: applied,
            hp_before: before,
            hp_after: after,
        });
    }

    fn reference_value(
        &self,
        actor_id: UnitId,
        target_id: UnitId,
        reference: StatReference,
    ) -> i64 {
        let actor = &self.state.units[&actor_id];
        let target = &self.state.units[&target_id];
        let actor_stats = effective_stats(actor);
        let target_stats = effective_stats(target);
        match reference {
            StatReference::Attack => actor_stats.attack,
            StatReference::Magic => actor_stats.magic,
            StatReference::MaxHp => actor_stats.max_hp,
            StatReference::CurrentHp => actor.hp,
            StatReference::Fixed => 10_000,
            StatReference::TargetMaxHp => target_stats.max_hp,
            StatReference::TargetCurrentHp => target.hp,
            StatReference::TargetAttack => target_stats.attack,
            StatReference::TargetMagic => target_stats.magic,
            StatReference::EnergyGuard => actor.external_energy_guard.saturating_add(
                actor
                    .effects
                    .iter()
                    .map(|effect| effect.barrier_remaining)
                    .sum(),
            ),
            StatReference::ReceivedDamage => self.current_received_damage,
        }
    }

    fn summon_unit(
        &mut self,
        source_id: UnitId,
        character_id: &str,
        costume_id: &str,
        enhancement: u8,
        inherit_summoner_stats: bool,
    ) -> Result<()> {
        let source = self
            .state
            .units
            .get(&source_id)
            .cloned()
            .ok_or_else(|| BattleError::IllegalAction("summoner missing".into()))?;
        let character = self.catalog.characters.get(character_id).ok_or_else(|| {
            BattleError::MissingCatalogEntry {
                kind: "summon character",
                id: character_id.into(),
            }
        })?;
        let costume = self.catalog.costumes.get(costume_id).ok_or_else(|| {
            BattleError::MissingCatalogEntry {
                kind: "summon costume",
                id: costume_id.into(),
            }
        })?;
        if costume.character_id != character.id {
            return Err(BattleError::InvalidScenario(
                "summon costume owner mismatch".into(),
            ));
        }
        let position = (0..self.state.rules.grid.depths)
            .flat_map(|depth| (0..self.state.rules.grid.rows).map(move |row| Cell { row, depth }))
            .find(|cell| {
                self.state.rules.grid.contains(*cell)
                    && !self.state.units.values().any(|unit| {
                        unit.alive && unit.side == source.side && unit.position == *cell
                    })
            })
            .ok_or_else(|| BattleError::IllegalAction("no free cell for summon".into()))?;
        let unit_id = self
            .state
            .units
            .keys()
            .next_back()
            .copied()
            .unwrap_or(0)
            .saturating_add(1);
        let loadout = crate::CostumeLoadout {
            costume_id: costume_id.into(),
            enhancement,
            burst_level: 0,
            potential_mask: 0,
            permanent_potential_enabled: false,
            costume_link_target: None,
        };
        let stats = if inherit_summoner_stats {
            source.base_stats.clone()
        } else {
            character.level_100.clone()
        };
        self.state.units.insert(
            unit_id,
            UnitState {
                id: unit_id,
                character_id: character_id.into(),
                side: source.side,
                position,
                alive: true,
                hp: stats.max_hp,
                base_stats: stats,
                passive_modifiers: StatModifiers::default(),
                costume_loadout: vec![loadout],
                cooldowns: BTreeMap::from([(costume_id.into(), 0)]),
                effects: Vec::new(),
                external_energy_guard: 0,
                ai_priority: vec![costume_id.into()],
                party_no: source.party_no,
                hp_owner: None,
                weak_point_bonus_bp: 0,
                is_summon: true,
                summoned_by: Some(source_id),
                triggered_skill_uses: BTreeMap::new(),
                can_act: true,
            },
        );
        self.state.teams[source.side.index()]
            .action_order
            .push(unit_id);
        self.emit(BattleEventKind::UnitSummoned {
            source_id,
            unit_id,
            character_id: character_id.into(),
            position,
        });
        Ok(())
    }

    fn apply_effect(&mut self, source_id: UnitId, target_id: UnitId, spec: crate::EffectSpec) {
        let instance_id = self.state.next_effect_instance_id;
        self.state.next_effect_instance_id += 1;
        let target = &mut self.state.units.get_mut(&target_id).unwrap().effects;
        if let Some(max_stacks) = spec.max_stacks
            && target
                .iter()
                .filter(|active| active.spec.effect_id == spec.effect_id)
                .count()
                >= usize::from(max_stacks)
        {
            return;
        }
        match spec.stack_rule {
            crate::StackRule::ReplaceSameSource => target.retain(|active| {
                active.spec.effect_id != spec.effect_id || active.source_unit_id != source_id
            }),
            crate::StackRule::KeepStrongest => {
                let strength = modifier_strength(&spec.modifiers);
                if target.iter().any(|active| {
                    active.spec.effect_id == spec.effect_id
                        && modifier_strength(&active.spec.modifiers) >= strength
                }) {
                    return;
                }
                target.retain(|active| active.spec.effect_id != spec.effect_id);
            }
            crate::StackRule::Extend => {
                if let Some(active) = target
                    .iter_mut()
                    .find(|active| active.spec.effect_id == spec.effect_id)
                {
                    active.remaining = active.remaining.saturating_add(spec.duration);
                    return;
                }
            }
            crate::StackRule::Accumulate => {
                if let Some(active) = target
                    .iter_mut()
                    .find(|active| active.spec.effect_id == spec.effect_id)
                {
                    if let (Some(current), Some(added)) =
                        (active.spec.periodic.as_mut(), spec.periodic.as_ref())
                    {
                        current.stacks = current
                            .stacks
                            .saturating_add(added.stacks)
                            .min(spec.max_stacks.unwrap_or(u16::MAX));
                    }
                    active.remaining = spec.duration;
                    return;
                }
            }
            crate::StackRule::Independent => {}
        }
        let barrier_remaining = spec
            .barrier
            .as_ref()
            .map(|barrier| {
                mul_floor(
                    self.reference_value(source_id, target_id, barrier.reference),
                    barrier.coefficient_bp,
                )
                .max(0)
            })
            .unwrap_or(0);
        let target = &mut self.state.units.get_mut(&target_id).unwrap().effects;
        let charges_remaining = spec.charges;
        target.push(ActiveEffect {
            instance_id,
            source_unit_id: source_id,
            remaining: spec.duration,
            barrier_remaining,
            charges_remaining,
            spec: spec.clone(),
        });
        self.emit(BattleEventKind::EffectApplied {
            source_id,
            target_id,
            effect_id: spec.effect_id,
            instance_id,
        });
        if let Some(aura) = spec.aura_allies.as_deref().cloned() {
            let side = self.state.units[&target_id].side;
            let allies: Vec<_> = self
                .state
                .units
                .values()
                .filter(|unit| unit.alive && unit.side == side)
                .map(|unit| unit.id)
                .collect();
            for ally in allies {
                self.apply_effect(source_id, ally, aura.clone());
            }
        }
        if let Some(aura) = spec.aura_opponents.as_deref().cloned() {
            let side = self.state.units[&target_id].side.opponent();
            let opponents: Vec<_> = self
                .state
                .units
                .values()
                .filter(|unit| unit.alive && unit.side == side)
                .map(|unit| unit.id)
                .collect();
            for opponent in opponents {
                self.apply_effect(source_id, opponent, aura.clone());
            }
        }
    }

    fn remove_effects(&mut self, target_id: UnitId, polarity: EffectPolarity, count: u16) -> u16 {
        let Some(unit) = self.state.units.get_mut(&target_id) else {
            return 0;
        };
        let mut removed = Vec::new();
        let mut remaining = count;
        unit.effects.retain(|active| {
            if remaining > 0 && active.spec.polarity == polarity {
                remaining -= 1;
                removed.push((active.spec.effect_id.clone(), active.instance_id));
                false
            } else {
                true
            }
        });
        for (effect_id, instance_id) in removed {
            self.emit(BattleEventKind::EffectExpired {
                target_id,
                effect_id,
                instance_id,
            });
        }
        count.saturating_sub(remaining)
    }

    fn remove_effects_by_tag(&mut self, target_id: UnitId, tag: &str) {
        let Some(unit) = self.state.units.get_mut(&target_id) else {
            return;
        };
        let mut removed = Vec::new();
        unit.effects.retain(|active| {
            if active.spec.tags.contains(tag) {
                removed.push((active.spec.effect_id.clone(), active.instance_id));
                false
            } else {
                true
            }
        });
        for (effect_id, instance_id) in removed {
            self.emit(BattleEventKind::EffectExpired {
                target_id,
                effect_id,
                instance_id,
            });
        }
    }

    fn consume_effect_charge(&mut self, target_id: UnitId, tag: &str) {
        let mut expired = None;
        if let Some(unit) = self.state.units.get_mut(&target_id)
            && let Some(effect) = unit.effects.iter_mut().find(|effect| {
                effect.spec.tags.contains(tag)
                    && effect.charges_remaining.is_some_and(|charges| charges > 0)
            })
        {
            let next = effect.charges_remaining.unwrap().saturating_sub(1);
            effect.charges_remaining = Some(next);
            if next == 0 {
                expired = Some((effect.spec.effect_id.clone(), effect.instance_id));
            }
        }
        if let Some((effect_id, instance_id)) = expired {
            if let Some(unit) = self.state.units.get_mut(&target_id) {
                unit.effects
                    .retain(|effect| effect.instance_id != instance_id);
            }
            self.emit(BattleEventKind::EffectExpired {
                target_id,
                effect_id,
                instance_id,
            });
        }
    }

    fn condition_matches(
        &self,
        actor_id: UnitId,
        target_id: UnitId,
        main_target_id: UnitId,
        condition: &crate::SkillCondition,
    ) -> bool {
        match condition {
            crate::SkillCondition::Any { conditions } => conditions.iter().any(|condition| {
                self.condition_matches(actor_id, target_id, main_target_id, condition)
            }),
            crate::SkillCondition::All { conditions } => conditions.iter().all(|condition| {
                self.condition_matches(actor_id, target_id, main_target_id, condition)
            }),
            crate::SkillCondition::TargetChainAtLeast { value } => {
                let side = self.state.units[&actor_id].side;
                self.state.teams[side.index()]
                    .chain_by_target
                    .get(&target_id)
                    .copied()
                    .unwrap_or(0)
                    >= *value
            }
            crate::SkillCondition::TargetHpAtMost { percent_bp } => {
                let target = &self.state.units[&target_id];
                target.hp.saturating_mul(10_000)
                    <= target
                        .base_stats
                        .max_hp
                        .saturating_mul(i64::from(*percent_bp))
            }
            crate::SkillCondition::ActorHpAtMost { percent_bp } => {
                let actor = &self.state.units[&actor_id];
                actor.hp.saturating_mul(10_000)
                    <= actor
                        .base_stats
                        .max_hp
                        .saturating_mul(i64::from(*percent_bp))
            }
            crate::SkillCondition::TargetHasTag { tag } => {
                has_tag(&self.state.units[&target_id], tag)
            }
            crate::SkillCondition::TargetLacksTag { tag } => {
                !has_tag(&self.state.units[&target_id], tag)
            }
            crate::SkillCondition::ActorHasTag { tag } => {
                has_tag(&self.state.units[&actor_id], tag)
            }
            crate::SkillCondition::ActorLacksTag { tag } => {
                !has_tag(&self.state.units[&actor_id], tag)
            }
            crate::SkillCondition::IsMainTarget => target_id == main_target_id,
            crate::SkillCondition::IsNotMainTarget => target_id != main_target_id,
            crate::SkillCondition::TargetChainAtMost { value } => {
                let side = self.state.units[&actor_id].side;
                self.state.teams[side.index()]
                    .chain_by_target
                    .get(&target_id)
                    .copied()
                    .unwrap_or(0)
                    <= *value
            }
            crate::SkillCondition::TargetChainMultipleOf { value } => {
                let side = self.state.units[&actor_id].side;
                *value != 0
                    && self.state.teams[side.index()]
                        .chain_by_target
                        .get(&target_id)
                        .copied()
                        .unwrap_or(0)
                        .is_multiple_of(*value)
            }
            crate::SkillCondition::TargetChainNotMultipleOf { value } => {
                let side = self.state.units[&actor_id].side;
                *value == 0
                    || !self.state.teams[side.index()]
                        .chain_by_target
                        .get(&target_id)
                        .copied()
                        .unwrap_or(0)
                        .is_multiple_of(*value)
            }
            crate::SkillCondition::TargetEffectCountAtLeast { polarity, value } => {
                self.state.units[&target_id]
                    .effects
                    .iter()
                    .filter(|effect| effect.spec.polarity == *polarity)
                    .count()
                    >= usize::from(*value)
            }
            crate::SkillCondition::TargetEffectCountAtMost { polarity, value } => {
                self.state.units[&target_id]
                    .effects
                    .iter()
                    .filter(|effect| effect.spec.polarity == *polarity)
                    .count()
                    <= usize::from(*value)
            }
            crate::SkillCondition::ActorEffectCountAtLeast { polarity, value } => {
                self.state.units[&actor_id]
                    .effects
                    .iter()
                    .filter(|effect| effect.spec.polarity == *polarity)
                    .count()
                    >= usize::from(*value)
            }
            crate::SkillCondition::AnyOpponentChainAtLeast { value } => self.state.teams
                [self.state.units[&actor_id].side.opponent().index()]
            .chain_by_target
            .values()
            .any(|chain| chain >= value),
            crate::SkillCondition::TargetAttackType { attack_type } => {
                self.catalog.characters[&self.state.units[&target_id].character_id].attack_type
                    == *attack_type
            }
            crate::SkillCondition::TargetNotAttackType { attack_type } => {
                self.catalog.characters[&self.state.units[&target_id].character_id].attack_type
                    != *attack_type
            }
            crate::SkillCondition::TargetElement { element } => {
                self.catalog.characters[&self.state.units[&target_id].character_id].element
                    == *element
            }
            crate::SkillCondition::TargetNotElement { element } => {
                self.catalog.characters[&self.state.units[&target_id].character_id].element
                    != *element
            }
        }
    }

    fn knockback(
        &mut self,
        target_id: UnitId,
        direction: crate::KnockbackDirection,
        distance: u8,
        collision_coefficient_bp: i32,
    ) -> Result<()> {
        let Some(target) = self.state.units.get(&target_id).cloned() else {
            return Ok(());
        };
        if has_tag(&target, "KNOCKBACK_IMMUNE") {
            return Ok(());
        }
        let (dr, dd) = knockback_delta(direction);
        let mut destination = target.position;
        let mut occupant = None;
        for step in 1..=distance {
            let candidate = Cell {
                row: target.position.row + dr * step as i8,
                depth: target.position.depth + dd * step as i8,
            };
            if !self.state.rules.grid.contains(candidate) {
                break;
            }
            occupant = self
                .state
                .units
                .values()
                .find(|unit| {
                    unit.alive
                        && unit.side == target.side
                        && unit.id != target_id
                        && unit.position == candidate
                })
                .map(|unit| unit.id);
            if occupant.is_some() {
                break;
            }
            destination = candidate;
        }
        if destination != target.position {
            self.state.units.get_mut(&target_id).unwrap().position = destination;
            self.emit(BattleEventKind::UnitMoved {
                unit_id: target_id,
                from: target.position,
                to: destination,
            });
        }
        if let Some(occupant_id) = occupant {
            let before = self.state.units[&occupant_id].hp;
            self.deal_damage(
                target_id,
                occupant_id,
                DamageKind::Collision,
                collision_coefficient_bp,
                Some(StatReference::MaxHp),
                false,
                false,
                1,
                0,
                0,
            )?;
            let damage = before.saturating_sub(self.state.units[&occupant_id].hp);
            self.emit(BattleEventKind::CollisionDamage {
                moving_id: target_id,
                occupant_id,
                amount: damage,
            });
        }
        Ok(())
    }

    fn select_main_target(
        &self,
        actor_id: UnitId,
        selector: TargetSelector,
        explicit: Option<UnitId>,
    ) -> Result<UnitId> {
        let actor = self
            .state
            .units
            .get(&actor_id)
            .ok_or_else(|| BattleError::IllegalAction("actor missing".into()))?;
        if selector == TargetSelector::SelfUnit {
            return Ok(actor_id);
        }
        if selector == TargetSelector::NextAllyInOrder {
            let order = &self.state.teams[actor.side.index()].action_order;
            let actor_index = order.iter().position(|id| *id == actor_id).ok_or_else(|| {
                BattleError::IllegalAction("actor is missing from its action order".into())
            })?;
            return order
                .iter()
                .cycle()
                .skip(actor_index + 1)
                .take(order.len().saturating_sub(1))
                .find(|id| {
                    self.state
                        .units
                        .get(id)
                        .is_some_and(|unit| unit.alive && unit.can_act)
                })
                .copied()
                .ok_or_else(|| BattleError::IllegalAction("no next ally in action order".into()));
        }
        if selector == TargetSelector::Explicit
            && let Some(id) = explicit
            && self.state.units.get(&id).is_some_and(|unit| unit.alive)
        {
            return Ok(id);
        }
        let target_side = if selector == TargetSelector::AllyFront {
            actor.side
        } else {
            actor.side.opponent()
        };
        if target_side != actor.side {
            if let Some(focused) = self
                .state
                .units
                .values()
                .filter(|unit| {
                    unit.alive
                        && unit.side == target_side
                        && has_tag(unit, "FOCUS")
                        && !has_tag(unit, "EVADE_TARGET")
                })
                .min_by_key(|unit| unit.id)
            {
                return Ok(focused.id);
            }
            if let Some(taunting) = self
                .state
                .units
                .values()
                .filter(|unit| {
                    unit.alive
                        && unit.side == target_side
                        && has_tag(unit, "TAUNT")
                        && !has_tag(unit, "EVADE_TARGET")
                })
                .min_by_key(|unit| (unit.position.depth, unit.id))
            {
                return Ok(taunting.id);
            }
        }
        let rows = self.state.rules.grid.rows;
        for row_offset in 0..rows {
            let row = (actor.position.row + row_offset).rem_euclid(rows);
            let mut candidates: Vec<_> = self
                .state
                .units
                .values()
                .filter(|unit| {
                    unit.alive
                        && unit.side == target_side
                        && unit.position.row == row
                        && (target_side == actor.side || !has_tag(unit, "EVADE_TARGET"))
                })
                .collect();
            candidates.sort_by_key(|unit| (unit.position.depth, unit.id));
            if !candidates.is_empty() {
                let index = if selector == TargetSelector::Skip && candidates.len() > 1 {
                    1
                } else {
                    0
                };
                return Ok(candidates[index].id);
            }
        }
        Err(BattleError::IllegalAction("no valid target".into()))
    }

    fn targets_in_range(
        &self,
        anchor_id: UnitId,
        side: Side,
        range: &[crate::Offset],
    ) -> Vec<UnitId> {
        let anchor = self.state.units[&anchor_id].position;
        self.targets_in_range_cell(anchor, side, range)
    }

    fn targets_in_range_cell(
        &self,
        anchor: Cell,
        side: Side,
        range: &[crate::Offset],
    ) -> Vec<UnitId> {
        let cells: BTreeSet<_> = if range.is_empty() {
            BTreeSet::from([(anchor.row, anchor.depth)])
        } else {
            range
                .iter()
                .map(|offset| (anchor.row + offset.row, anchor.depth + offset.depth))
                .collect()
        };
        self.state
            .units
            .values()
            .filter(|unit| {
                unit.alive
                    && unit.side == side
                    && cells.contains(&(unit.position.row, unit.position.depth))
            })
            .map(|unit| unit.id)
            .collect()
    }

    fn resolve_variant<'a>(
        &'a self,
        unit: &UnitState,
        costume_id: &str,
        burst_level: u8,
    ) -> Result<&'a SkillVariant> {
        let loadout = unit
            .costume_loadout
            .iter()
            .find(|loadout| loadout.costume_id == costume_id)
            .ok_or_else(|| {
                BattleError::IllegalAction(format!("unit does not own costume '{costume_id}'"))
            })?;
        if burst_level > loadout.burst_level {
            return Err(BattleError::IllegalAction(
                "burst level is not unlocked".into(),
            ));
        }
        let costume = self.catalog.costumes.get(costume_id).ok_or_else(|| {
            BattleError::MissingCatalogEntry {
                kind: "costume",
                id: costume_id.into(),
            }
        })?;
        select_variant(
            costume,
            loadout.enhancement,
            burst_level,
            loadout.potential_mask,
        )
        .ok_or_else(|| BattleError::MissingCatalogEntry {
            kind: "skill variant",
            id: format!(
                "{costume_id}/+{}/b{burst_level}/p{}",
                loadout.enhancement, loadout.potential_mask
            ),
        })
    }

    fn character_selector(&self, unit_id: UnitId) -> Result<TargetSelector> {
        let unit = &self.state.units[&unit_id];
        self.catalog
            .characters
            .get(&unit.character_id)
            .map(|character| character.target_selector)
            .ok_or_else(|| BattleError::MissingCatalogEntry {
                kind: "character",
                id: unit.character_id.clone(),
            })
    }

    fn character_attack_type(&self, unit_id: UnitId) -> Result<AttackType> {
        let unit = &self.state.units[&unit_id];
        self.catalog
            .characters
            .get(&unit.character_id)
            .map(|character| character.attack_type)
            .ok_or_else(|| BattleError::MissingCatalogEntry {
                kind: "character",
                id: unit.character_id.clone(),
            })
    }

    fn apply_formation(&mut self, side: Side, formation: &BTreeMap<UnitId, Cell>) -> Result<()> {
        if formation.is_empty() {
            return Ok(());
        }
        if !self.state.rules.allow_formation_change {
            return Err(BattleError::IllegalAction("formation is locked".into()));
        }
        let mut occupied = BTreeSet::new();
        for unit in self
            .state
            .units
            .values()
            .filter(|unit| unit.alive && unit.side == side)
        {
            let cell = formation.get(&unit.id).copied().unwrap_or(unit.position);
            if !self.state.rules.grid.contains(cell) || !occupied.insert((cell.row, cell.depth)) {
                return Err(BattleError::IllegalAction(
                    "invalid or occupied formation cell".into(),
                ));
            }
        }
        for (unit_id, cell) in formation {
            let unit = self.state.units.get_mut(unit_id).ok_or_else(|| {
                BattleError::IllegalAction("formation contains unknown unit".into())
            })?;
            if unit.side != side {
                return Err(BattleError::IllegalAction(
                    "cannot move opposing unit".into(),
                ));
            }
            if !unit.alive {
                return Err(BattleError::IllegalAction(
                    "cannot move inactive unit".into(),
                ));
            }
            let from = unit.position;
            unit.position = *cell;
            if from != *cell {
                self.emit(BattleEventKind::FormationChanged {
                    unit_id: *unit_id,
                    from,
                    to: *cell,
                });
            }
        }
        Ok(())
    }

    fn validate_order(&self, side: Side, order: &[UnitId]) -> Result<()> {
        let expected: BTreeSet<_> = self.state.teams[side.index()]
            .action_order
            .iter()
            .copied()
            .collect();
        let actual: BTreeSet<_> = order.iter().copied().collect();
        if expected != actual || actual.len() != order.len() {
            return Err(BattleError::IllegalAction(
                "action order must contain every team unit exactly once".into(),
            ));
        }
        Ok(())
    }

    fn finish_turn(&mut self, side: Side) {
        self.tick_turn_effects(side);
        self.tick_cooldowns(side);
        self.emit(BattleEventKind::TurnEnded {
            side,
            turn: self.state.game_turn,
        });
        for target_side in [Side::Player, Side::Enemy] {
            let recovery = self.state.rules.recovery_after_team_turn[target_side.index()];
            if recovery != 0 {
                self.change_sp(target_side, recovery, "TURN_RECOVERY");
            }
        }
        if self.state.rules.mode == BattleMode::MonsterChaser && side == Side::Enemy {
            let recovery = self
                .state
                .monster_chaser
                .as_ref()
                .map(|state| state.turn_sp_recovery)
                .unwrap_or(0);
            if recovery != 0 {
                self.change_sp(Side::Player, recovery, "MONSTER_CHASER_RECOVERY");
            }
        }
        if self.state.rules.chain_reset_on_team_turn {
            let previous = std::mem::take(&mut self.state.teams[side.index()].chain_by_target);
            for (target_id, chain) in previous {
                let retention = self
                    .state
                    .units
                    .get(&target_id)
                    .map(|unit| effective_modifiers(unit).chain_retention)
                    .unwrap_or(0);
                let retained = chain.min(retention);
                if retained > 0 {
                    self.state.teams[side.index()]
                        .chain_by_target
                        .insert(target_id, retained);
                }
            }
        }
        self.state.active_side = side.opponent();
        self.state.game_turn += 1;
        if self.state.active_side == self.state.rules.first_side {
            self.state.round_no += 1;
        }
    }

    fn tick_cooldowns(&mut self, side: Side) {
        let ids: Vec<_> = self
            .state
            .units
            .values()
            .filter(|unit| unit.side == side)
            .map(|unit| unit.id)
            .collect();
        for id in ids {
            let keys: Vec<_> = self.state.units[&id].cooldowns.keys().cloned().collect();
            for key in keys {
                let before = self.state.units[&id].cooldowns[&key];
                if before > 0 {
                    let after = before - 1;
                    self.state
                        .units
                        .get_mut(&id)
                        .unwrap()
                        .cooldowns
                        .insert(key.clone(), after);
                    self.emit(BattleEventKind::CooldownChanged {
                        unit_id: id,
                        costume_id: key,
                        before,
                        after,
                    });
                }
            }
        }
    }

    fn tick_action_effects(&mut self, actor_id: UnitId) {
        self.tick_effects(actor_id, DurationClock::Action);
    }

    fn tick_turn_effects(&mut self, side: Side) {
        let ids: Vec<_> = self
            .state
            .units
            .values()
            .filter(|unit| unit.side == side)
            .map(|unit| unit.id)
            .collect();
        for id in ids {
            self.tick_effects(id, DurationClock::GameTurn);
        }
    }

    fn tick_effects(&mut self, unit_id: UnitId, clock: DurationClock) {
        let mut expired = Vec::new();
        let turn_end_operations: Vec<_> = self
            .state
            .units
            .get(&unit_id)
            .into_iter()
            .flat_map(|unit| unit.effects.iter())
            .filter(|effect| effect.spec.duration_clock == clock && effect.remaining > 0)
            .flat_map(|effect| effect.spec.on_turn_end_operations.clone())
            .collect();
        for operation in turn_end_operations {
            let _ = self.execute_operation(unit_id, unit_id, &[unit_id], operation);
        }
        let periodic: Vec<_> = self
            .state
            .units
            .get(&unit_id)
            .into_iter()
            .flat_map(|unit| unit.effects.iter())
            .filter(|effect| effect.spec.duration_clock == clock && effect.remaining > 0)
            .filter_map(|effect| {
                effect
                    .spec
                    .periodic
                    .clone()
                    .map(|periodic| (effect.source_unit_id, periodic))
            })
            .collect();
        for (source_id, periodic) in periodic {
            if self.state.units.contains_key(&source_id)
                && self
                    .state
                    .units
                    .get(&unit_id)
                    .is_some_and(|unit| unit.alive)
            {
                let coefficient = periodic
                    .coefficient_bp
                    .saturating_mul(i32::from(periodic.stacks));
                let _ = self.deal_damage(
                    source_id,
                    unit_id,
                    periodic.kind,
                    coefficient,
                    Some(periodic.reference),
                    false,
                    false,
                    1,
                    0,
                    0,
                );
            }
        }
        let auras: Vec<_> = self
            .state
            .units
            .get(&unit_id)
            .into_iter()
            .flat_map(|unit| unit.effects.iter())
            .filter(|effect| effect.spec.duration_clock == clock && effect.remaining > 0)
            .filter(|effect| {
                effect.spec.aura_allies.is_some() || effect.spec.aura_opponents.is_some()
            })
            .map(|effect| {
                (
                    effect.source_unit_id,
                    effect.spec.aura_allies.as_deref().cloned(),
                    effect.spec.aura_opponents.as_deref().cloned(),
                )
            })
            .collect();
        if let Some(side) = self.state.units.get(&unit_id).map(|unit| unit.side) {
            let allies: Vec<_> = self
                .state
                .units
                .values()
                .filter(|unit| unit.alive && unit.side == side)
                .map(|unit| unit.id)
                .collect();
            let opponents: Vec<_> = self
                .state
                .units
                .values()
                .filter(|unit| unit.alive && unit.side == side.opponent())
                .map(|unit| unit.id)
                .collect();
            for (source_id, ally_aura, opponent_aura) in auras {
                if let Some(aura) = ally_aura {
                    for ally in &allies {
                        self.apply_effect(source_id, *ally, aura.clone());
                    }
                }
                if let Some(aura) = opponent_aura {
                    for opponent in &opponents {
                        self.apply_effect(source_id, *opponent, aura.clone());
                    }
                }
            }
        }
        if let Some(unit) = self.state.units.get_mut(&unit_id) {
            for effect in &mut unit.effects {
                if effect.spec.duration_clock == clock && effect.remaining > 0 {
                    effect.remaining -= 1;
                    if effect.remaining == 0 {
                        expired.push((effect.spec.effect_id.clone(), effect.instance_id));
                    }
                }
            }
            unit.effects.retain(|effect| {
                effect.remaining > 0 || effect.spec.duration_clock == DurationClock::Permanent
            });
        }
        for (effect_id, instance_id) in expired {
            self.emit(BattleEventKind::EffectExpired {
                target_id: unit_id,
                effect_id,
                instance_id,
            });
        }
    }

    fn change_sp(&mut self, side: Side, delta: i32, reason: &str) {
        let before = self.state.teams[side.index()].sp;
        let mut after = (before + delta).max(0);
        if let Some(cap) = self.state.rules.sp_cap {
            after = after.min(cap);
        }
        self.state.teams[side.index()].sp = after;
        self.emit(BattleEventKind::SpChanged {
            side,
            before,
            after,
            reason: reason.into(),
        });
    }

    fn change_chain(&mut self, actor_id: UnitId, target_id: UnitId, amount: u16) {
        let side = self.state.units[&actor_id].side;
        let before = self.state.teams[side.index()]
            .chain_by_target
            .get(&target_id)
            .copied()
            .unwrap_or(0);
        let received_delta = self
            .state
            .units
            .get(&target_id)
            .map(|unit| effective_modifiers(unit).chain_received_delta)
            .unwrap_or(0);
        let dealt_delta = self
            .state
            .units
            .get(&actor_id)
            .map(|unit| effective_modifiers(unit).chain_dealt_delta)
            .unwrap_or(0);
        let adjusted =
            (i32::from(amount) + i32::from(received_delta) + i32::from(dealt_delta)).max(0) as u16;
        let after = before.saturating_add(adjusted);
        self.state.teams[side.index()]
            .chain_by_target
            .insert(target_id, after);
        self.emit(BattleEventKind::ChainChanged {
            side,
            target_id,
            before,
            after,
        });
        self.trigger_on_chain_dealt(actor_id);
    }

    fn trigger_on_chain_dealt(&mut self, actor_id: UnitId) {
        let triggers: Vec<_> = self
            .state
            .units
            .get(&actor_id)
            .into_iter()
            .flat_map(|unit| unit.effects.iter())
            .filter_map(|effect| {
                effect
                    .spec
                    .on_chain_dealt
                    .as_deref()
                    .cloned()
                    .map(|trigger| (effect.source_unit_id, trigger))
            })
            .collect();
        for (source_id, trigger) in triggers {
            self.apply_effect(source_id, actor_id, (*trigger.stack_effect).clone());
            let stack_count = self.state.units[&actor_id]
                .effects
                .iter()
                .filter(|effect| effect.spec.effect_id == trigger.stack_effect.effect_id)
                .count() as u16;
            if stack_count >= trigger.threshold {
                self.apply_effect(source_id, actor_id, (*trigger.threshold_effect).clone());
            }
        }
    }

    fn apply_monster_segment_damage(&mut self, amount: i64) -> (Vec<(u8, i64)>, bool) {
        let mut advances = Vec::new();
        {
            let Some(progress) = self.state.monster_chaser.as_mut() else {
                return (advances, false);
            };
            progress.cumulative_damage = progress.cumulative_damage.saturating_add(amount);
            progress.battle_hp_remaining =
                progress.battle_hp_remaining.saturating_sub(amount).max(0);
            let mut carry = amount;
            while carry >= progress.segment_hp_remaining && progress.segment_hp_remaining > 0 {
                carry -= progress.segment_hp_remaining;
                let from = progress.current_level;
                let next_index = progress.current_level as usize;
                if next_index >= progress.level_hp_segments.len() {
                    progress.segment_hp_remaining = 0;
                    break;
                }
                progress.current_level += 1;
                progress.segment_hp_remaining = progress.level_hp_segments[next_index];
                advances.push((from, carry));
            }
            progress.segment_hp_remaining =
                progress.segment_hp_remaining.saturating_sub(carry).max(0);
        }
        let exhausted = self
            .state
            .monster_chaser
            .as_ref()
            .is_some_and(|progress| progress.battle_hp_remaining == 0);
        (advances, exhausted)
    }

    fn update_monster_stats(&mut self, level: u8) {
        let Some(monster_id) = self
            .state
            .monster_chaser
            .as_ref()
            .map(|progress| progress.monster_id.clone())
        else {
            return;
        };
        let Some(stats) = self
            .catalog
            .monsters
            .get(&monster_id)
            .and_then(|monster| monster.stats_by_level.get(&level))
            .cloned()
        else {
            return;
        };
        for unit in self
            .state
            .units
            .values_mut()
            .filter(|unit| unit.side == Side::Enemy)
        {
            unit.base_stats = stats.clone();
        }
    }

    fn sync_monster_part_hp(&mut self) {
        let remaining = self
            .state
            .monster_chaser
            .as_ref()
            .map(|progress| progress.battle_hp_remaining)
            .unwrap_or(0);
        for unit in self
            .state
            .units
            .values_mut()
            .filter(|unit| unit.side == Side::Enemy)
        {
            unit.hp = remaining;
        }
    }

    fn evaluate_terminal(&mut self) {
        if self.state.terminal.is_some() {
            return;
        }
        let mut player_alive = self
            .state
            .units
            .values()
            .any(|unit| unit.side == Side::Player && unit.alive);
        if !player_alive && self.state.rules.mode == BattleMode::MonsterChaser {
            player_alive = self.activate_next_monster_party();
        }
        let enemy_alive = self
            .state
            .units
            .values()
            .any(|unit| unit.side == Side::Enemy && unit.alive);
        let turn_limit = self.state.game_turn > self.state.rules.max_game_turns;
        let (outcome, reason) = match (player_alive, enemy_alive, turn_limit) {
            (false, false, _) => (Some(Outcome::Draw), "SIMULTANEOUS_ELIMINATION"),
            (false, true, _) => (Some(Outcome::Loss), "PLAYER_ELIMINATED"),
            (true, false, _) => (Some(Outcome::Win), "ENEMY_ELIMINATED"),
            (_, _, true) if self.state.rules.mode == BattleMode::MonsterChaser => {
                (Some(Outcome::ScoreOnly), "TURN_LIMIT")
            }
            (_, _, true) => (Some(Outcome::Draw), "TURN_LIMIT"),
            _ => (None, ""),
        };
        if let Some(outcome) = outcome {
            let progress = self.state.monster_chaser.as_ref();
            let result = TerminalResult {
                outcome,
                reason: reason.into(),
                turns: self.state.game_turn,
                damage_by_source: self
                    .state
                    .damage_by_source
                    .iter()
                    .map(|(id, damage)| (id.to_string(), *damage))
                    .collect(),
                defeated_boss_level: progress.map(|state| {
                    if state.battle_hp_remaining == 0 {
                        state.selected_level
                    } else {
                        state.current_level.saturating_sub(1)
                    }
                }),
                carry_damage: progress.map(|state| state.cumulative_damage).unwrap_or(0),
                mode_score: progress.map(|state| state.cumulative_damage).unwrap_or(0),
            };
            self.state.terminal = Some(result.clone());
            self.emit(BattleEventKind::BattleEnded { result });
        }
    }

    fn activate_next_monster_party(&mut self) -> bool {
        let Some(progress) = self.state.monster_chaser.as_mut() else {
            return false;
        };
        if progress.current_party >= progress.party_limit {
            return false;
        }
        let next_party = progress.current_party.saturating_add(1);
        let next_ids: Vec<_> = self
            .state
            .units
            .values()
            .filter(|unit| unit.side == Side::Player && unit.party_no == next_party)
            .map(|unit| unit.id)
            .collect();
        if next_ids.is_empty() {
            return false;
        }
        progress.current_party = next_party;
        for id in &next_ids {
            if let Some(unit) = self.state.units.get_mut(id) {
                unit.alive = true;
                unit.hp = unit.base_stats.max_hp;
                unit.effects.clear();
                for cooldown in unit.cooldowns.values_mut() {
                    *cooldown = 0;
                }
            }
        }
        for enemy in self
            .state
            .units
            .values_mut()
            .filter(|unit| unit.side == Side::Enemy)
        {
            enemy.triggered_skill_uses.clear();
        }
        self.state.teams[Side::Player.index()].action_order = next_ids
            .iter()
            .copied()
            .filter(|id| self.state.units[id].can_act)
            .collect();
        self.state.teams[Side::Player.index()]
            .chain_by_target
            .clear();
        self.state.teams[Side::Player.index()].sp =
            self.state.rules.initial_sp[Side::Player.index()];
        self.emit(BattleEventKind::MonsterPartyActivated {
            party_no: next_party,
            unit_ids: next_ids,
        });
        true
    }

    fn emit(&mut self, kind: BattleEventKind) {
        let event = BattleEvent {
            sequence: self.state.event_sequence,
            kind,
        };
        self.state.event_sequence += 1;
        self.state.event_log.push(event);
    }
}

#[derive(Debug, Clone)]
pub struct SimulatorBatch {
    engines: Vec<BattleEngine>,
}

impl SimulatorBatch {
    pub fn new(engines: Vec<BattleEngine>) -> Self {
        Self { engines }
    }
    pub fn len(&self) -> usize {
        self.engines.len()
    }
    pub fn is_empty(&self) -> bool {
        self.engines.is_empty()
    }
    pub fn observations(&self) -> Vec<Observation> {
        self.engines.iter().map(BattleEngine::observation).collect()
    }
    pub fn step(&mut self, plans: Vec<TeamTurnPlan>) -> Result<Vec<Transition>> {
        if plans.len() != self.engines.len() {
            return Err(BattleError::IllegalAction(
                "batch plan count mismatch".into(),
            ));
        }
        self.engines
            .iter_mut()
            .zip(plans)
            .map(|(engine, plan)| engine.step(plan))
            .collect()
    }
}

fn validate_setup(catalog: &Catalog, setup: &BattleSetup) -> Result<()> {
    if setup.units.is_empty() {
        return Err(BattleError::InvalidScenario(
            "at least one unit is required".into(),
        ));
    }
    let mut ids = BTreeSet::new();
    let mut cells: BTreeSet<(Side, u8, i8, i8)> = BTreeSet::new();
    let mut player_party_sizes = BTreeMap::<u8, usize>::new();
    for unit in &setup.units {
        if !ids.insert(unit.unit_id) {
            return Err(BattleError::InvalidScenario(format!(
                "duplicate unit id {}",
                unit.unit_id
            )));
        }
        if !setup.rules.grid.contains(unit.position) {
            return Err(BattleError::InvalidScenario(format!(
                "unit {} is outside grid",
                unit.unit_id
            )));
        }
        let party_key =
            if setup.rules.mode == BattleMode::MonsterChaser && unit.side == Side::Player {
                unit.party_no
            } else {
                1
            };
        if unit.side == Side::Player {
            *player_party_sizes.entry(party_key).or_default() += 1;
        }
        if !cells.insert((unit.side, party_key, unit.position.row, unit.position.depth)) {
            return Err(BattleError::InvalidScenario(
                "duplicate occupied cell".into(),
            ));
        }
        let character = catalog.characters.get(&unit.character_id).ok_or_else(|| {
            BattleError::MissingCatalogEntry {
                kind: "character",
                id: unit.character_id.clone(),
            }
        })?;
        if !unit
            .stat_overrides
            .as_ref()
            .unwrap_or(&character.level_100)
            .validate()
        {
            return Err(BattleError::InvalidScenario(format!(
                "invalid stats for {}",
                unit.unit_id
            )));
        }
        validate_build_settings(&unit.build_settings)?;
        resolve_equipment_modifiers(catalog, &unit.character_id, &unit.equipment)?;
        for loadout in &unit.costume_loadout {
            let costume = catalog.costumes.get(&loadout.costume_id).ok_or_else(|| {
                BattleError::MissingCatalogEntry {
                    kind: "costume",
                    id: loadout.costume_id.clone(),
                }
            })?;
            if costume.character_id != unit.character_id {
                return Err(BattleError::InvalidScenario(format!(
                    "costume '{}' does not belong to '{}'",
                    loadout.costume_id, unit.character_id
                )));
            }
            if loadout.potential_mask > 0b111 {
                return Err(BattleError::InvalidScenario(format!(
                    "costume '{}' has an invalid potential mask",
                    loadout.costume_id
                )));
            }
        }
        let bond_targets: BTreeSet<_> = unit
            .costume_loadout
            .iter()
            .filter_map(|loadout| loadout.costume_link_target.as_deref())
            .collect();
        if bond_targets.len() > 1 {
            return Err(BattleError::InvalidScenario(format!(
                "unit {} selects more than one costume bond",
                unit.unit_id
            )));
        }
        if let Some(bond_id) = bond_targets.first() {
            let bond =
                catalog
                    .costumes
                    .get(*bond_id)
                    .ok_or_else(|| BattleError::MissingCatalogEntry {
                        kind: "costume bond",
                        id: (*bond_id).into(),
                    })?;
            if bond.character_id != unit.character_id
                || !unit
                    .costume_loadout
                    .iter()
                    .any(|loadout| loadout.costume_id == *bond_id)
            {
                return Err(BattleError::InvalidScenario(format!(
                    "costume bond '{}' is not in unit {}'s loadout",
                    bond_id, unit.unit_id
                )));
            }
        }
    }
    if player_party_sizes
        .values()
        .any(|size| *size > setup.rules.grid.deployment_limit)
    {
        return Err(BattleError::InvalidScenario(
            "player party exceeds deployment limit".into(),
        ));
    }
    match (&setup.rules.mode, &setup.monster_chaser) {
        (BattleMode::MonsterChaser, Some(config)) => {
            if !catalog.monsters.contains_key(&config.monster_id) {
                return Err(BattleError::MissingCatalogEntry {
                    kind: "monster",
                    id: config.monster_id.clone(),
                });
            }
            if config.selected_level == 0
                || usize::from(config.selected_level) > config.cumulative_hp_by_level.len()
            {
                return Err(BattleError::InvalidScenario(
                    "selected monster level is outside the HP table".into(),
                ));
            }
            if config.cumulative_hp_by_level.iter().any(|hp| *hp <= 0)
                || config
                    .cumulative_hp_by_level
                    .windows(2)
                    .any(|pair| pair[0] >= pair[1])
            {
                return Err(BattleError::InvalidScenario(
                    "monster cumulative HP thresholds must be positive and strictly increasing"
                        .into(),
                ));
            }
            for unit in setup.units.iter().filter(|unit| unit.hp_owner.is_some()) {
                let owner_id = unit.hp_owner.unwrap();
                let Some(owner) = setup
                    .units
                    .iter()
                    .find(|candidate| candidate.unit_id == owner_id)
                else {
                    return Err(BattleError::InvalidScenario(format!(
                        "HP owner {owner_id} does not exist"
                    )));
                };
                if owner.side != unit.side || owner.hp_owner.is_some() {
                    return Err(BattleError::InvalidScenario(
                        "boss-part HP owner must be a root unit on the same side".into(),
                    ));
                }
            }
        }
        (BattleMode::MonsterChaser, None) => {
            return Err(BattleError::InvalidScenario(
                "Monster Chaser setup is required".into(),
            ));
        }
        (_, Some(_)) => {
            return Err(BattleError::InvalidScenario(
                "Monster Chaser setup is only valid in Monster Chaser mode".into(),
            ));
        }
        (_, None) => {}
    }
    Ok(())
}

/// Resolve a typed five-slot equipment loadout against the immutable catalog.
///
/// This function is public so import/audit tools can exercise the exact same
/// path as battle initialization. The supported live ruleset is intentionally
/// strict: crafted UR IV (Legendary) or the owner's EX UR exclusive gear,
/// score 18-24, and exactly three legal substats per equipped item.
pub fn resolve_equipment_modifiers(
    catalog: &Catalog,
    character_id: &str,
    equipment: &BTreeMap<EquipmentSlot, EquipmentLoadout>,
) -> Result<StatModifiers> {
    let mut total = StatModifiers::default();
    for (slot, loadout) in equipment {
        let definition = catalog
            .equipment
            .get(&loadout.equipment_id)
            .ok_or_else(|| BattleError::MissingCatalogEntry {
                kind: "equipment",
                id: loadout.equipment_id.clone(),
            })?;
        if definition.slot != *slot {
            return Err(BattleError::InvalidScenario(format!(
                "equipment '{}' belongs in {:?}, not {:?}",
                loadout.equipment_id, definition.slot, slot
            )));
        }
        if !matches!(
            (&definition.kind, definition.tier.as_str()),
            (EquipmentKind::CraftedLegendary, "UR4") | (EquipmentKind::Exclusive, "EX UR")
        ) {
            return Err(BattleError::InvalidScenario(format!(
                "equipment '{}' is neither Legendary UR IV nor EX UR",
                loadout.equipment_id
            )));
        }
        if definition.kind == EquipmentKind::Exclusive
            && definition.owner_character_id.as_deref() != Some(character_id)
        {
            return Err(BattleError::InvalidScenario(format!(
                "exclusive equipment '{}' does not belong to '{}'",
                loadout.equipment_id, character_id
            )));
        }
        if !(18..=24).contains(&loadout.refinement_score) {
            return Err(BattleError::InvalidScenario(format!(
                "equipment '{}' refinement score must be between 18 and 24",
                loadout.equipment_id
            )));
        }
        let main = definition
            .modifiers_by_refinement_score
            .get(&loadout.refinement_score)
            .ok_or_else(|| {
                BattleError::InvalidScenario(format!(
                    "equipment '{}' has no score {} data",
                    loadout.equipment_id, loadout.refinement_score
                ))
            })?;
        match definition.kind {
            EquipmentKind::CraftedLegendary => {
                if loadout.primary_stat.is_some() || loadout.secondary_stat.is_some() {
                    return Err(BattleError::InvalidScenario(format!(
                        "crafted equipment '{}' cannot select exclusive main stats",
                        loadout.equipment_id
                    )));
                }
            }
            EquipmentKind::Exclusive => {
                let primary = loadout.primary_stat.ok_or_else(|| {
                    BattleError::InvalidScenario(format!(
                        "exclusive equipment '{}' requires a primary stat",
                        loadout.equipment_id
                    ))
                })?;
                let secondary = loadout.secondary_stat.ok_or_else(|| {
                    BattleError::InvalidScenario(format!(
                        "exclusive equipment '{}' requires a secondary stat",
                        loadout.equipment_id
                    ))
                })?;
                if !definition.primary_stat_options.contains(&primary)
                    || !definition.secondary_stat_options.contains(&secondary)
                {
                    return Err(BattleError::InvalidScenario(format!(
                        "exclusive equipment '{}' has an illegal main-stat selection",
                        loadout.equipment_id
                    )));
                }
                let primary_modifier = definition
                    .primary_modifiers_by_refinement_score
                    .get(&loadout.refinement_score)
                    .and_then(|values| values.get(&primary))
                    .ok_or_else(|| {
                        BattleError::InvalidScenario(format!(
                            "exclusive equipment '{}' is missing primary-stat data",
                            loadout.equipment_id
                        ))
                    })?;
                let secondary_modifier = definition
                    .secondary_modifiers_by_refinement_score
                    .get(&loadout.refinement_score)
                    .and_then(|values| values.get(&secondary))
                    .ok_or_else(|| {
                        BattleError::InvalidScenario(format!(
                            "exclusive equipment '{}' is missing secondary-stat data",
                            loadout.equipment_id
                        ))
                    })?;
                accumulate_modifiers(&mut total, primary_modifier);
                accumulate_modifiers(&mut total, secondary_modifier);
            }
        }
        if loadout.substats.len() != 3 {
            return Err(BattleError::InvalidScenario(format!(
                "equipment '{}' must have exactly three substats",
                loadout.equipment_id
            )));
        }
        accumulate_modifiers(&mut total, main);
        for substat in &loadout.substats {
            if !definition.allowed_substats.contains(substat) {
                return Err(BattleError::InvalidScenario(format!(
                    "equipment '{}' does not allow substat {:?}",
                    loadout.equipment_id, substat
                )));
            }
            let modifier = definition.substat_modifiers.get(substat).ok_or_else(|| {
                BattleError::InvalidScenario(format!(
                    "equipment '{}' is missing modifier data for {:?}",
                    loadout.equipment_id, substat
                ))
            })?;
            accumulate_modifiers(&mut total, modifier);
        }
    }
    Ok(total)
}

fn validate_build_settings(settings: &crate::UnitBuildSettings) -> Result<()> {
    let collection = &settings.collection;
    if !(0..=8_000).contains(&collection.max_hp_bp)
        || !(0..=8_000).contains(&collection.attack_bp)
        || !(0..=8_000).contains(&collection.magic_bp)
        || !(0..=5_000).contains(&collection.crit_rate_bp)
    {
        return Err(BattleError::InvalidScenario(
            "collection bonuses exceed BD2DB's current ranges".into(),
        ));
    }
    let external = &settings.external_buffs;
    if external.shield_percent_bp < 0 || external.shield_flat < 0 {
        return Err(BattleError::InvalidScenario(
            "external shield values cannot be negative".into(),
        ));
    }
    let calculator = &settings.calculator;
    if !(1..=15).contains(&calculator.option_count)
        || calculator.target_condition.min_hp < 0
        || !(0..=9_000).contains(&calculator.target_condition.min_defense_bp)
        || !(0..=9_000).contains(&calculator.target_condition.min_magic_resist_bp)
    {
        return Err(BattleError::InvalidScenario(
            "equipment calculator settings are outside BD2DB's current ranges".into(),
        ));
    }
    Ok(())
}

fn build_settings_modifiers(
    attack_type: AttackType,
    settings: &crate::UnitBuildSettings,
) -> StatModifiers {
    let mut modifiers = StatModifiers {
        max_hp_bp: settings.collection.max_hp_bp,
        attack_bp: settings.collection.attack_bp,
        magic_bp: settings.collection.magic_bp,
        crit_rate_bp: settings.collection.crit_rate_bp + settings.external_buffs.crit_rate_bp,
        crit_damage_bp: settings.external_buffs.crit_damage_bp,
        property_damage_bp: settings.external_buffs.property_damage_bp
            + if settings.calculator.world_buff_enabled {
                5_000
            } else {
                0
            },
        ..StatModifiers::default()
    };
    match attack_type {
        AttackType::Physical => modifiers.attack_bp += settings.external_buffs.attack_bonus_bp,
        AttackType::Magical => modifiers.magic_bp += settings.external_buffs.attack_bonus_bp,
    }
    modifiers
}

fn select_variant(
    costume: &CostumeDefinition,
    enhancement: u8,
    burst: u8,
    potential_mask: u8,
) -> Option<&SkillVariant> {
    costume
        .variants
        .iter()
        .filter(|variant| {
            variant.enhancement <= enhancement
                && variant.burst_level <= burst
                && (variant.potential_mask == potential_mask || variant.potential_mask == 0)
        })
        .max_by_key(|variant| {
            (
                variant.potential_mask == potential_mask,
                variant.enhancement,
                variant.burst_level,
            )
        })
}

fn adjusted_sp_cost(base: i32, modifiers: &StatModifiers) -> i32 {
    (base + modifiers.sp_cost_delta).max(0)
}

fn effective_modifiers(unit: &UnitState) -> StatModifiers {
    let mut total = unit.passive_modifiers.clone();
    for effect in &unit.effects {
        accumulate_modifiers(&mut total, &effect.spec.modifiers);
    }
    total
}

fn runtime_passive_modifiers(modifiers: &StatModifiers) -> StatModifiers {
    let mut runtime = modifiers.clone();
    // These fields are already folded into UnitState::base_stats by
    // apply_permanent_modifiers. Keeping them here as well would apply them
    // twice whenever effective_stats() is evaluated.
    runtime.max_hp_flat = 0;
    runtime.max_hp_bp = 0;
    runtime.attack_flat = 0;
    runtime.attack_bp = 0;
    runtime.magic_flat = 0;
    runtime.magic_bp = 0;
    runtime.defense_bp = 0;
    runtime.magic_resist_bp = 0;
    runtime.crit_rate_bp = 0;
    runtime.crit_damage_bp = 0;
    runtime.property_damage_bp = 0;
    runtime.outgoing_damage_bp = 0;
    runtime.incoming_damage_bp = 0;
    runtime.amplification_bp = 0;
    runtime
}

fn accumulate_modifiers(total: &mut StatModifiers, value: &StatModifiers) {
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
    total.damage_reduction_bp += value.damage_reduction_bp;
    total.physical_damage_reduction_bp += value.physical_damage_reduction_bp;
    total.magical_damage_reduction_bp += value.magical_damage_reduction_bp;
    total.physical_incoming_damage_bp += value.physical_incoming_damage_bp;
    total.magical_incoming_damage_bp += value.magical_incoming_damage_bp;
    total.fire_incoming_damage_bp += value.fire_incoming_damage_bp;
    total.water_incoming_damage_bp += value.water_incoming_damage_bp;
    total.wind_incoming_damage_bp += value.wind_incoming_damage_bp;
    total.light_incoming_damage_bp += value.light_incoming_damage_bp;
    total.dark_incoming_damage_bp += value.dark_incoming_damage_bp;
    total.dot_incoming_damage_bp += value.dot_incoming_damage_bp;
    total.chain_damage_incoming_bp += value.chain_damage_incoming_bp;
    total.evasion_bp += value.evasion_bp;
    total.sp_cost_delta += value.sp_cost_delta;
    total.cooldown_delta += value.cooldown_delta;
    total.chain_received_delta += value.chain_received_delta;
    total.chain_dealt_delta += value.chain_dealt_delta;
    total.chain_retention = total.chain_retention.max(value.chain_retention);
    total.normal_attack_damage_bp += value.normal_attack_damage_bp;
    total.summon_incoming_damage_bp += value.summon_incoming_damage_bp;
    total.chain_damage_outgoing_bp += value.chain_damage_outgoing_bp;
}

fn effective_stats(unit: &UnitState) -> Stats {
    let mods = effective_modifiers(unit);
    let mut stats = unit.base_stats.clone();
    stats.max_hp = mul_floor(
        stats.max_hp.saturating_add(mods.max_hp_flat),
        10_000 + mods.max_hp_bp,
    )
    .max(1);
    stats.attack = mul_floor(
        stats.attack.saturating_add(mods.attack_flat),
        10_000 + mods.attack_bp,
    )
    .max(0);
    stats.magic = mul_floor(
        stats.magic.saturating_add(mods.magic_flat),
        10_000 + mods.magic_bp,
    )
    .max(0);
    stats.defense_bp += mods.defense_bp;
    stats.magic_resist_bp += mods.magic_resist_bp;
    stats.crit_rate_bp += mods.crit_rate_bp;
    stats.crit_damage_bp += mods.crit_damage_bp;
    stats.property_damage_bp += mods.property_damage_bp;
    stats.outgoing_damage_bp += mods.outgoing_damage_bp;
    stats.incoming_damage_bp += mods.incoming_damage_bp;
    stats.amplification_bp += mods.amplification_bp;
    stats
}

fn apply_permanent_modifiers(stats: &mut Stats, mods: &StatModifiers) {
    stats.max_hp = mul_floor(
        stats.max_hp.saturating_add(mods.max_hp_flat),
        10_000 + mods.max_hp_bp,
    )
    .max(1);
    stats.attack = mul_floor(
        stats.attack.saturating_add(mods.attack_flat),
        10_000 + mods.attack_bp,
    )
    .max(0);
    stats.magic = mul_floor(
        stats.magic.saturating_add(mods.magic_flat),
        10_000 + mods.magic_bp,
    )
    .max(0);
    stats.defense_bp += mods.defense_bp;
    stats.magic_resist_bp += mods.magic_resist_bp;
    stats.crit_rate_bp += mods.crit_rate_bp;
    stats.crit_damage_bp += mods.crit_damage_bp;
    stats.property_damage_bp += mods.property_damage_bp;
    stats.outgoing_damage_bp += mods.outgoing_damage_bp;
    stats.incoming_damage_bp += mods.incoming_damage_bp;
    stats.amplification_bp += mods.amplification_bp;
}

fn has_tag(unit: &UnitState, tag: &str) -> bool {
    unit.effects
        .iter()
        .any(|effect| effect.spec.tags.contains(tag))
}
fn mul_floor(value: i64, factor_bp: i32) -> i64 {
    (value as i128 * factor_bp as i128).div_euclid(10_000) as i64
}
fn modifier_strength(mods: &StatModifiers) -> i64 {
    let basis_point_strength: i64 = [
        mods.max_hp_bp,
        mods.attack_bp,
        mods.magic_bp,
        mods.defense_bp,
        mods.magic_resist_bp,
        mods.crit_rate_bp,
        mods.crit_damage_bp,
        mods.property_damage_bp,
        mods.outgoing_damage_bp,
        mods.incoming_damage_bp,
        mods.amplification_bp,
        mods.damage_reduction_bp,
        mods.physical_damage_reduction_bp,
        mods.magical_damage_reduction_bp,
        mods.physical_incoming_damage_bp,
        mods.magical_incoming_damage_bp,
        mods.fire_incoming_damage_bp,
        mods.water_incoming_damage_bp,
        mods.wind_incoming_damage_bp,
        mods.light_incoming_damage_bp,
        mods.dark_incoming_damage_bp,
        mods.dot_incoming_damage_bp,
        mods.chain_damage_incoming_bp,
        mods.evasion_bp,
        mods.normal_attack_damage_bp,
    ]
    .into_iter()
    .map(|value| value.unsigned_abs() as i64)
    .sum();
    basis_point_strength
        .saturating_add(mods.max_hp_flat.unsigned_abs() as i64)
        .saturating_add(mods.attack_flat.unsigned_abs() as i64)
        .saturating_add(mods.magic_flat.unsigned_abs() as i64)
}
fn knockback_delta(direction: crate::KnockbackDirection) -> (i8, i8) {
    use crate::KnockbackDirection::*;
    match direction {
        Back => (0, 1),
        Front => (0, -1),
        Up => (-1, 0),
        Down => (1, 0),
        UpBack => (-1, 1),
        DownBack => (1, 1),
        UpFront => (-1, -1),
        DownFront => (1, -1),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        BarrierSpec, CostumeLoadout, CounterSpec, EffectSpec, Element, EquipmentDefinition,
        EquipmentStat, GridDefinition, MonsterChaserSetup, MonsterDefinition, Offset, PeriodicSpec,
        SourceRecord, StackRule, UnitBuildSettings, UnitSetup,
    };

    fn stats(hp: i64, attack: i64) -> Stats {
        Stats {
            max_hp: hp,
            attack,
            magic: attack,
            crit_rate_bp: 0,
            crit_damage_bp: 5_000,
            defense_bp: 0,
            magic_resist_bp: 0,
            property_damage_bp: 5_000,
            outgoing_damage_bp: 0,
            incoming_damage_bp: 0,
            amplification_bp: 0,
        }
    }
    fn effect_spec(id: &str) -> EffectSpec {
        EffectSpec {
            effect_id: id.into(),
            polarity: EffectPolarity::Beneficial,
            recipient: EffectRecipient::TargetSide,
            duration: 1,
            duration_clock: DurationClock::GameTurn,
            modifiers: StatModifiers::default(),
            tags: BTreeSet::new(),
            stack_rule: StackRule::ReplaceSameSource,
            barrier: None,
            periodic: None,
            charges: None,
            counter: None,
            revive_hp_bp: None,
            max_stacks: None,
            conditional_outgoing: Vec::new(),
            on_hit_received_allies: None,
            on_hit_received_operations: Vec::new(),
            on_turn_end_operations: Vec::new(),
            aura_allies: None,
            aura_opponents: None,
            on_chain_dealt: None,
        }
    }
    fn catalog() -> Arc<Catalog> {
        let mut catalog = Catalog {
            ruleset_id: "test-current".into(),
            ..Catalog::default()
        };
        for (id, element) in [("hero", Element::Fire), ("enemy", Element::Wind)] {
            catalog.characters.insert(
                id.into(),
                crate::CharacterDefinition {
                    id: id.into(),
                    names: BTreeMap::new(),
                    rarity: 5,
                    element,
                    attack_type: AttackType::Physical,
                    target_selector: TargetSelector::Front,
                    level_100: stats(1_000, 100),
                    engraving_modifiers: StatModifiers::default(),
                    awakening_modifiers: StatModifiers::default(),
                    costume_ids: if id == "hero" {
                        vec!["hero_skill".into()]
                    } else {
                        vec![]
                    },
                    source: SourceRecord::default(),
                },
            );
        }
        catalog.costumes.insert(
            "hero_skill".into(),
            CostumeDefinition {
                id: "hero_skill".into(),
                character_id: "hero".into(),
                names: BTreeMap::new(),
                skill_names: BTreeMap::new(),
                range: vec![Offset { row: 0, depth: 0 }],
                variants: vec![SkillVariant {
                    enhancement: 5,
                    burst_level: 0,
                    potential_mask: 0,
                    sp_cost: 2,
                    cooldown: 3,
                    selector: TargetSelector::Front,
                    fixed_target_cell: None,
                    target_all: false,
                    range_override: None,
                    operations: vec![SkillOperation::DealDamage {
                        kind: DamageKind::Physical,
                        coefficient_bp: 10_000,
                        reference: None,
                        scaling: None,
                        hits: 2,
                        can_crit: false,
                        can_evade: true,
                        chain_per_hit: 1,
                        main_target_bonus_bp: 0,
                    }],
                    consume_remaining_sp: false,
                    executable: true,
                    compile_diagnostics: vec![],
                    preemptive: false,
                    activation_condition: None,
                    max_uses_per_party: None,
                    ai_sequence_index: None,
                    description_ja: "test".into(),
                }],
                permanent_potential_modifiers: StatModifiers::default(),
                bonding_modifiers: StatModifiers::default(),
                executable: true,
                compile_diagnostics: vec![],
                source: SourceRecord::default(),
            },
        );
        catalog.equipment.insert(
            "legendary-test".into(),
            EquipmentDefinition {
                id: "legendary-test".into(),
                names: BTreeMap::new(),
                kind: EquipmentKind::CraftedLegendary,
                tier: "UR4".into(),
                slot: EquipmentSlot::Weapon,
                owner_character_id: None,
                modifiers_by_refinement_score: BTreeMap::from([(
                    18,
                    StatModifiers {
                        max_hp_flat: 10,
                        max_hp_bp: 100,
                        attack_flat: 1,
                        attack_bp: 100,
                        ..StatModifiers::default()
                    },
                )]),
                primary_stat_options: vec![],
                secondary_stat_options: vec![],
                primary_modifiers_by_refinement_score: BTreeMap::new(),
                secondary_modifiers_by_refinement_score: BTreeMap::new(),
                allowed_substats: vec![EquipmentStat::CritRate],
                substat_modifiers: BTreeMap::from([(
                    EquipmentStat::CritRate,
                    StatModifiers::default(),
                )]),
                source: SourceRecord::default(),
            },
        );
        Arc::new(catalog)
    }
    fn setup(mode: BattleMode) -> BattleSetup {
        let rules = match mode {
            BattleMode::Normal => crate::ModeRules::normal(),
            BattleMode::MirrorWar => crate::ModeRules::mirror_war(),
            BattleMode::MonsterChaser => crate::ModeRules::monster_chaser(),
        };
        BattleSetup {
            scenario_id: "test".into(),
            rules,
            units: vec![
                UnitSetup {
                    unit_id: 1,
                    character_id: "hero".into(),
                    side: Side::Player,
                    position: Cell { row: 0, depth: 0 },
                    costume_loadout: vec![CostumeLoadout {
                        costume_id: "hero_skill".into(),
                        enhancement: 5,
                        burst_level: 0,
                        potential_mask: 0,
                        permanent_potential_enabled: false,
                        costume_link_target: None,
                    }],
                    build_settings: UnitBuildSettings::unmodified(),
                    stat_overrides: None,
                    equipment: BTreeMap::new(),
                    ai_priority: vec![],
                    party_no: 1,
                    hp_owner: None,
                    weak_point_bonus_bp: 0,
                    can_act: true,
                },
                UnitSetup {
                    unit_id: 2,
                    character_id: "enemy".into(),
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
        }
    }

    #[test]
    fn normal_attack_uses_element_and_chain_pipeline() {
        let mut engine = BattleEngine::new(catalog(), setup(BattleMode::Normal), 1).unwrap();
        let plan = TeamTurnPlan {
            side: Side::Player,
            order: vec![1],
            commands: BTreeMap::from([(1, UnitCommand::NormalAttack)]),
            formation: BTreeMap::new(),
        };
        engine.step(plan).unwrap();
        assert_eq!(engine.state.units[&2].hp, 850);
        assert_eq!(engine.state.teams[0].sp, 16);
    }

    #[test]
    fn multi_hit_uses_pre_hit_chain_and_floors_each_hit() {
        let mut engine = BattleEngine::new(catalog(), setup(BattleMode::Normal), 1).unwrap();
        let plan = TeamTurnPlan {
            side: Side::Player,
            order: vec![1],
            commands: BTreeMap::from([(
                1,
                UnitCommand::UseCostume {
                    costume_id: "hero_skill".into(),
                    burst_level: 0,
                    explicit_target: None,
                },
            )]),
            formation: BTreeMap::new(),
        };
        engine.step(plan).unwrap();
        assert_eq!(engine.state.units[&2].hp, 685); // 150 + floor(150*1.1)
        assert_eq!(engine.state.teams[0].sp, 13);
    }

    #[test]
    fn snapshot_restore_is_bit_exact() {
        let mut first = BattleEngine::new(catalog(), setup(BattleMode::Normal), 99).unwrap();
        let snapshot = first.state_json().unwrap();
        let mut second = BattleEngine::new(catalog(), setup(BattleMode::Normal), 1).unwrap();
        second.restore_json(&snapshot).unwrap();
        assert_eq!(first.snapshot(), second.snapshot());
        assert_eq!(first.step_auto().unwrap(), second.step_auto().unwrap());
    }

    #[test]
    fn terminal_snapshot_with_damage_restores() {
        let mut first = BattleEngine::new(catalog(), setup(BattleMode::Normal), 99).unwrap();
        while first.state.terminal.is_none() {
            first.step_auto().unwrap();
        }
        let snapshot = first.state_json().unwrap();
        let mut second = BattleEngine::new(catalog(), setup(BattleMode::Normal), 1).unwrap();
        second.restore_json(&snapshot).unwrap();
        assert_eq!(first.snapshot(), second.snapshot());
    }

    #[test]
    fn mirror_war_recovers_both_sides_after_attack_turn() {
        let mut engine = BattleEngine::new(catalog(), setup(BattleMode::MirrorWar), 1).unwrap();
        engine.step_auto().unwrap();
        assert_eq!(
            [engine.state.teams[0].sp, engine.state.teams[1].sp],
            [9, 12]
        );
        assert_eq!(engine.state.active_side, Side::Enemy);
    }

    #[test]
    fn duplicate_cells_are_rejected() {
        let mut bad = setup(BattleMode::Normal);
        bad.units.push(UnitSetup {
            unit_id: 3,
            character_id: "hero".into(),
            side: Side::Player,
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
        });
        assert!(BattleEngine::new(catalog(), bad, 1).is_err());
    }

    #[test]
    fn standard_grid_has_expected_shape() {
        assert_eq!(GridDefinition::standard().deployment_limit, 5);
        assert!(GridDefinition::standard().contains(Cell { row: 2, depth: 3 }));
        assert!(!GridDefinition::standard().contains(Cell { row: 3, depth: 0 }));
    }

    #[test]
    fn knockback_moves_until_first_ally_and_uses_skill_collision_coefficient() {
        let mut battle_setup = setup(BattleMode::Normal);
        battle_setup.units.push(UnitSetup {
            unit_id: 3,
            character_id: "enemy".into(),
            side: Side::Enemy,
            position: Cell { row: 0, depth: 2 },
            costume_loadout: vec![],
            build_settings: UnitBuildSettings::unmodified(),
            stat_overrides: None,
            equipment: BTreeMap::new(),
            ai_priority: vec![],
            party_no: 1,
            hp_owner: None,
            weak_point_bonus_bp: 0,
            can_act: true,
        });
        let mut engine = BattleEngine::new(catalog(), battle_setup, 1).unwrap();

        engine
            .knockback(2, crate::KnockbackDirection::Back, 3, 5_000)
            .unwrap();

        assert_eq!(engine.state.units[&2].position, Cell { row: 0, depth: 1 });
        assert_eq!(engine.state.units[&3].hp, 500);
        assert!(engine.state.event_log.iter().any(|event| matches!(
            event.kind,
            BattleEventKind::CollisionDamage {
                moving_id: 2,
                occupant_id: 3,
                amount: 500
            }
        )));
    }

    #[test]
    fn potential_bond_and_equipment_stats_are_data_driven_and_additive() {
        let mut catalog = catalog();
        let mutable = Arc::make_mut(&mut catalog);
        let costume = mutable.costumes.get_mut("hero_skill").unwrap();
        costume.permanent_potential_modifiers = StatModifiers {
            max_hp_flat: 100,
            max_hp_bp: 1_000,
            attack_flat: 20,
            attack_bp: 1_000,
            ..StatModifiers::default()
        };
        costume.bonding_modifiers = StatModifiers {
            max_hp_flat: 50,
            max_hp_bp: 500,
            attack_flat: 5,
            attack_bp: 500,
            ..StatModifiers::default()
        };
        let mut setup = setup(BattleMode::Normal);
        setup.units[0].costume_loadout[0].permanent_potential_enabled = true;
        setup.units[0].costume_loadout[0].costume_link_target = Some("hero_skill".into());
        setup.units[0].equipment.insert(
            EquipmentSlot::Weapon,
            EquipmentLoadout {
                equipment_id: "legendary-test".into(),
                refinement_score: 18,
                primary_stat: None,
                secondary_stat: None,
                substats: vec![
                    EquipmentStat::CritRate,
                    EquipmentStat::CritRate,
                    EquipmentStat::CritRate,
                ],
            },
        );

        let engine = BattleEngine::new(catalog, setup, 1).unwrap();
        let stats = &engine.state().units[&1].base_stats;
        assert_eq!(stats.max_hp, 1_345);
        assert_eq!(stats.attack, 146);
    }

    #[test]
    fn equipment_loadouts_reject_invalid_score_slot_and_substat_count() {
        let mut configured = setup(BattleMode::Normal);
        configured.units[0].equipment.insert(
            EquipmentSlot::Weapon,
            EquipmentLoadout {
                equipment_id: "legendary-test".into(),
                refinement_score: 17,
                primary_stat: None,
                secondary_stat: None,
                substats: vec![EquipmentStat::CritRate; 3],
            },
        );
        assert!(BattleEngine::new(catalog(), configured.clone(), 1).is_err());

        let loadout = configured.units[0]
            .equipment
            .remove(&EquipmentSlot::Weapon)
            .unwrap();
        configured.units[0].equipment.insert(
            EquipmentSlot::Armor,
            EquipmentLoadout {
                refinement_score: 18,
                ..loadout
            },
        );
        assert!(BattleEngine::new(catalog(), configured.clone(), 1).is_err());

        let invalid = configured.units[0]
            .equipment
            .get_mut(&EquipmentSlot::Armor)
            .unwrap();
        invalid.refinement_score = 18;
        invalid.substats.pop();
        assert!(BattleEngine::new(catalog(), configured, 1).is_err());
    }

    #[test]
    fn bd2db_build_inputs_are_applied_once_and_can_be_disabled() {
        let mut configured_catalog = catalog();
        let hero = Arc::make_mut(&mut configured_catalog)
            .characters
            .get_mut("hero")
            .unwrap();
        hero.engraving_modifiers = StatModifiers {
            attack_flat: 10,
            attack_bp: 1_000,
            ..StatModifiers::default()
        };
        hero.awakening_modifiers = StatModifiers {
            attack_flat: 5,
            attack_bp: 500,
            property_damage_bp: 1_000,
            ..StatModifiers::default()
        };
        let mut configured = setup(BattleMode::Normal);
        configured.units[0].build_settings = UnitBuildSettings::default();
        configured.units[0]
            .build_settings
            .external_buffs
            .attack_bonus_bp = 1_000;
        configured.units[0]
            .build_settings
            .external_buffs
            .crit_rate_bp = 250;
        configured.units[0]
            .build_settings
            .external_buffs
            .crit_damage_bp = 2_000;
        configured.units[0]
            .build_settings
            .external_buffs
            .property_damage_bp = 500;
        configured.units[0]
            .build_settings
            .calculator
            .world_buff_enabled = true;

        let engine = BattleEngine::new(configured_catalog.clone(), configured.clone(), 1).unwrap();
        let effective = &engine.state().units[&1].base_stats;
        assert_eq!(effective.max_hp, 1_800);
        assert_eq!(effective.attack, 235);
        assert_eq!(effective.crit_rate_bp, 5_250);
        assert_eq!(effective.crit_damage_bp, 7_000);
        assert_eq!(effective.property_damage_bp, 11_500);

        configured.units[0].build_settings = UnitBuildSettings::unmodified();
        let unmodified = BattleEngine::new(configured_catalog, configured, 1).unwrap();
        assert_eq!(unmodified.state().units[&1].base_stats, stats(1_000, 100));
    }

    #[test]
    fn bd2db_build_input_ranges_fail_closed() {
        let mut configured = setup(BattleMode::Normal);
        configured.units[0].build_settings.collection.attack_bp = 8_001;
        assert!(BattleEngine::new(catalog(), configured.clone(), 1).is_err());

        configured.units[0].build_settings.collection.attack_bp = 0;
        configured.units[0]
            .build_settings
            .calculator
            .target_condition
            .min_defense_bp = 9_001;
        assert!(BattleEngine::new(catalog(), configured.clone(), 1).is_err());

        configured.units[0]
            .build_settings
            .calculator
            .target_condition
            .min_defense_bp = 0;
        configured.units[0]
            .build_settings
            .external_buffs
            .shield_flat = -1;
        assert!(BattleEngine::new(catalog(), configured, 1).is_err());
    }

    #[test]
    fn external_flat_and_percent_shields_initialize_and_deplete_energy_guard() {
        let mut configured = setup(BattleMode::Normal);
        configured.units[0]
            .build_settings
            .external_buffs
            .shield_flat = 100;
        configured.units[0]
            .build_settings
            .external_buffs
            .shield_percent_bp = 1_000;
        let mut engine = BattleEngine::new(catalog(), configured, 1).unwrap();

        assert_eq!(
            engine.reference_value(1, 2, StatReference::EnergyGuard),
            200
        );
        engine.apply_raw_damage(2, 1, 150, false, 1);
        assert_eq!(engine.state.units[&1].hp, 1_000);
        assert_eq!(engine.state.units[&1].external_energy_guard, 50);
        engine.apply_raw_damage(2, 1, 100, false, 1);
        assert_eq!(engine.state.units[&1].hp, 950);
        assert_eq!(engine.state.units[&1].external_energy_guard, 0);
    }

    #[test]
    fn rejected_turn_is_atomic_and_dead_units_cannot_be_placed() {
        let mut engine = BattleEngine::new(catalog(), setup(BattleMode::Normal), 1).unwrap();
        let before = engine.state.clone();
        let invalid_order = TeamTurnPlan {
            side: Side::Player,
            order: vec![1, 1],
            commands: BTreeMap::from([(1, UnitCommand::NormalAttack)]),
            formation: BTreeMap::from([(1, Cell { row: 2, depth: 3 })]),
        };
        assert!(engine.step(invalid_order).is_err());
        assert_eq!(engine.state, before);

        engine.state.units.get_mut(&1).unwrap().alive = false;
        let before_dead_move = engine.state.clone();
        let dead_move = TeamTurnPlan {
            side: Side::Player,
            order: vec![1],
            commands: BTreeMap::from([(1, UnitCommand::NormalAttack)]),
            formation: BTreeMap::from([(1, Cell { row: 2, depth: 3 })]),
        };
        assert!(engine.step(dead_move).is_err());
        assert_eq!(engine.state, before_dead_move);
    }

    #[test]
    fn on_hit_received_runs_typed_operations_and_consumes_charge() {
        let mut engine = BattleEngine::new(catalog(), setup(BattleMode::Normal), 1).unwrap();
        let mut trigger = effect_spec("reactive");
        trigger.recipient = EffectRecipient::ActorSide;
        trigger.duration_clock = DurationClock::Permanent;
        trigger.tags.insert("ON_HIT".into());
        trigger.charges = Some(1);
        trigger.on_hit_received_operations = vec![
            SkillOperation::Heal {
                coefficient_bp: 1_000,
                reference: StatReference::MaxHp,
                can_crit: false,
                recipient: EffectRecipient::ActorSide,
            },
            SkillOperation::ChangeSp {
                amount: 2,
                side: EffectRecipient::ActorSide,
            },
        ];
        engine.apply_effect(2, 2, trigger);

        engine.apply_raw_damage(1, 2, 130, false, 1);

        assert_eq!(engine.state.units[&2].hp, 970);
        assert_eq!(engine.state.teams[Side::Enemy.index()].sp, 2);
        assert!(engine.state.units[&2].effects.is_empty());
    }

    #[test]
    fn next_ally_selector_follows_action_order() {
        let mut battle_setup = setup(BattleMode::Normal);
        battle_setup.units.push(UnitSetup {
            unit_id: 3,
            character_id: "hero".into(),
            side: Side::Player,
            position: Cell { row: 1, depth: 0 },
            costume_loadout: vec![],
            build_settings: UnitBuildSettings::unmodified(),
            stat_overrides: None,
            equipment: BTreeMap::new(),
            ai_priority: vec![],
            party_no: 1,
            hp_owner: None,
            weak_point_bonus_bp: 0,
            can_act: true,
        });
        let engine = BattleEngine::new(catalog(), battle_setup, 1).unwrap();
        assert_eq!(
            engine
                .select_main_target(1, TargetSelector::NextAllyInOrder, None)
                .unwrap(),
            3
        );
    }

    #[test]
    fn barrier_absorbs_before_hp_and_reports_remaining_capacity() {
        let mut engine = BattleEngine::new(catalog(), setup(BattleMode::Normal), 1).unwrap();
        let mut barrier = effect_spec("guard");
        barrier.barrier = Some(BarrierSpec {
            coefficient_bp: 10_000,
            reference: StatReference::Attack,
        });
        engine.apply_effect(1, 2, barrier);
        engine.apply_raw_damage(1, 2, 130, false, 1);
        assert_eq!(engine.state.units[&2].hp, 970);
        assert!(engine.state.event_log.iter().any(|event| matches!(
            event.kind,
            BattleEventKind::BarrierAbsorbed {
                amount: 100,
                remaining: 0,
                ..
            }
        )));
    }

    #[test]
    fn evasion_charge_only_consumes_on_an_evaded_hit() {
        let mut engine = BattleEngine::new(catalog(), setup(BattleMode::Normal), 1).unwrap();
        let mut evasion = effect_spec("evade");
        evasion.modifiers.evasion_bp = 10_000;
        evasion.tags.insert("EVASION".into());
        evasion.charges = Some(1);
        evasion.duration_clock = DurationClock::Permanent;
        engine.apply_effect(2, 2, evasion);
        engine
            .deal_damage(
                1,
                2,
                DamageKind::Physical,
                10_000,
                None,
                false,
                true,
                1,
                1,
                0,
            )
            .unwrap();
        assert_eq!(engine.state.units[&2].hp, 1_000);
        assert!(!has_tag(&engine.state.units[&2], "EVASION"));
        engine
            .deal_damage(
                1,
                2,
                DamageKind::Physical,
                10_000,
                None,
                false,
                true,
                1,
                1,
                0,
            )
            .unwrap();
        assert_eq!(engine.state.units[&2].hp, 850);
    }

    #[test]
    fn mark_prevents_evasion_without_consuming_evasion_charge() {
        let mut engine = BattleEngine::new(catalog(), setup(BattleMode::Normal), 1).unwrap();
        let mut evasion = effect_spec("evade");
        evasion.modifiers.evasion_bp = 10_000;
        evasion.tags.insert("EVASION".into());
        evasion.charges = Some(1);
        evasion.duration_clock = DurationClock::Permanent;
        engine.apply_effect(2, 2, evasion);
        let mut mark = effect_spec("mark");
        mark.polarity = EffectPolarity::Harmful;
        mark.tags.insert("MARK".into());
        engine.apply_effect(1, 2, mark);

        engine
            .deal_damage(
                1,
                2,
                DamageKind::Physical,
                10_000,
                None,
                false,
                true,
                1,
                1,
                0,
            )
            .unwrap();

        assert_eq!(engine.state.units[&2].hp, 850);
        assert_eq!(
            engine.state.units[&2]
                .effects
                .iter()
                .find(|active| active.spec.effect_id == "evade")
                .unwrap()
                .charges_remaining,
            Some(1)
        );
    }

    #[test]
    fn actor_and_opponent_team_recipients_ignore_selected_target_side() {
        let mut battle_setup = setup(BattleMode::Normal);
        battle_setup.units.push(UnitSetup {
            unit_id: 3,
            character_id: "hero".into(),
            side: Side::Player,
            position: Cell { row: 1, depth: 0 },
            costume_loadout: vec![],
            build_settings: UnitBuildSettings::unmodified(),
            stat_overrides: None,
            equipment: BTreeMap::new(),
            ai_priority: vec![],
            party_no: 1,
            hp_owner: None,
            weak_point_bonus_bp: 0,
            can_act: true,
        });
        let mut engine = BattleEngine::new(catalog(), battle_setup, 1).unwrap();
        let mut allies = effect_spec("allies");
        allies.recipient = EffectRecipient::ActorTeam;
        engine
            .execute_operation(1, 2, &[2], SkillOperation::ApplyEffect { effect: allies })
            .unwrap();
        assert!(
            engine.state.units[&1]
                .effects
                .iter()
                .any(|active| active.spec.effect_id == "allies")
        );
        assert!(
            engine.state.units[&3]
                .effects
                .iter()
                .any(|active| active.spec.effect_id == "allies")
        );
        assert!(
            !engine.state.units[&2]
                .effects
                .iter()
                .any(|active| active.spec.effect_id == "allies")
        );

        let mut opponents = effect_spec("opponents");
        opponents.recipient = EffectRecipient::OpponentTeam;
        engine
            .execute_operation(
                1,
                1,
                &[1],
                SkillOperation::ApplyEffect { effect: opponents },
            )
            .unwrap();
        assert!(
            engine.state.units[&2]
                .effects
                .iter()
                .any(|active| active.spec.effect_id == "opponents")
        );
    }

    #[test]
    fn absorbing_team_debuffs_applies_one_stack_per_removed_effect_to_each_ally() {
        let mut battle_setup = setup(BattleMode::Normal);
        battle_setup.units.push(UnitSetup {
            unit_id: 3,
            character_id: "hero".into(),
            side: Side::Player,
            position: Cell { row: 1, depth: 0 },
            costume_loadout: vec![],
            build_settings: UnitBuildSettings::unmodified(),
            stat_overrides: None,
            equipment: BTreeMap::new(),
            ai_priority: vec![],
            party_no: 1,
            hp_owner: None,
            weak_point_bonus_bp: 0,
            can_act: true,
        });
        let mut engine = BattleEngine::new(catalog(), battle_setup, 1).unwrap();
        let mut debuff = effect_spec("debuff");
        debuff.polarity = EffectPolarity::Harmful;
        engine.apply_effect(2, 1, debuff.clone());
        engine.apply_effect(2, 3, debuff);
        let mut stack = effect_spec("absorbed");
        stack.recipient = EffectRecipient::TargetSide;
        stack.stack_rule = StackRule::Independent;
        stack.max_stacks = Some(3);

        engine
            .execute_operation(
                1,
                1,
                &[1],
                SkillOperation::AbsorbEffectsAndApplyStacks {
                    polarity: EffectPolarity::Harmful,
                    recipient: EffectRecipient::ActorTeam,
                    effect: stack,
                    max_stacks: 3,
                },
            )
            .unwrap();

        for id in [1, 3] {
            assert_eq!(
                engine.state.units[&id]
                    .effects
                    .iter()
                    .filter(|active| active.spec.effect_id == "absorbed")
                    .count(),
                2
            );
            assert!(
                !engine.state.units[&id]
                    .effects
                    .iter()
                    .any(|active| active.spec.polarity == EffectPolarity::Harmful)
            );
        }
    }

    #[test]
    fn rampage_consumes_remaining_sp_and_scales_only_the_extra_sp() {
        let mut owned = (*catalog()).clone();
        let variant = &mut owned.costumes.get_mut("hero_skill").unwrap().variants[0];
        variant.consume_remaining_sp = true;
        variant.operations = vec![SkillOperation::DealDamage {
            kind: DamageKind::Physical,
            coefficient_bp: 10_000,
            reference: None,
            scaling: Some(crate::DamageScaling {
                source: crate::DamageScalingSource::ExtraSpConsumed,
                coefficient_bp_per_unit: 1_000,
            }),
            hits: 1,
            can_crit: false,
            can_evade: false,
            chain_per_hit: 1,
            main_target_bonus_bp: 0,
        }];
        let mut engine = BattleEngine::new(Arc::new(owned), setup(BattleMode::Normal), 1).unwrap();
        let plan = TeamTurnPlan {
            side: Side::Player,
            order: vec![1],
            commands: BTreeMap::from([(
                1,
                UnitCommand::UseCostume {
                    costume_id: "hero_skill".into(),
                    burst_level: 0,
                    explicit_target: None,
                },
            )]),
            formation: BTreeMap::new(),
        };

        engine.step(plan).unwrap();

        assert_eq!(engine.state.teams[Side::Player.index()].sp, 0);
        assert_eq!(engine.state.units[&2].hp, 655);
    }

    #[test]
    fn summon_inherits_summoner_base_stats_and_selected_enhancement() {
        let mut owned = (*catalog()).clone();
        owned.characters.insert(
            "summon".into(),
            crate::CharacterDefinition {
                id: "summon".into(),
                names: BTreeMap::new(),
                rarity: 0,
                element: Element::Fire,
                attack_type: AttackType::Physical,
                target_selector: TargetSelector::Front,
                level_100: stats(1, 1),
                engraving_modifiers: StatModifiers::default(),
                awakening_modifiers: StatModifiers::default(),
                costume_ids: vec!["summon_skill".into()],
                source: SourceRecord::default(),
            },
        );
        let mut summon_costume = owned.costumes["hero_skill"].clone();
        summon_costume.id = "summon_skill".into();
        summon_costume.character_id = "summon".into();
        summon_costume.variants[0].enhancement = 2;
        owned.costumes.insert("summon_skill".into(), summon_costume);
        let mut engine = BattleEngine::new(Arc::new(owned), setup(BattleMode::Normal), 1).unwrap();

        engine
            .summon_unit(1, "summon", "summon_skill", 2, true)
            .unwrap();

        let summon = engine
            .state
            .units
            .values()
            .find(|unit| unit.is_summon)
            .unwrap();
        assert_eq!(summon.base_stats, engine.state.units[&1].base_stats);
        assert_eq!(summon.costume_loadout[0].enhancement, 2);
        assert_eq!(summon.position, Cell { row: 1, depth: 0 });
    }

    #[test]
    fn periodic_damage_ticks_before_expiration() {
        let mut engine = BattleEngine::new(catalog(), setup(BattleMode::Normal), 1).unwrap();
        let mut dot = effect_spec("burn");
        dot.polarity = EffectPolarity::Harmful;
        dot.periodic = Some(PeriodicSpec {
            kind: DamageKind::Dot,
            coefficient_bp: 10_000,
            reference: StatReference::Attack,
            stacks: 1,
        });
        engine.apply_effect(1, 2, dot);
        engine.tick_effects(2, DurationClock::GameTurn);
        assert_eq!(engine.state.units[&2].hp, 850);
        assert!(engine.state.units[&2].effects.is_empty());
    }

    #[test]
    fn periodic_stacks_accumulate_to_the_external_cap() {
        let mut engine = BattleEngine::new(catalog(), setup(BattleMode::Normal), 1).unwrap();
        let mut dot = effect_spec("stacking-burn");
        dot.polarity = EffectPolarity::Harmful;
        dot.duration = 2;
        dot.stack_rule = StackRule::Accumulate;
        dot.max_stacks = Some(3);
        dot.periodic = Some(PeriodicSpec {
            kind: DamageKind::Dot,
            coefficient_bp: 10_000,
            reference: StatReference::Attack,
            stacks: 2,
        });
        engine.apply_effect(1, 2, dot.clone());
        engine.apply_effect(1, 2, dot);
        assert_eq!(
            engine.state.units[&2].effects[0]
                .spec
                .periodic
                .as_ref()
                .unwrap()
                .stacks,
            3
        );
        engine.tick_effects(2, DurationClock::GameTurn);
        assert_eq!(engine.state.units[&2].hp, 550);
    }

    #[test]
    fn turn_end_effect_runs_once_before_duration_decrements() {
        let mut engine = BattleEngine::new(catalog(), setup(BattleMode::Normal), 1).unwrap();
        let mut effect = effect_spec("turn-sp");
        effect.recipient = EffectRecipient::ActorSide;
        effect.duration = 2;
        effect.on_turn_end_operations = vec![SkillOperation::ChangeSp {
            amount: 1,
            side: EffectRecipient::ActorSide,
        }];
        engine.apply_effect(1, 1, effect);
        engine.tick_effects(1, DurationClock::GameTurn);
        assert_eq!(engine.state.teams[Side::Player.index()].sp, 16);
        assert_eq!(engine.state.units[&1].effects[0].remaining, 1);
    }

    #[test]
    fn revive_and_counter_are_non_recursive_reactions() {
        let mut engine = BattleEngine::new(catalog(), setup(BattleMode::Normal), 1).unwrap();
        let mut reaction = effect_spec("reaction");
        reaction.duration_clock = DurationClock::Permanent;
        reaction.revive_hp_bp = Some(5_000);
        reaction.counter = Some(CounterSpec {
            kind: DamageKind::Physical,
            coefficient_bp: 10_000,
            reference: StatReference::Attack,
            target_all: false,
        });
        engine.apply_effect(2, 2, reaction);
        engine.apply_raw_damage(1, 2, 1_000, false, 1);
        assert!(engine.state.units[&2].alive);
        assert_eq!(engine.state.units[&2].hp, 500);
        assert_eq!(
            engine.state.units[&1].hp, 1_000,
            "a lethal hit that revives returns before counter resolution"
        );
        let mut counter = effect_spec("counter");
        counter.duration_clock = DurationClock::Permanent;
        counter.counter = Some(CounterSpec {
            kind: DamageKind::Physical,
            coefficient_bp: 10_000,
            reference: StatReference::Attack,
            target_all: false,
        });
        engine.apply_effect(2, 2, counter);
        engine.apply_raw_damage(1, 2, 10, false, 1);
        assert_eq!(engine.state.units[&1].hp, 950);
    }

    #[test]
    fn dead_units_have_no_command_but_keep_their_turn_order_for_revive() {
        let mut engine = BattleEngine::new(catalog(), setup(BattleMode::Normal), 1).unwrap();
        engine.state.units.get_mut(&1).unwrap().alive = false;
        engine.state.units.get_mut(&1).unwrap().hp = 0;

        assert!(
            engine
                .legal_actions_for_unit(1)
                .unwrap()
                .commands
                .is_empty()
        );
        engine.finish_turn(Side::Player);

        assert_eq!(
            engine.state.teams[Side::Player.index()].action_order,
            vec![1]
        );
    }

    #[test]
    fn legal_actions_expose_every_unlocked_affordable_burst_stage() {
        let mut owned = (*catalog()).clone();
        let base = owned.costumes["hero_skill"].variants[0].clone();
        for burst_level in 1..=3 {
            let mut variant = base.clone();
            variant.burst_level = burst_level;
            variant.sp_cost = 2 + i32::from(burst_level);
            owned
                .costumes
                .get_mut("hero_skill")
                .unwrap()
                .variants
                .push(variant);
        }
        let mut burst_setup = setup(BattleMode::Normal);
        burst_setup.units[0].costume_loadout[0].burst_level = 3;
        let mut engine = BattleEngine::new(Arc::new(owned), burst_setup, 1).unwrap();

        let levels = |engine: &BattleEngine| {
            engine
                .legal_actions_for_unit(1)
                .unwrap()
                .commands
                .into_iter()
                .filter_map(|command| match command {
                    UnitCommand::UseCostume { burst_level, .. } => Some(burst_level),
                    _ => None,
                })
                .collect::<Vec<_>>()
        };
        assert_eq!(levels(&engine), vec![0, 1, 2, 3]);

        engine.state.teams[Side::Player.index()].sp = 4;
        assert_eq!(levels(&engine), vec![0, 1, 2]);
    }

    #[test]
    fn per_hit_sp_uses_successful_hits_not_nominal_hit_count() {
        let mut owned = (*catalog()).clone();
        owned.costumes.get_mut("hero_skill").unwrap().variants[0]
            .operations
            .push(SkillOperation::ChangeSpPerSuccessfulHit {
                amount: 1,
                side: EffectRecipient::ActorSide,
            });
        let mut engine = BattleEngine::new(Arc::new(owned), setup(BattleMode::Normal), 1).unwrap();
        let mut evasion = effect_spec("evade");
        evasion.modifiers.evasion_bp = 10_000;
        evasion.tags.insert("EVASION".into());
        evasion.charges = Some(1);
        evasion.duration_clock = DurationClock::Permanent;
        engine.apply_effect(2, 2, evasion);
        let plan = TeamTurnPlan {
            side: Side::Player,
            order: vec![1],
            commands: BTreeMap::from([(
                1,
                UnitCommand::UseCostume {
                    costume_id: "hero_skill".into(),
                    burst_level: 0,
                    explicit_target: None,
                },
            )]),
            formation: BTreeMap::new(),
        };
        engine.step(plan).unwrap();
        assert_eq!(engine.state.teams[Side::Player.index()].sp, 14);
    }

    #[test]
    fn monster_parts_share_current_level_hp_and_carry_to_next_level() {
        let mut owned = (*catalog()).clone();
        owned.monsters.insert(
            "boss".into(),
            MonsterDefinition {
                id: "boss".into(),
                names: BTreeMap::new(),
                element: Element::Wind,
                stats_by_level: BTreeMap::from([(1, stats(100, 10)), (2, stats(200, 20))]),
                parts: Vec::new(),
                skill_ids: Vec::new(),
                immunities: BTreeSet::new(),
                source: SourceRecord::default(),
            },
        );
        let mut monster_setup = setup(BattleMode::MonsterChaser);
        monster_setup.units[1].stat_overrides = Some(stats(100, 10));
        monster_setup.units[1].can_act = false;
        monster_setup.units.push(UnitSetup {
            unit_id: 3,
            character_id: "enemy".into(),
            side: Side::Enemy,
            position: Cell { row: 1, depth: 0 },
            costume_loadout: vec![],
            build_settings: UnitBuildSettings::unmodified(),
            stat_overrides: Some(stats(100, 10)),
            equipment: BTreeMap::new(),
            ai_priority: vec![],
            party_no: 1,
            hp_owner: Some(2),
            weak_point_bonus_bp: 10_000,
            can_act: false,
        });
        monster_setup.monster_chaser = Some(MonsterChaserSetup {
            monster_id: "boss".into(),
            cumulative_hp_by_level: vec![100, 200],
            selected_level: 2,
            party_limit: 1,
            turn_sp_recovery: 5,
        });
        let mut engine = BattleEngine::new(Arc::new(owned), monster_setup, 1).unwrap();
        engine
            .deal_damage(
                1,
                3,
                DamageKind::Physical,
                5_000,
                None,
                false,
                false,
                1,
                1,
                0,
            )
            .unwrap();
        let progress = engine.state.monster_chaser.as_ref().unwrap();
        assert_eq!(
            (progress.current_level, progress.segment_hp_remaining),
            (2, 50)
        );
        assert_eq!(progress.battle_hp_remaining, 50);
        assert_eq!(engine.state.units[&2].base_stats.max_hp, 200);
        assert_eq!(engine.state.units[&2].hp, 50);
        assert_eq!(engine.state.units[&3].hp, 50);
        let ratios: Vec<_> = engine
            .observation()
            .units
            .into_iter()
            .filter(|unit| unit.side == Side::Enemy)
            .map(|unit| unit.hp_ratio)
            .collect();
        assert!(
            ratios
                .into_iter()
                .all(|ratio| (ratio - 0.25).abs() < f32::EPSILON)
        );
        engine.apply_raw_damage(1, 3, 1_000, false, 1);
        assert_eq!(
            engine
                .state
                .monster_chaser
                .as_ref()
                .unwrap()
                .battle_hp_remaining,
            0
        );
        assert!(!engine.state.units[&2].alive);
        assert!(!engine.state.units[&3].alive);
    }
}
