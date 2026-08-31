PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS catalog_versions (
    ruleset_id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    source_manifest_json TEXT NOT NULL DEFAULT '{}',
    active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1))
);

CREATE TABLE IF NOT EXISTS source_snapshots (
    ruleset_id TEXT NOT NULL REFERENCES catalog_versions(ruleset_id) ON DELETE CASCADE,
    source_id TEXT NOT NULL,
    source_url TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    source_digest TEXT NOT NULL,
    raw_payload_json TEXT NOT NULL,
    PRIMARY KEY (ruleset_id, source_id, source_digest)
);

CREATE TABLE IF NOT EXISTS characters (
    ruleset_id TEXT NOT NULL REFERENCES catalog_versions(ruleset_id) ON DELETE CASCADE,
    character_id TEXT NOT NULL,
    rarity INTEGER NOT NULL,
    element TEXT NOT NULL,
    attack_type TEXT NOT NULL,
    record_json TEXT NOT NULL,
    PRIMARY KEY (ruleset_id, character_id)
);

CREATE INDEX IF NOT EXISTS idx_characters_rarity
ON characters(ruleset_id, rarity);

CREATE TABLE IF NOT EXISTS costumes (
    ruleset_id TEXT NOT NULL REFERENCES catalog_versions(ruleset_id) ON DELETE CASCADE,
    costume_id TEXT NOT NULL,
    character_id TEXT NOT NULL,
    record_json TEXT NOT NULL,
    PRIMARY KEY (ruleset_id, costume_id),
    FOREIGN KEY (ruleset_id, character_id)
        REFERENCES characters(ruleset_id, character_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_costumes_character
ON costumes(ruleset_id, character_id);

CREATE TABLE IF NOT EXISTS skill_variants (
    ruleset_id TEXT NOT NULL,
    costume_id TEXT NOT NULL,
    enhancement INTEGER NOT NULL,
    burst_level INTEGER NOT NULL,
    potential_mask INTEGER NOT NULL,
    sp_cost INTEGER NOT NULL,
    cooldown INTEGER NOT NULL,
    program_json TEXT NOT NULL,
    PRIMARY KEY (ruleset_id, costume_id, enhancement, burst_level, potential_mask),
    FOREIGN KEY (ruleset_id, costume_id)
        REFERENCES costumes(ruleset_id, costume_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS monsters (
    ruleset_id TEXT NOT NULL REFERENCES catalog_versions(ruleset_id) ON DELETE CASCADE,
    monster_id TEXT NOT NULL,
    record_json TEXT NOT NULL,
    PRIMARY KEY (ruleset_id, monster_id)
);

CREATE TABLE IF NOT EXISTS scenarios (
    ruleset_id TEXT NOT NULL REFERENCES catalog_versions(ruleset_id) ON DELETE CASCADE,
    scenario_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    setup_json TEXT NOT NULL,
    PRIMARY KEY (ruleset_id, scenario_id)
);

INSERT OR IGNORE INTO schema_migrations(version) VALUES (1);
