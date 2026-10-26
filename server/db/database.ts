import { Database } from "bun:sqlite";
import { chmodSync, closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { applyMigrations, migrations } from "./migrations.ts";

export const DATABASE_FILE = "aidm-ui.sqlite";

/** Opens the database in the data folder, creates it if needed and brings its schema up to date. */
export function openDatabase(dataFolder: string): Database {
  const file = join(dataFolder, DATABASE_FILE);
  // Create the file private from the start: it will hold engine tokens.
  closeSync(openSync(file, "a", 0o600));
  chmodSync(file, 0o600);

  const db = new Database(file, { create: true, strict: true });
  try {
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA foreign_keys = ON");
    db.run("PRAGMA busy_timeout = 5000");
    applyMigrations(db, migrations);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}
