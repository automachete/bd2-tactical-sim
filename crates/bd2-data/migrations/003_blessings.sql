PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS blessings (
    ruleset_id TEXT NOT NULL REFERENCES catalog_versions(ruleset_id) ON DELETE CASCADE,
    blessing_id TEXT NOT NULL,
    category TEXT NOT NULL,
    record_json TEXT NOT NULL,
    PRIMARY KEY (ruleset_id, blessing_id)
);

CREATE INDEX IF NOT EXISTS idx_blessings_category
ON blessings(ruleset_id, category);

INSERT OR IGNORE INTO schema_migrations(version) VALUES (3);
