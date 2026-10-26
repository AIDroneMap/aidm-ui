import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { applyMigrations, migrations } from "../db/migrations.ts";
import { EngineStore } from "./engine-store.ts";

let db: Database;
let store: EngineStore;

beforeEach(() => {
  db = new Database(":memory:", { strict: true });
  applyMigrations(db, migrations);
  store = new EngineStore(db);
});

afterEach(() => db.close());

test("a new remote engine is stored enabled and starting, with its token", () => {
  const engine = store.addRemote({ name: "Office", address: "http://192.168.1.5:3000", token: "t0k" });
  expect(engine).toEqual({
    id: engine.id,
    kind: "remote",
    packageKind: null,
    name: "Office",
    address: "http://192.168.1.5:3000",
    token: "t0k",
    enabled: true,
    installedVersion: null,
    lastState: "starting",
  });
  expect(store.list()).toEqual([engine]);
  expect(store.get(engine.id)).toEqual(engine);
});

test("update changes only the fields given", () => {
  const { id } = store.addRemote({ name: "Office", address: "http://192.168.1.5:3000", token: "t0k" });
  const edited = store.update(id, { name: "Barn", enabled: false });
  expect(edited).toMatchObject({ name: "Barn", address: "http://192.168.1.5:3000", token: "t0k", enabled: false });
  expect(store.update(id, { token: "new" })?.token).toBe("new");
  expect(store.update(id, { enabled: true })?.enabled).toBe(true);
  expect(store.update(999, { name: "x" })).toBeNull();
});

test("remove deletes the engine and says whether there was one", () => {
  const { id } = store.addRemote({ name: "Office", address: "http://192.168.1.5:3000", token: "" });
  expect(store.remove(id)).toBe(true);
  expect(store.remove(id)).toBe(false);
  expect(store.list()).toEqual([]);
});

test("the last known state is stored", () => {
  const { id } = store.addRemote({ name: "Office", address: "http://192.168.1.5:3000", token: "" });
  store.setLastState(id, "unreachable");
  expect(store.get(id)?.lastState).toBe("unreachable");
});

test("a stored state nobody knows is read as starting and logged once", () => {
  const lines: string[] = [];
  const logged = new EngineStore(db, (line) => lines.push(line));
  const { id } = logged.addRemote({ name: "A", address: "https://engine.example.com", token: "t" });
  db.query("UPDATE engines SET last_state = 'sleeping' WHERE id = ?").run(id);
  expect(logged.get(id)?.lastState).toBe("starting");
  logged.list();
  logged.get(id);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("sleeping");
});
