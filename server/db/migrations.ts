import type { Database } from "bun:sqlite";
import settingsSql from "./migrations/0001-settings.sql" with { type: "text" };
import enginesSql from "./migrations/0002-engines.sql" with { type: "text" };
import projectsRunsSql from "./migrations/0003-projects-runs.sql" with { type: "text" };

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

// Imported as text so that the compiled executable carries them. Later tickets
// add their tables as 0004 and so on.
export const migrations: Migration[] = [
  { version: 1, name: "settings", sql: settingsSql },
  { version: 2, name: "engines", sql: enginesSql },
  { version: 3, name: "projects-runs", sql: projectsRunsSql },
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
