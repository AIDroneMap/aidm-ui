CREATE TABLE project_uploads (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  chunk_size INTEGER NOT NULL,
  complete INTEGER NOT NULL DEFAULT 0,
  UNIQUE (project_id, name, size, sha256)
) STRICT;
CREATE TABLE project_upload_files (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  storage_id TEXT NOT NULL,
  PRIMARY KEY (project_id, sha256)
) STRICT;
CREATE TABLE project_upload_aliases (
  project_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('photo', 'mask', 'video')),
  PRIMARY KEY (project_id, name, sha256),
  FOREIGN KEY (project_id, sha256) REFERENCES project_upload_files(project_id, sha256) ON DELETE CASCADE
) STRICT;
CREATE TABLE project_upload_chunks (
  upload_id TEXT NOT NULL REFERENCES project_uploads(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  PRIMARY KEY (upload_id, chunk_index)
) STRICT;
