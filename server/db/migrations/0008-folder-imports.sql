CREATE TABLE project_imports (
  project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  generation TEXT NOT NULL,
  accepted_count INTEGER NOT NULL,
  skipped_count INTEGER NOT NULL,
  ground_control_count INTEGER NOT NULL
) STRICT;
CREATE TABLE project_import_entries (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  generation TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  size INTEGER NOT NULL,
  signature TEXT NOT NULL,
  sha256 TEXT,
  PRIMARY KEY (project_id, generation, name)
) STRICT;
CREATE INDEX project_import_content ON project_import_entries(project_id, generation, sha256);
CREATE TABLE project_import_facts (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sha256 TEXT NOT NULL,
  reader_kind TEXT,
  facts TEXT,
  excluded INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, sha256)
) STRICT;
