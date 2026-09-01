PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS equipment (
    ruleset_id TEXT NOT NULL REFERENCES catalog_versions(ruleset_id) ON DELETE CASCADE,
    equipment_id TEXT NOT NULL,
    slot TEXT NOT NULL,
    kind TEXT NOT NULL,
    tier TEXT NOT NULL,
    owner_character_id TEXT,
    record_json TEXT NOT NULL,
    PRIMARY KEY (ruleset_id, equipment_id)
);

CREATE INDEX IF NOT EXISTS idx_equipment_slot
ON equipment(ruleset_id, slot);

INSERT OR IGNORE INTO schema_migrations(version) VALUES (2);
