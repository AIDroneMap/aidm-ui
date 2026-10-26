CREATE TABLE projects (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  -- 'sample' for the built-in sample project, null for the operator's own (later specs)
  builtin TEXT UNIQUE,
  created_at TEXT NOT NULL
) STRICT;
INSERT INTO projects (name, builtin, created_at) VALUES ('Sample project', 'sample', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
CREATE TABLE runs (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  engine_id INTEGER REFERENCES engines(id) ON DELETE SET NULL,
  task_uuid TEXT,
  options TEXT NOT NULL,          -- JSON [{ "name": ..., "value": ... }] as sent to the engine
  state TEXT NOT NULL,
  progress REAL,
  engine_message TEXT,
  problem TEXT,                   -- JSON ApiError or null
  restarted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
