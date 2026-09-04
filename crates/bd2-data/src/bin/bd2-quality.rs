use std::{
    collections::{BTreeMap, BTreeSet},
    env, fs,
    path::{Path, PathBuf},
    process::ExitCode,
    sync::Arc,
    time::Instant,
};

use bd2_core::{
    BattleEngine, BattleEventKind, BattleMode, BattleSetup, BattleState, Catalog, Cell,
    CostumeLoadout, EffectSpec, ModeRules, Side, SkillOperation, Stats, TeamTurnPlan,
    UnitBuildSettings, UnitCommand, UnitSetup,
};
use rayon::prelude::*;
use serde::Serialize;

const DEFAULT_SCENARIOS: [&str; 4] = [
    "data/scenarios/normal-demo.json",
    "data/scenarios/mirror-war-demo.json",
    "data/scenarios/monster-chaser-current.json",
    "data/scenarios/golden-colosseum-reference.json",
];

#[derive(Debug)]
struct Config {
    catalog: PathBuf,
    scenarios: Vec<PathBuf>,
    episodes_per_round: usize,
    rounds: usize,
    max_steps: usize,
    seed: u64,
    execute_variants: bool,
    output: Option<PathBuf>,
}

#[derive(Debug, Default, Serialize)]
struct RoundReport {
    round: usize,
    seed: u64,
    episodes: usize,
    transitions: u64,
    state_invariant_checks: u64,
    snapshot_replay_checks: u64,
    rejected_plan_atomicity_checks: u64,
    terminal_episodes: usize,
    modes: BTreeMap<String, usize>,
    elapsed_seconds: f64,
    failures: Vec<String>,
}

#[derive(Debug, Serialize)]
struct VariantReport {
    catalog_variants: usize,
    executed_variants: usize,
    preemptive_variants: usize,
    action_variants: usize,
    source_records: usize,
    operation_instances: usize,
    operation_kinds: BTreeMap<&'static str, usize>,
    elapsed_seconds: f64,
    failures: Vec<String>,
}

#[derive(Debug, Serialize)]
struct QualityReport {
    schema: &'static str,
    catalog_ruleset: String,
    scenario_ids: Vec<String>,
    variant_execution: Option<VariantReport>,
    rounds: Vec<RoundReport>,
    totals: Totals,
    status: &'static str,
}

#[derive(Debug, Default, Serialize)]
struct Totals {
    episodes: usize,
    transitions: u64,
    state_invariant_checks: u64,
    snapshot_replay_checks: u64,
    rejected_plan_atomicity_checks: u64,
    terminal_episodes: usize,
    failures: usize,
}

#[derive(Debug, Default)]
struct EpisodeReport {
    transitions: u64,
    state_invariant_checks: u64,
    snapshot_replay_checks: u64,
    rejected_plan_atomicity_checks: u64,
    terminal: bool,
    failure: Option<String>,
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("quality verification failed: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let config = parse_args()?;
    let catalog: Catalog = read_json(&config.catalog)?;
    bd2_core::validate_catalog(&catalog).map_err(|error| error.to_string())?;
    let catalog = Arc::new(catalog);
    let scenarios: Vec<BattleSetup> = config
        .scenarios
        .iter()
        .map(|path| read_json(path))
        .collect::<Result<_, _>>()?;
    if scenarios.is_empty() {
        return Err("at least one scenario is required".into());
    }

    let variant_execution = config
        .execute_variants
        .then(|| execute_every_variant(Arc::clone(&catalog)))
        .transpose()?;

    let mut round_reports = Vec::with_capacity(config.rounds);
    for round in 0..config.rounds {
        let round_seed = splitmix64(
            config
                .seed
                .wrapping_add((round as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15)),
        );
        let started = Instant::now();
        let episodes: Vec<_> = (0..config.episodes_per_round)
            .into_par_iter()
            .map(|episode| {
                let scenario = &scenarios[episode % scenarios.len()];
                let seed = splitmix64(round_seed ^ episode as u64);
                run_episode(Arc::clone(&catalog), scenario, seed, config.max_steps)
            })
            .collect();

        let mut report = RoundReport {
            round: round + 1,
            seed: round_seed,
            episodes: episodes.len(),
            elapsed_seconds: started.elapsed().as_secs_f64(),
            ..RoundReport::default()
        };
        for (index, episode) in episodes.into_iter().enumerate() {
            report.transitions += episode.transitions;
            report.state_invariant_checks += episode.state_invariant_checks;
            report.snapshot_replay_checks += episode.snapshot_replay_checks;
            report.rejected_plan_atomicity_checks += episode.rejected_plan_atomicity_checks;
            report.terminal_episodes += usize::from(episode.terminal);
            let mode = mode_name(scenarios[index % scenarios.len()].rules.mode);
            *report.modes.entry(mode.into()).or_default() += 1;
            if let Some(failure) = episode.failure {
                report.failures.push(format!(
                    "episode={index} scenario={} seed={} {failure}",
                    scenarios[index % scenarios.len()].scenario_id,
                    splitmix64(round_seed ^ index as u64)
                ));
            }
        }
        round_reports.push(report);
    }

    let totals = round_reports
        .iter()
        .fold(Totals::default(), |mut total, round| {
            total.episodes += round.episodes;
            total.transitions += round.transitions;
            total.state_invariant_checks += round.state_invariant_checks;
            total.snapshot_replay_checks += round.snapshot_replay_checks;
            total.rejected_plan_atomicity_checks += round.rejected_plan_atomicity_checks;
            total.terminal_episodes += round.terminal_episodes;
            total.failures += round.failures.len();
            total
        });
    let variant_failures = variant_execution
        .as_ref()
        .map_or(0, |report| report.failures.len());
    let passed = totals.failures == 0 && variant_failures == 0;
    let report = QualityReport {
        schema: "bd2-convergence-quality-v1",
        catalog_ruleset: catalog.ruleset_id.clone(),
        scenario_ids: scenarios
            .iter()
            .map(|scenario| scenario.scenario_id.clone())
            .collect(),
        variant_execution,
        rounds: round_reports,
        totals,
        status: if passed { "ok" } else { "failed" },
    };
    let json = serde_json::to_string_pretty(&report).map_err(|error| error.to_string())?;
    println!("{json}");
    if let Some(output) = config.output {
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::write(output, format!("{json}\n")).map_err(|error| error.to_string())?;
    }
    if passed {
        Ok(())
    } else {
        Err(format!(
            "{} stateful failures and {variant_failures} variant failures",
            report.totals.failures
        ))
    }
}

fn parse_args() -> Result<Config, String> {
    let mut config = Config {
        catalog: PathBuf::from("data/generated/catalog.json"),
        scenarios: Vec::new(),
        episodes_per_round: 1_000,
        rounds: 1,
        max_steps: 128,
        seed: 0x00bd_2002,
        execute_variants: true,
        output: None,
    };
    let args: Vec<String> = env::args().skip(1).collect();
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--catalog" => config.catalog = value(&args, &mut index)?.into(),
            "--scenario" => config.scenarios.push(value(&args, &mut index)?.into()),
            "--episodes" => config.episodes_per_round = number(&args, &mut index, "episodes")?,
            "--rounds" => config.rounds = number(&args, &mut index, "rounds")?,
            "--max-steps" => config.max_steps = number(&args, &mut index, "max-steps")?,
            "--seed" => config.seed = number(&args, &mut index, "seed")?,
            "--skip-variants" => config.execute_variants = false,
            "--output" => config.output = Some(value(&args, &mut index)?.into()),
            "--help" | "-h" => {
                return Err("usage: bd2-quality [--catalog PATH] [--scenario PATH] [--episodes N] [--rounds N] [--max-steps N] [--seed N] [--skip-variants] [--output PATH]".into());
            }
            unknown => return Err(format!("unknown argument '{unknown}'")),
        }
        index += 1;
    }
    if config.scenarios.is_empty() {
        config.scenarios = DEFAULT_SCENARIOS.into_iter().map(PathBuf::from).collect();
    }
    if config.episodes_per_round == 0 || config.rounds == 0 || config.max_steps == 0 {
        return Err("episodes, rounds, and max-steps must be positive".into());
    }
    Ok(config)
}

fn value(args: &[String], index: &mut usize) -> Result<String, String> {
    *index += 1;
    args.get(*index)
        .cloned()
        .ok_or_else(|| "missing argument value".into())
}

fn number<T: std::str::FromStr>(
    args: &[String],
    index: &mut usize,
    name: &str,
) -> Result<T, String> {
    value(args, index)?
        .parse()
        .map_err(|_| format!("--{name} requires a number"))
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, String> {
    let source =
        fs::read_to_string(path).map_err(|error| format!("{}: {error}", path.display()))?;
    serde_json::from_str(&source).map_err(|error| format!("{}: {error}", path.display()))
}

fn run_episode(
    catalog: Arc<Catalog>,
    setup: &BattleSetup,
    seed: u64,
    max_steps: usize,
) -> EpisodeReport {
    let mut report = EpisodeReport::default();
    let mut engine = match BattleEngine::new(Arc::clone(&catalog), setup.clone(), seed) {
        Ok(engine) => engine,
        Err(error) => {
            report.failure = Some(format!("initialization failed: {error}"));
            return report;
        }
    };
    let mut choice_rng = ChoiceRng::new(seed ^ 0xa076_1d64_78bd_642f);
    for step in 0..max_steps {
        if let Err(error) = independent_state_oracle(engine.state()) {
            report.failure = Some(format!("step={step} invariant: {error}"));
            return report;
        }
        report.state_invariant_checks += 1;
        if engine.state().terminal.is_some() {
            report.terminal = true;
            return report;
        }

        let snapshot = engine.snapshot();
        let snapshot_bytes = match serde_json::to_vec(&snapshot) {
            Ok(bytes) => bytes,
            Err(error) => {
                report.failure = Some(format!("step={step} snapshot serialization: {error}"));
                return report;
            }
        };
        let decoded: BattleState = match serde_json::from_slice(&snapshot_bytes) {
            Ok(state) => state,
            Err(error) => {
                report.failure = Some(format!("step={step} snapshot decoding: {error}"));
                return report;
            }
        };
        if snapshot != decoded
            || serde_json::to_vec(&decoded).ok().as_deref() != Some(&snapshot_bytes)
        {
            report.failure = Some(format!("step={step} snapshot is not bit-exact"));
            return report;
        }
        let mut restored = match BattleEngine::from_state(Arc::clone(&catalog), decoded) {
            Ok(engine) => engine,
            Err(error) => {
                report.failure = Some(format!("step={step} restore rejected valid state: {error}"));
                return report;
            }
        };

        if step == 0 {
            let before = engine.snapshot();
            let invalid = TeamTurnPlan {
                side: engine.state().active_side.opponent(),
                order: Vec::new(),
                commands: BTreeMap::new(),
                formation: BTreeMap::new(),
            };
            if engine.step(invalid).is_ok() || engine.snapshot() != before {
                report.failure = Some("rejected plan was accepted or mutated state".into());
                return report;
            }
            report.rejected_plan_atomicity_checks += 1;
        }

        let plan = randomized_valid_plan(&engine, &mut choice_rng);
        let first = engine.step(plan.clone());
        let replay = restored.step(plan.clone());
        match (first, replay) {
            (Ok(first), Ok(replay)) => {
                if first != replay || engine.snapshot() != restored.snapshot() {
                    report.failure = Some(format!(
                        "step={step} restored execution diverged from original"
                    ));
                    return report;
                }
            }
            (Err(first), Err(replay)) if first.to_string() == replay.to_string() => {
                let active_effects: Vec<_> = snapshot
                    .units
                    .values()
                    .filter_map(|unit| {
                        let tags: Vec<_> = unit
                            .effects
                            .iter()
                            .map(|effect| {
                                (
                                    effect.spec.effect_id.clone(),
                                    effect.spec.tags.iter().cloned().collect::<Vec<_>>(),
                                    effect.spec.on_hit_received_operations.len(),
                                )
                            })
                            .collect();
                        (!tags.is_empty()).then_some((unit.id, unit.side, tags))
                    })
                    .collect();
                report.failure = Some(format!(
                    "step={step} randomized legal plan was rejected: {first}; plan={plan:?}; active_effects={active_effects:?}"
                ));
                return report;
            }
            (first, replay) => {
                report.failure = Some(format!(
                    "step={step} restore result mismatch: original={first:?} replay={replay:?}"
                ));
                return report;
            }
        }
        report.transitions += 1;
        report.snapshot_replay_checks += 1;
    }
    report.failure = Some(format!(
        "battle did not terminate within {max_steps} transitions"
    ));
    report
}

fn randomized_valid_plan(engine: &BattleEngine, rng: &mut ChoiceRng) -> TeamTurnPlan {
    let side = engine.state().active_side;
    if engine.state().rules.mode == BattleMode::GoldenColosseum {
        return engine.auto_plan(side);
    }
    let mut order = engine.state().teams[side.index()].action_order.clone();
    if order.len() > 1 {
        let shift = rng.index(order.len());
        order.rotate_left(shift);
        if rng.boolean() {
            order.reverse();
        }
    }
    let mut commands = BTreeMap::new();
    let costume_actor = (!order.is_empty()).then(|| order[rng.index(order.len())]);
    for unit_id in &order {
        let legal = engine
            .legal_actions_for_unit(*unit_id)
            .expect("validated state must expose legal actions")
            .commands;
        if legal.is_empty() {
            continue;
        }
        let basic: Vec<_> = legal
            .iter()
            .filter(|command| matches!(command, UnitCommand::NormalAttack | UnitCommand::Knockback))
            .collect();
        let skills: Vec<_> = legal
            .iter()
            .filter(|command| matches!(command, UnitCommand::UseCostume { .. }))
            .collect();
        let selected = if Some(*unit_id) == costume_actor && !skills.is_empty() && rng.boolean() {
            (*skills[rng.index(skills.len())]).clone()
        } else if !basic.is_empty() {
            (*basic[rng.index(basic.len())]).clone()
        } else {
            legal[0].clone()
        };
        commands.insert(*unit_id, selected);
    }
    let mut formation = BTreeMap::new();
    if engine.state().rules.allow_formation_change && order.len() > 1 && rng.index(4) == 0 {
        let cells: Vec<_> = order
            .iter()
            .filter_map(|id| {
                engine
                    .state()
                    .units
                    .get(id)
                    .filter(|unit| unit.alive)
                    .map(|unit| unit.position)
            })
            .collect();
        if cells.len() > 1 {
            for (index, unit_id) in order
                .iter()
                .filter(|id| engine.state().units[id].alive)
                .enumerate()
            {
                formation.insert(*unit_id, cells[(index + 1) % cells.len()]);
            }
        }
    }
    TeamTurnPlan {
        side,
        order,
        commands,
        formation,
    }
}

fn independent_state_oracle(state: &BattleState) -> Result<(), String> {
    if state.teams[0].side != Side::Player || state.teams[1].side != Side::Enemy {
        return Err("team array is not PLAYER, ENEMY".into());
    }
    if state.rules.sp_cap != bd2_core::SP_CAP {
        return Err(format!("unexpected SP cap {}", state.rules.sp_cap));
    }
    for team in &state.teams {
        if !(0..=state.rules.sp_cap).contains(&team.sp) {
            return Err(format!("{:?} SP {} exceeds bounds", team.side, team.sp));
        }
        let mut seen = BTreeSet::new();
        for id in &team.action_order {
            if !seen.insert(*id) {
                return Err(format!("duplicate unit {id} in {:?} order", team.side));
            }
            let unit = state
                .units
                .get(id)
                .ok_or_else(|| format!("order references missing unit {id}"))?;
            if unit.side != team.side || !unit.can_act {
                return Err(format!("unit {id} is in the wrong action order"));
            }
        }
        for (target, chain) in &team.chain_by_target {
            if !state.units.contains_key(target) || *chain == 0 {
                return Err(format!("invalid chain entry target={target} chain={chain}"));
            }
        }
    }
    let mut occupied = BTreeSet::new();
    let mut effects = BTreeSet::new();
    let mut highest_effect = 0;
    for (id, unit) in &state.units {
        if id != &unit.id || unit.hp < 0 || (unit.alive && unit.hp == 0) {
            return Err(format!("unit {id} has inconsistent identity/HP/alive data"));
        }
        if !state.rules.grid.contains(unit.position) {
            return Err(format!("unit {id} is outside the grid"));
        }
        if unit.alive && !occupied.insert((unit.side, unit.position.row, unit.position.depth)) {
            return Err(format!("unit {id} overlaps a living ally"));
        }
        let loadouts: BTreeSet<_> = unit
            .costume_loadout
            .iter()
            .map(|loadout| loadout.costume_id.as_str())
            .collect();
        let cooldowns: BTreeSet<_> = unit.cooldowns.keys().map(String::as_str).collect();
        if loadouts.len() != unit.costume_loadout.len() || loadouts != cooldowns {
            return Err(format!("unit {id} loadout/cooldown keys diverge"));
        }
        for effect in &unit.effects {
            if effect.instance_id == 0 || !effects.insert(effect.instance_id) {
                return Err(format!(
                    "invalid or duplicate effect instance {}",
                    effect.instance_id
                ));
            }
            highest_effect = highest_effect.max(effect.instance_id);
            if effect.remaining == 0 || effect.barrier_remaining < 0 {
                return Err(format!(
                    "effect {} has invalid counters",
                    effect.instance_id
                ));
            }
        }
    }
    if state.next_effect_instance_id <= highest_effect {
        return Err("next effect instance id does not exceed every active id".into());
    }
    if state.event_sequence != state.event_log.len() as u64 {
        return Err(format!(
            "event counter {} differs from log length {}",
            state.event_sequence,
            state.event_log.len()
        ));
    }
    for (index, event) in state.event_log.iter().enumerate() {
        if event.sequence != index as u64 {
            return Err(format!("event sequence gap at index {index}"));
        }
    }
    if state
        .damage_by_source
        .iter()
        .any(|(id, amount)| !state.units.contains_key(id) || *amount < 0)
    {
        return Err("damage ledger contains an unknown source or negative total".into());
    }
    match state.rules.mode {
        BattleMode::MonsterChaser if state.monster_chaser.is_none() => {
            return Err("Monster Chaser state is absent".into());
        }
        BattleMode::GoldenColosseum if state.golden_colosseum.is_none() => {
            return Err("Golden Colosseum state is absent".into());
        }
        BattleMode::Normal | BattleMode::MirrorWar
            if state.monster_chaser.is_some() || state.golden_colosseum.is_some() =>
        {
            return Err("ordinary battle contains mode-specific state".into());
        }
        _ => {}
    }
    if state.terminal.is_some() {
        let ended: Vec<_> = state
            .event_log
            .iter()
            .enumerate()
            .filter(|(_, event)| matches!(event.kind, BattleEventKind::BattleEnded { .. }))
            .collect();
        if ended.len() != 1 {
            return Err(format!(
                "terminal state contains {} BATTLE_ENDED events",
                ended.len()
            ));
        }
        if state.event_log[ended[0].0 + 1..]
            .iter()
            .any(|event| matches!(event.kind, BattleEventKind::ActionStarted { .. }))
        {
            return Err("an action started after BATTLE_ENDED".into());
        }
    }
    Ok(())
}

fn execute_every_variant(catalog: Arc<Catalog>) -> Result<VariantReport, String> {
    let started = Instant::now();
    let tasks: Vec<_> = catalog
        .costumes
        .values()
        .flat_map(|costume| {
            costume.variants.iter().map(|variant| {
                (
                    costume.id.clone(),
                    costume.character_id.clone(),
                    variant.clone(),
                )
            })
        })
        .collect();
    let results: Vec<_> = tasks
        .par_iter()
        .map(|(costume_id, character_id, variant)| {
            execute_variant(Arc::clone(&catalog), costume_id, character_id, variant).map_err(
                |error| {
                    format!(
                        "{costume_id}/+{}/b{}/p{}: {error}",
                        variant.enhancement, variant.burst_level, variant.potential_mask
                    )
                },
            )
        })
        .collect();
    let failures: Vec<_> = results.into_iter().filter_map(Result::err).collect();
    let preemptive_variants = tasks
        .iter()
        .filter(|(_, _, variant)| variant.preemptive)
        .count();
    let source_records = catalog
        .costumes
        .values()
        .map(|costume| costume.source.source_id.as_str())
        .filter(|source_id| !source_id.is_empty())
        .collect::<BTreeSet<_>>()
        .len();
    let mut operation_kinds = BTreeMap::new();
    for (_, _, variant) in &tasks {
        count_operations(&variant.operations, &mut operation_kinds);
    }
    let operation_instances = operation_kinds.values().sum();
    Ok(VariantReport {
        catalog_variants: tasks.len(),
        executed_variants: tasks.len() - failures.len(),
        preemptive_variants,
        action_variants: tasks.len() - preemptive_variants,
        source_records,
        operation_instances,
        operation_kinds,
        elapsed_seconds: started.elapsed().as_secs_f64(),
        failures,
    })
}

fn count_effect_operations(effect: &EffectSpec, counts: &mut BTreeMap<&'static str, usize>) {
    count_operations(&effect.on_hit_received_operations, counts);
    count_operations(&effect.on_turn_end_operations, counts);
    for nested in [
        effect.on_hit_received_allies.as_deref(),
        effect.aura_allies.as_deref(),
        effect.aura_opponents.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        count_effect_operations(nested, counts);
    }
    if let Some(trigger) = effect.on_chain_dealt.as_deref() {
        count_effect_operations(&trigger.stack_effect, counts);
        count_effect_operations(&trigger.threshold_effect, counts);
    }
}

fn count_operations(operations: &[SkillOperation], counts: &mut BTreeMap<&'static str, usize>) {
    for operation in operations {
        let name = match operation {
            SkillOperation::DealDamage { .. } => "DEAL_DAMAGE",
            SkillOperation::Heal { .. } => "HEAL",
            SkillOperation::ConsumeHp { .. } => "CONSUME_HP",
            SkillOperation::ApplyEffect { effect } => {
                count_effect_operations(effect, counts);
                "APPLY_EFFECT"
            }
            SkillOperation::RemoveEffects { .. } => "REMOVE_EFFECTS",
            SkillOperation::RemoveEffectsByTag { .. } => "REMOVE_EFFECTS_BY_TAG",
            SkillOperation::AbsorbEffectsAndApplyStacks { effect, .. } => {
                count_effect_operations(effect, counts);
                "ABSORB_EFFECTS_AND_APPLY_STACKS"
            }
            SkillOperation::ExtendEffects { .. } => "EXTEND_EFFECTS",
            SkillOperation::ChangeCooldown { .. } => "CHANGE_COOLDOWN",
            SkillOperation::ChangeCostumeCooldown { .. } => "CHANGE_COSTUME_COOLDOWN",
            SkillOperation::ChangeSp { .. } => "CHANGE_SP",
            SkillOperation::ChangeSpPerSuccessfulHit { .. } => "CHANGE_SP_PER_SUCCESSFUL_HIT",
            SkillOperation::Knockback { .. } => "KNOCKBACK",
            SkillOperation::Conditional { operations, .. } => {
                count_operations(operations, counts);
                "CONDITIONAL"
            }
            SkillOperation::InstantDeath { .. } => "INSTANT_DEATH",
            SkillOperation::Summon { .. } => "SUMMON",
            SkillOperation::SelfDestruct => "SELF_DESTRUCT",
            SkillOperation::ApplyEffectPerMatchingEnemy { effect, .. } => {
                count_effect_operations(effect, counts);
                "APPLY_EFFECT_PER_MATCHING_ENEMY"
            }
        };
        *counts.entry(name).or_default() += 1;
    }
}

fn execute_variant(
    catalog: Arc<Catalog>,
    costume_id: &str,
    character_id: &str,
    variant: &bd2_core::SkillVariant,
) -> Result<(), String> {
    let stats = Stats {
        max_hp: 1_000_000_000_000,
        attack: 100,
        magic: 100,
        crit_rate_bp: 0,
        crit_damage_bp: 10_000,
        defense_bp: 0,
        magic_resist_bp: 0,
        property_damage_bp: 0,
        outgoing_damage_bp: 0,
        incoming_damage_bp: 0,
        amplification_bp: 0,
    };
    let unit = |unit_id, id: &str, side, position, can_act, loadout| UnitSetup {
        unit_id,
        character_id: id.into(),
        side,
        position,
        costume_loadout: loadout,
        build_settings: UnitBuildSettings::unmodified(),
        stat_overrides: Some(stats.clone()),
        equipment: BTreeMap::new(),
        ai_priority: Vec::new(),
        party_no: 1,
        hp_owner: None,
        weak_point_bonus_bp: 0,
        can_act,
    };
    let fallback = catalog
        .characters
        .values()
        .find(|character| character.rarity == 5 && !character.id.contains(':'))
        .ok_or_else(|| "catalog has no ordinary five-star character".to_string())?
        .id
        .clone();
    let target_position = variant
        .fixed_target_cell
        .unwrap_or(Cell { row: 1, depth: 0 });
    let mut rules = ModeRules::normal();
    rules.initial_sp = [bd2_core::SP_CAP, bd2_core::SP_CAP];
    rules.max_game_turns = 4;
    let setup = BattleSetup {
        scenario_id: format!(
            "quality-{costume_id}-{}-{}-{}",
            variant.enhancement, variant.burst_level, variant.potential_mask
        ),
        rules,
        units: vec![
            unit(
                1,
                character_id,
                Side::Player,
                Cell { row: 1, depth: 0 },
                true,
                vec![CostumeLoadout {
                    costume_id: costume_id.into(),
                    enhancement: variant.enhancement,
                    burst_level: variant.burst_level,
                    potential_mask: variant.potential_mask,
                    permanent_potential_enabled: true,
                    costume_link_target: None,
                }],
            ),
            unit(
                2,
                &fallback,
                Side::Player,
                Cell { row: 0, depth: 0 },
                true,
                Vec::new(),
            ),
            unit(
                101,
                &fallback,
                Side::Enemy,
                target_position,
                false,
                Vec::new(),
            ),
        ],
        monster_chaser: None,
        golden_colosseum: None,
    };
    let mut engine = BattleEngine::new(catalog, setup, 7).map_err(|error| error.to_string())?;
    if variant.preemptive {
        return require_executed(
            engine.state().event_log.iter().map(|event| &event.kind),
            1,
            costume_id,
        );
    }
    let expected = UnitCommand::UseCostume {
        costume_id: costume_id.into(),
        burst_level: variant.burst_level,
        explicit_target: None,
    };
    let legal = engine
        .legal_actions_for_unit(1)
        .map_err(|error| error.to_string())?;
    if !legal.commands.contains(&expected) {
        return Err("exact variant is absent from legal actions".into());
    }
    let transition = engine
        .step(TeamTurnPlan {
            side: Side::Player,
            order: vec![1, 2],
            commands: BTreeMap::from([(1, expected), (2, UnitCommand::NormalAttack)]),
            formation: BTreeMap::new(),
        })
        .map_err(|error| error.to_string())?;
    require_executed(
        transition.events.iter().map(|event| &event.kind),
        1,
        costume_id,
    )
}

fn require_executed<'a>(
    events: impl Iterator<Item = &'a BattleEventKind>,
    actor_id: u32,
    costume_id: &str,
) -> Result<(), String> {
    let mut matching_starts = 0;
    let mut actor_starts = 0;
    let mut skipped = 0;
    let mut ended = 0;
    for event in events {
        match event {
            BattleEventKind::ActionStarted {
                actor_id: actor,
                command: UnitCommand::UseCostume { costume_id: id, .. },
            } if *actor == actor_id && id == costume_id => {
                matching_starts += 1;
                actor_starts += 1;
            }
            BattleEventKind::ActionStarted {
                actor_id: actor, ..
            } if *actor == actor_id => actor_starts += 1,
            BattleEventKind::ActionSkipped {
                actor_id: actor, ..
            } if *actor == actor_id => skipped += 1,
            BattleEventKind::ActionEnded { actor_id: actor } if *actor == actor_id => ended += 1,
            _ => {}
        }
    }
    if matching_starts != 1 {
        Err(format!(
            "expected one matching ACTION_STARTED event, got {matching_starts}"
        ))
    } else if actor_starts != 1 {
        Err(format!(
            "selected action was substituted or executed more than once ({actor_starts} starts)"
        ))
    } else if skipped != 0 {
        Err(format!(
            "selected action emitted {skipped} ACTION_SKIPPED event(s)"
        ))
    } else if ended != 1 {
        Err(format!("expected one ACTION_ENDED event, got {ended}"))
    } else {
        Ok(())
    }
}

fn mode_name(mode: BattleMode) -> &'static str {
    match mode {
        BattleMode::Normal => "NORMAL",
        BattleMode::MirrorWar => "MIRROR_WAR",
        BattleMode::MonsterChaser => "MONSTER_CHASER",
        BattleMode::GoldenColosseum => "GOLDEN_COLOSSEUM",
    }
}

fn splitmix64(mut value: u64) -> u64 {
    value = value.wrapping_add(0x9e37_79b9_7f4a_7c15);
    value = (value ^ (value >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    value = (value ^ (value >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    value ^ (value >> 31)
}

struct ChoiceRng(u64);

impl ChoiceRng {
    fn new(seed: u64) -> Self {
        Self(seed)
    }

    fn next(&mut self) -> u64 {
        self.0 = splitmix64(self.0);
        self.0
    }

    fn index(&mut self, upper: usize) -> usize {
        debug_assert!(upper > 0);
        (self.next() as usize) % upper
    }

    fn boolean(&mut self) -> bool {
        self.next() & 1 == 0
    }
}
