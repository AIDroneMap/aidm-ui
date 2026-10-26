import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations, migrations } from "../db/migrations.ts";
import { Settings } from "./settings.ts";

function memory(): Database {
  const db = new Database(":memory:", { strict: true });
  applyMigrations(db, migrations);
  return db;
}

test("a setting that was never written has its default", () => {
  const settings = new Settings(memory());
  expect(settings.get("server.port")).toBeNull();
  expect(settings.get("lan.enabled")).toBe(false);
  expect(settings.get("lan.passphraseHash")).toBeNull();
});

test("a written setting is read back, and a later write replaces it", () => {
  const settings = new Settings(memory());
  settings.set("server.port", 9000);
  settings.set("lan.enabled", true);
  expect(settings.get("server.port")).toBe(9000);
  expect(settings.get("lan.enabled")).toBe(true);
  settings.set("server.port", null);
  expect(settings.get("server.port")).toBeNull();
});

test("settings live in the database, so a second reader sees them", () => {
  const db = memory();
  new Settings(db).set("lan.passphraseHash", "hash");
  expect(new Settings(db).get("lan.passphraseHash")).toBe("hash");
});
