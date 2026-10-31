import type { Database } from "bun:sqlite";
import settingsSql from "./migrations/0001-settings.sql" with { type: "text" };
import enginesSql from "./migrations/0002-engines.sql" with { type: "text" };
import projectsRunsSql from "./migrations/0003-projects-runs.sql" with { type: "text" };
import runRestartLineSql from "./migrations/0004-run-restart-line.sql" with { type: "text" };

import projectMetadataSql from "./migrations/0005-project-metadata.sql" with { type: "text" };
import projectUploadsSql from "./migrations/0006-project-uploads.sql" with { type: "text" };

import photoFactsSql from "./migrations/0007-photo-facts.sql" with { type: "text" };
import folderImportsSql from "./migrations/0008-folder-imports.sql" with { type: "text" };
import runMetadataSql from "./migrations/0009-run-metadata.sql" with { type: "text" };

import runResultsSql from "./migrations/0010-run-results.sql" with { type: "text" };

import projectLinksSql from "./migrations/0011-project-links.sql" with { type: "text" };

import operatorPresetsSql from "./migrations/0012-operator-presets.sql" with { type: "text" };

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

// Imported as text so that the compiled executable carries them. Later tickets
// add theirs as 0005 and so on.
export const migrations: Migration[] = [
  { version: 1, name: "settings", sql: settingsSql },
  { version: 2, name: "engines", sql: enginesSql },
  { version: 3, name: "projects-runs", sql: projectsRunsSql },
  { version: 4, name: "run-restart-line", sql: runRestartLineSql },
  { version: 5, name: "project-metadata", sql: projectMetadataSql },
  { version: 6, name: "project-uploads", sql: projectUploadsSql },
  { version: 7, name: "photo-facts", sql: photoFactsSql },
  { version: 8, name: "folder-imports", sql: folderImportsSql },
  { version: 9, name: "run-metadata", sql: runMetadataSql },
  { version: 10, name: "run-results", sql: runResultsSql },
  { version: 11, name: "project-links", sql: projectLinksSql },
  { version: 12, name: "operator-presets", sql: operatorPresetsSql },
];

function storedVersion(db: Database): number {
  return (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
}

/**
 * Applies every migration above the database's user version, each in its own
 * transaction together with the new version number. Returns the versions applied.
 */
export function applyMigrations(db: Database, list: readonly Migration[]): number[] {
  list.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error(`Migration versions must be 1, 2, 3 without gaps, found ${migration.version} at position ${index + 1}.`);
    }
  });

  const applied: number[] = [];
  const current = storedVersion(db);
  for (const migration of list) {
    if (migration.version <= current) continue;
    db.transaction(() => {
      db.run(migration.sql);
      // Not a bound parameter: PRAGMA does not take them. The version is a number we checked above.
      db.run(`PRAGMA user_version = ${migration.version}`);
    })();
    applied.push(migration.version);
  }
  return applied;
}
