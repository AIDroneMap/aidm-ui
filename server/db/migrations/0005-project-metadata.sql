ALTER TABLE projects ADD COLUMN notes TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
UPDATE projects SET updated_at = created_at;
ALTER TABLE projects ADD COLUMN photo_count INTEGER NOT NULL DEFAULT 0 CHECK (photo_count >= 0);
