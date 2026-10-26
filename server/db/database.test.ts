import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATABASE_FILE, openDatabase } from "./database.ts";
import { applyMigrations, migrations, type Migration } from "./migrations.ts";

let folder: string;

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "aidm-ui-db-"));
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

function userVersion(db: Database): number {
  return (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
}

test("a fresh data folder gets the schema from the migrations", () => {
  const db = openDatabase(folder);
  const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
  expect(tables.map((table) => table.name)).toContain("settings");
  expect(userVersion(db)).toBe(migrations.length);
  db.close();
});

test("opening the same data folder again applies nothing", () => {
  openDatabase(folder).close();
  const db = openDatabase(folder);
  expect(applyMigrations(db, migrations)).toEqual([]);
  db.close();
});

test("the database file is readable by its owner only and uses a write-ahead journal", async () => {
  const db = openDatabase(folder);
  const mode = (await stat(join(folder, DATABASE_FILE))).mode & 0o777;
  expect(mode).toBe(0o600);
  expect((db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
  db.close();
});

test("migrations apply in order, each once, and only those above the stored version", () => {
  const db = new Database(":memory:");
  const list: Migration[] = [
    { version: 1, name: "a", sql: "CREATE TABLE a (id INTEGER) STRICT;" },
    { version: 2, name: "b", sql: "CREATE TABLE b (id INTEGER) STRICT;" },
  ];
  expect(applyMigrations(db, list.slice(0, 1))).toEqual([1]);
  expect(applyMigrations(db, list)).toEqual([2]);
  expect(userVersion(db)).toBe(2);
  expect(applyMigrations(db, list)).toEqual([]);
});

test("a migration that fails leaves the database as it was", () => {
  const db = new Database(":memory:");
  const list: Migration[] = [
    { version: 1, name: "a", sql: "CREATE TABLE a (id INTEGER) STRICT;" },
    { version: 2, name: "broken", sql: "CREATE TABLE b (id INTEGER) STRICT; NOT SQL;" },
  ];
  expect(() => applyMigrations(db, list)).toThrow();
  expect(userVersion(db)).toBe(1);
  const names = (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
    (table) => table.name,
  );
  expect(names).toEqual(["a"]);
});

test("a list of migrations with a gap is refused before anything is applied", () => {
  const db = new Database(":memory:");
  const list: Migration[] = [
    { version: 1, name: "a", sql: "CREATE TABLE a (id INTEGER) STRICT;" },
    { version: 3, name: "c", sql: "CREATE TABLE c (id INTEGER) STRICT;" },
  ];
  expect(() => applyMigrations(db, list)).toThrow();
  expect(userVersion(db)).toBe(0);
});
