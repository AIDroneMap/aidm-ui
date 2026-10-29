CREATE TABLE project_photo_metadata (
  project_id INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  reader_kind TEXT NOT NULL,
  facts TEXT NOT NULL,
  PRIMARY KEY (project_id, sha256),
  FOREIGN KEY (project_id, sha256) REFERENCES project_upload_files(project_id, sha256) ON DELETE CASCADE
) STRICT;
CREATE TABLE project_photo_exclusions (
  project_id INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  PRIMARY KEY (project_id, sha256),
  FOREIGN KEY (project_id, sha256) REFERENCES project_upload_files(project_id, sha256) ON DELETE CASCADE
) STRICT;
