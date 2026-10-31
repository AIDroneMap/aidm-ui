CREATE TABLE operator_presets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 200),
  engine_version TEXT,
  options TEXT NOT NULL CHECK (json_valid(options) AND json_type(options) = 'array')
) STRICT;

ALTER TABLE runs ADD COLUMN preset_name TEXT;
