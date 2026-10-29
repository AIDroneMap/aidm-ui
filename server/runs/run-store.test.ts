import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { applyMigrations, migrations } from "../db/migrations.ts";
import { EngineStore } from "../engines/engine-store.ts";
import { RunStore } from "./run-store.ts";
import { ProjectStore } from "../projects/project-store.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let db: Database;
let store: RunStore;
let engineId: number;

beforeEach(() => {
  db = new Database(":memory:", { strict: true });
  db.run("PRAGMA foreign_keys = ON");
  applyMigrations(db, migrations);
  store = new RunStore(db);
  engineId = new EngineStore(db).addRemote({ name: "Office", address: "http://192.168.1.5:3000", token: "t" }).id;
});

afterEach(() => db.close());

function newRun(options = [{ name: "dsm", value: true }]) {
  const projectId = store.builtinProjectId("sample") as number;
  return store.create({ projectId, engineId, options });
}

test("the sample project exists after the migrations", () => {
  expect(store.builtinProjectId("sample")).toBeGreaterThan(0);
  expect(store.builtinProjectId("nothing")).toBeNull();
});

test("a new run is created with the options sent to the engine and no task yet", () => {
  const run = newRun();
  expect(run).toMatchObject({
    state: "created",
    taskUuid: null,
    options: [{ name: "dsm", value: true }],
    progress: null,
    engineMessage: null,
    problem: null,
    restarted: false,
    engineId,
  });
  expect(store.get(run.id)).toEqual(run);
  expect(store.get(999)).toBeNull();
});

test("update changes the fields given and keeps the rest", () => {
  const run = newRun();
  store.update(run.id, { taskUuid: "abc", state: "queued" });
  store.update(run.id, { progress: 12.5, engineMessage: "Not enough memory" });
  store.update(run.id, { problem: { code: "run.upload_failed", data: { a: 1 } } });
  expect(store.get(run.id)).toMatchObject({
    taskUuid: "abc",
    state: "queued",
    progress: 12.5,
    engineMessage: "Not enough memory",
    problem: { code: "run.upload_failed", data: { a: 1 } },
  });
  store.update(run.id, { problem: null });
  expect(store.get(run.id)?.problem).toBeNull();
  expect(store.update(999, { state: "failed" })).toBeNull();
});

test("a finished run keeps what is stored, whatever update is asked", () => {
  for (const finished of ["completed", "failed", "cancelled"] as const) {
    const run = newRun();
    store.update(run.id, { taskUuid: "t", state: finished, progress: 100 });
    const stored = store.get(run.id);
    const returned = store.update(run.id, { state: "queued", progress: 5, problem: { code: "run.engine_lost", data: {} } });
    expect(returned).toEqual(stored);
    expect(store.get(run.id)).toEqual(stored);
  }
});

test("the latest run of a project is the one made last", () => {
  const projectId = store.builtinProjectId("sample") as number;
  expect(store.latestForProject(projectId)).toBeNull();
  newRun();
  const second = newRun();
  expect(store.latestForProject(projectId)?.id).toBe(second.id);
});

test("active runs have a task and are not finished", () => {
  const waiting = newRun();
  const processing = newRun();
  const done = newRun();
  store.update(processing.id, { taskUuid: "p", state: "processing" });
  store.update(done.id, { taskUuid: "d", state: "completed" });
  expect(store.listActive().map((run) => run.id)).toEqual([processing.id]);
  expect(store.listUnfinished().map((run) => run.id)).toEqual([waiting.id, processing.id]);
});

test("removing the engine keeps its runs and forgets the engine", () => {
  const run = newRun();
  new EngineStore(db).remove(engineId);
  expect(store.get(run.id)?.engineId).toBeNull();
});

test("a run is marked restarted once, and later updates keep the mark", () => {
  const run = newRun();
  store.update(run.id, { taskUuid: "abc", state: "processing" });
  expect(store.get(run.id)?.restarted).toBe(false);
  store.update(run.id, { state: "queued", restarted: true });
  store.update(run.id, { progress: 3 });
  expect(store.get(run.id)).toMatchObject({ state: "queued", restarted: true, progress: 3 });
});

test("run metadata survives storage", () => {
  const projectId = store.builtinProjectId("sample") as number;
  const run = store.create({ projectId, engineId, options: [], name: "North field", preset: "map-with-heights", wayIn: "upload", sample: false });
  expect(store.get(run.id)).toMatchObject({ name: "North field", preset: "map-with-heights", wayIn: "upload", sample: false });
});

test("migration preserves old runs with unknown metadata", () => {
  const old = new Database(":memory:", { strict: true });
  applyMigrations(old, migrations.slice(0, 4));
  const oldStore = new RunStore(old);
  const projectId = oldStore.builtinProjectId("sample") as number;
  old.run("INSERT INTO runs (project_id, options, state, created_at, updated_at) VALUES (?, '[]', 'created', 'then', 'then')", [projectId]);
  applyMigrations(old, migrations);
  expect(oldStore.get(1)).toMatchObject({ name: null, preset: null, wayIn: null, sample: false });
  old.close();
});


test("deleted legacy run IDs stay reserved after reopening the database", () => {
  const folder = mkdtempSync(join(tmpdir(), "run-ids-"));
  const path = join(folder, "database.sqlite");
  let legacy: Database | undefined = new Database(path, { strict: true });
  try {
    applyMigrations(legacy, migrations.slice(0, 4));
    const engine = new EngineStore(legacy).addRemote({ name: "Engine", address: "http://127.0.0.1:1", token: "test" });
    const projectId = new RunStore(legacy).builtinProjectId("sample")!;
    legacy.query(`INSERT INTO runs (id, project_id, engine_id, options, state, created_at, updated_at)
      VALUES (42, ?, ?, '[]', 'completed', '2026-10-29', '2026-10-29')`).run(projectId, engine.id);
    applyMigrations(legacy, migrations);
    new ProjectStore(legacy).removeRows(projectId);
    expect(legacy.query("SELECT id FROM runs").all()).toEqual([]);
    legacy.close();
    legacy = new Database(path, { strict: true });
    const next = new RunStore(legacy).create({ projectId, engineId: engine.id, options: [] });
    expect(next.id).toBeGreaterThan(42);
  } finally { legacy?.close(); rmSync(folder, { recursive: true, force: true }); }
});

test("version 5 run IDs stay reserved when run metadata is added", () => {
  const old = new Database(":memory:", { strict: true });
  applyMigrations(old, migrations.slice(0, 4));
  const projectId = new RunStore(old).builtinProjectId("sample")!;
  old.run("INSERT INTO runs (id, project_id, options, state, created_at, updated_at) VALUES (42, ?, '[]', 'completed', 'then', 'then')", [projectId]);
  applyMigrations(old, migrations.slice(0, 5));
  old.run("DELETE FROM runs WHERE id = 42");
  applyMigrations(old, migrations);
  const engine = new EngineStore(old).addRemote({ name: "Engine", address: "http://127.0.0.1:1", token: "test" });
  const run = new RunStore(old).create({ projectId, engineId: engine.id, options: [], name: "Field", preset: "map-with-heights", wayIn: "upload", sample: false });
  expect(run).toMatchObject({ id: 43, name: "Field", preset: "map-with-heights", wayIn: "upload", sample: false });
  expect(new RunStore(old).get(run.id)).toEqual(run);
  old.close();
});

test("version 6 uploads survive the run metadata migration", () => {
  const old = new Database(":memory:", { strict: true });
  applyMigrations(old, migrations.slice(0, 6));
  const projectId = new RunStore(old).builtinProjectId("sample")!;
  old.query("INSERT INTO project_upload_files (project_id, sha256, size, storage_id) VALUES (?, 'hash', 12, 'stored')").run(projectId);
  old.query("INSERT INTO project_upload_aliases (project_id, name, sha256, kind) VALUES (?, 'flight.jpg', 'hash', 'photo')").run(projectId);
  old.query("INSERT INTO runs (project_id, options, state, created_at, updated_at) VALUES (?, '[]', 'created', 'then', 'then')").run(projectId);
  applyMigrations(old, migrations);
  expect(old.query("SELECT name, sha256, kind FROM project_upload_aliases WHERE project_id = ?").all(projectId)).toEqual([{ name: "flight.jpg", sha256: "hash", kind: "photo" }]);
  expect(new RunStore(old).get(1)).toMatchObject({ name: null, preset: null, wayIn: null, sample: false });
  old.close();
});
