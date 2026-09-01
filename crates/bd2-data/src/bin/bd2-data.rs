use std::{env, fs, process::ExitCode};

use bd2_core::{BattleSetup, Catalog};
use bd2_data::Database;

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("error: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("import-catalog") if args.len() == 4 => {
            let catalog: Catalog = serde_json::from_str(&fs::read_to_string(&args[2])?)?;
            let mut database = Database::open(&args[3])?;
            database.replace_catalog(&catalog, true)?;
            let counts = database.counts(&catalog.ruleset_id)?;
            println!(
                "ruleset={} characters={} costumes={} variants={} monsters={} equipment={}",
                catalog.ruleset_id,
                counts.characters,
                counts.costumes,
                counts.skill_variants,
                counts.monsters,
                counts.equipment
            );
        }
        Some("import-scenario") if args.len() == 4 => {
            let setup: BattleSetup = serde_json::from_str(&fs::read_to_string(&args[2])?)?;
            let database = Database::open(&args[3])?;
            let ruleset = database.active_ruleset_id()?;
            database.put_scenario(&ruleset, &setup)?;
            println!("ruleset={ruleset} scenario={}", setup.scenario_id);
        }
        Some("inspect") if args.len() == 3 => {
            let database = Database::open(&args[2])?;
            let ruleset = database.active_ruleset_id()?;
            let counts = database.counts(&ruleset)?;
            println!(
                "ruleset={ruleset} characters={} costumes={} variants={} monsters={} equipment={} scenarios={}",
                counts.characters,
                counts.costumes,
                counts.skill_variants,
                counts.monsters,
                counts.equipment,
                counts.scenarios
            );
        }
        _ => {
            eprintln!(
                "usage:\n  bd2-data import-catalog <catalog.json> <database.sqlite>\n  bd2-data import-scenario <scenario.json> <database.sqlite>\n  bd2-data inspect <database.sqlite>"
            );
            return Ok(());
        }
    }
    Ok(())
}
