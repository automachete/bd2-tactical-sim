use std::{collections::BTreeMap, path::Path};

use bd2_core::{BattleSetup, Catalog, CostumeDefinition};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum DataError {
    #[error("database error: {0}")]
    Sql(#[from] rusqlite::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("catalog '{0}' does not exist")]
    MissingCatalog(String),
    #[error("scenario '{0}' does not exist")]
    MissingScenario(String),
}

pub type Result<T> = std::result::Result<T, DataError>;

pub struct Database {
    connection: Connection,
}

impl Database {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let connection = Connection::open(path)?;
        let mut database = Self { connection };
        database.migrate()?;
        Ok(database)
    }

    pub fn open_in_memory() -> Result<Self> {
        let connection = Connection::open_in_memory()?;
        let mut database = Self { connection };
        database.migrate()?;
        Ok(database)
    }

    pub fn migrate(&mut self) -> Result<()> {
        self.connection
            .execute_batch(include_str!("../migrations/001_init.sql"))?;
        Ok(())
    }

    /// Atomically replaces one current catalog snapshot.
    pub fn replace_catalog(&mut self, catalog: &Catalog, activate: bool) -> Result<()> {
        let transaction = self.connection.transaction()?;
        transaction.execute(
            "DELETE FROM catalog_versions WHERE ruleset_id = ?1",
            [&catalog.ruleset_id],
        )?;
        if activate {
            transaction.execute("UPDATE catalog_versions SET active = 0", [])?;
        }
        transaction.execute(
            "INSERT INTO catalog_versions(ruleset_id, active) VALUES (?1, ?2)",
            params![catalog.ruleset_id, i32::from(activate)],
        )?;

        for character in catalog.characters.values() {
            transaction.execute(
                "INSERT INTO characters(ruleset_id, character_id, rarity, element, attack_type, record_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![catalog.ruleset_id, character.id, character.rarity, format!("{:?}", character.element), format!("{:?}", character.attack_type), serde_json::to_string(character)?],
            )?;
            insert_source(&transaction, &catalog.ruleset_id, &character.source)?;
        }
        for costume in catalog.costumes.values() {
            transaction.execute(
                "INSERT INTO costumes(ruleset_id, costume_id, character_id, record_json) VALUES (?1, ?2, ?3, ?4)",
                params![catalog.ruleset_id, costume.id, costume.character_id, serde_json::to_string(costume)?],
            )?;
            for variant in &costume.variants {
                transaction.execute(
                    "INSERT INTO skill_variants(ruleset_id, costume_id, enhancement, burst_level, potential_mask, sp_cost, cooldown, program_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    params![catalog.ruleset_id, costume.id, variant.enhancement, variant.burst_level, variant.potential_mask, variant.sp_cost, variant.cooldown, serde_json::to_string(variant)?],
                )?;
            }
            insert_source(&transaction, &catalog.ruleset_id, &costume.source)?;
        }
        for monster in catalog.monsters.values() {
            transaction.execute(
                "INSERT INTO monsters(ruleset_id, monster_id, record_json) VALUES (?1, ?2, ?3)",
                params![
                    catalog.ruleset_id,
                    monster.id,
                    serde_json::to_string(monster)?
                ],
            )?;
            insert_source(&transaction, &catalog.ruleset_id, &monster.source)?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn active_ruleset_id(&self) -> Result<String> {
        self.connection
            .query_row(
                "SELECT ruleset_id FROM catalog_versions WHERE active = 1 LIMIT 1",
                [],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| DataError::MissingCatalog("active".into()))
    }

    pub fn load_active_catalog(&self) -> Result<Catalog> {
        let id = self.active_ruleset_id()?;
        self.load_catalog(&id)
    }

    pub fn load_catalog(&self, ruleset_id: &str) -> Result<Catalog> {
        let exists = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM catalog_versions WHERE ruleset_id = ?1)",
            [ruleset_id],
            |row| row.get::<_, bool>(0),
        )?;
        if !exists {
            return Err(DataError::MissingCatalog(ruleset_id.into()));
        }
        let characters = load_json_map(&self.connection, "characters", "character_id", ruleset_id)?;
        let mut costumes: BTreeMap<String, CostumeDefinition> =
            load_json_map(&self.connection, "costumes", "costume_id", ruleset_id)?;
        for costume in costumes.values_mut() {
            let mut statement = self.connection.prepare("SELECT program_json FROM skill_variants WHERE ruleset_id = ?1 AND costume_id = ?2 ORDER BY enhancement, burst_level, potential_mask")?;
            costume.variants = statement
                .query_map(params![ruleset_id, costume.id], |row| {
                    row.get::<_, String>(0)
                })?
                .map(|result| Ok(serde_json::from_str(&result?)?))
                .collect::<Result<Vec<_>>>()?;
        }
        let monsters = load_json_map(&self.connection, "monsters", "monster_id", ruleset_id)?;
        Ok(Catalog {
            ruleset_id: ruleset_id.into(),
            characters,
            costumes,
            monsters,
            skills: BTreeMap::new(),
        })
    }

    pub fn put_scenario(&self, ruleset_id: &str, setup: &BattleSetup) -> Result<()> {
        self.connection.execute(
            "INSERT INTO scenarios(ruleset_id, scenario_id, mode, setup_json) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(ruleset_id, scenario_id) DO UPDATE SET mode=excluded.mode, setup_json=excluded.setup_json",
            params![ruleset_id, setup.scenario_id, format!("{:?}", setup.rules.mode), serde_json::to_string(setup)?],
        )?;
        Ok(())
    }

    pub fn load_scenario(&self, ruleset_id: &str, scenario_id: &str) -> Result<BattleSetup> {
        let json: String = self
            .connection
            .query_row(
                "SELECT setup_json FROM scenarios WHERE ruleset_id = ?1 AND scenario_id = ?2",
                params![ruleset_id, scenario_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| DataError::MissingScenario(scenario_id.into()))?;
        Ok(serde_json::from_str(&json)?)
    }

    pub fn counts(&self, ruleset_id: &str) -> Result<CatalogCounts> {
        Ok(CatalogCounts {
            characters: count(&self.connection, "characters", ruleset_id)?,
            costumes: count(&self.connection, "costumes", ruleset_id)?,
            skill_variants: count(&self.connection, "skill_variants", ruleset_id)?,
            monsters: count(&self.connection, "monsters", ruleset_id)?,
            scenarios: count(&self.connection, "scenarios", ruleset_id)?,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CatalogCounts {
    pub characters: u64,
    pub costumes: u64,
    pub skill_variants: u64,
    pub monsters: u64,
    pub scenarios: u64,
}

fn insert_source(
    transaction: &Transaction<'_>,
    ruleset_id: &str,
    source: &bd2_core::SourceRecord,
) -> Result<()> {
    if source.source_id.is_empty() {
        return Ok(());
    }
    transaction.execute(
        "INSERT OR IGNORE INTO source_snapshots(ruleset_id, source_id, source_url, observed_at, source_digest, raw_payload_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![ruleset_id, source.source_id, source.source_url, source.observed_at, source.source_digest, serde_json::to_string(&source.raw_payload)?],
    )?;
    Ok(())
}

fn load_json_map<T: serde::de::DeserializeOwned>(
    connection: &Connection,
    table: &str,
    id_column: &str,
    ruleset_id: &str,
) -> Result<BTreeMap<String, T>> {
    let sql = format!(
        "SELECT {id_column}, record_json FROM {table} WHERE ruleset_id = ?1 ORDER BY {id_column}"
    );
    let mut statement = connection.prepare(&sql)?;
    statement
        .query_map([ruleset_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .map(|result| {
            let (id, json) = result?;
            Ok((id, serde_json::from_str(&json)?))
        })
        .collect()
}

fn count(connection: &Connection, table: &str, ruleset_id: &str) -> Result<u64> {
    let sql = format!("SELECT COUNT(*) FROM {table} WHERE ruleset_id = ?1");
    let value: i64 = connection.query_row(&sql, [ruleset_id], |row| row.get(0))?;
    Ok(value as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use bd2_core::{
        AttackType, CharacterDefinition, CostumeDefinition, Element, Offset, SkillVariant,
        SourceRecord, Stats, TargetSelector,
    };
    use std::collections::BTreeMap;

    fn catalog() -> Catalog {
        let character = CharacterDefinition {
            id: "c".into(),
            names: BTreeMap::from([("ko".into(), "테스트".into())]),
            rarity: 5,
            element: Element::Fire,
            attack_type: AttackType::Physical,
            target_selector: TargetSelector::Front,
            level_100_awakened: Stats {
                max_hp: 1,
                attack: 1,
                magic: 0,
                crit_rate_bp: 0,
                crit_damage_bp: 0,
                defense_bp: 0,
                magic_resist_bp: 0,
                property_damage_bp: 0,
                outgoing_damage_bp: 0,
                incoming_damage_bp: 0,
                amplification_bp: 0,
            },
            costume_ids: vec!["c0".into()],
            source: SourceRecord::default(),
        };
        let variant = |potential_mask| SkillVariant {
            enhancement: 5,
            burst_level: 3,
            potential_mask,
            sp_cost: 2,
            cooldown: 1,
            selector: TargetSelector::Front,
            fixed_target_cell: None,
            target_all: false,
            range_override: None,
            operations: vec![],
            consume_remaining_sp: false,
            executable: true,
            compile_diagnostics: vec![],
            preemptive: false,
            activation_condition: None,
            max_uses_per_party: None,
            ai_sequence_index: None,
        };
        let costume = CostumeDefinition {
            id: "c0".into(),
            character_id: "c".into(),
            names: BTreeMap::from([("ko".into(), "테스트 스킬".into())]),
            range: vec![Offset { row: 0, depth: 0 }],
            variants: vec![variant(0), variant(7)],
            permanent_potential_modifiers: Default::default(),
            bonding_modifiers: Default::default(),
            executable: true,
            compile_diagnostics: vec![],
            source: SourceRecord::default(),
        };
        Catalog {
            ruleset_id: "current-test".into(),
            characters: BTreeMap::from([("c".into(), character)]),
            costumes: BTreeMap::from([("c0".into(), costume)]),
            ..Catalog::default()
        }
    }

    #[test]
    fn catalog_round_trip_is_lossless() {
        let mut db = Database::open_in_memory().unwrap();
        let expected = catalog();
        db.replace_catalog(&expected, true).unwrap();
        assert_eq!(db.load_active_catalog().unwrap(), expected);
        assert_eq!(db.counts("current-test").unwrap().characters, 1);
        assert_eq!(db.counts("current-test").unwrap().skill_variants, 2);
    }
}
