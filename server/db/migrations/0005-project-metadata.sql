ALTER TABLE projects ADD COLUMN notes TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
UPDATE projects SET updated_at = created_at;
ALTER TABLE projects ADD COLUMN photo_count INTEGER NOT NULL DEFAULT 0 CHECK (photo_count >= 0);

-- Reserve existing run IDs before project deletion can remove their rows.
INSERT INTO settings (key, value)
VALUES ('runs.lastId', CAST((SELECT COALESCE(MAX(id), 0) FROM runs) AS TEXT))
ON CONFLICT (key) DO UPDATE SET value = CAST(MAX(CAST(settings.value AS INTEGER), CAST(excluded.value AS INTEGER)) AS TEXT);
