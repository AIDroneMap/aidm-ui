CREATE TABLE engines (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('local', 'remote')),
  package_kind TEXT CHECK (package_kind IN ('native', 'container')),
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  token TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  installed_version TEXT,
  last_state TEXT NOT NULL
) STRICT;
