import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations, migrations } from "../db/migrations.ts";
import { ProjectStore } from "./project-store.ts";

test("new projects start with no photos or runs and the sample stays hidden", () => {
  const db = new Database(":memory:");
  applyMigrations(db, migrations);
  const projects = new ProjectStore(db);
  const project = projects.create("Survey", "Field notes");
  expect(projects.list()).toEqual([expect.objectContaining({ id: project.id, name: "Survey", notes: "Field notes", photoCount: 0, runCount: 0, latestState: null })]);
  db.close();
});

test("project facts use source and run activity, and the sample appears only after a run", () => {
  const db = new Database(":memory:");
  applyMigrations(db, migrations);
  const projects = new ProjectStore(db);
  const first = projects.create("First", "");
  const second = projects.create("Second", "");
  db.query("UPDATE projects SET updated_at = ? WHERE id = ?").run("2024-01-01T00:00:00.000Z", first.id);
  db.query("UPDATE projects SET updated_at = ? WHERE id = ?").run("2024-02-01T00:00:00.000Z", second.id);
  const sample = (db.query("SELECT id FROM projects WHERE builtin = 'sample'").get() as { id: number }).id;
  db.query("UPDATE projects SET updated_at = ? WHERE id = ?").run("2024-01-01T00:00:00.000Z", sample);
  const insert = db.query("INSERT INTO runs (project_id, options, state, created_at, updated_at) VALUES (?, '[]', ?, ?, ?)");
  insert.run(first.id, "completed", "2024-03-01T00:00:00.000Z", "2024-03-01T00:00:00.000Z");
  insert.run(first.id, "failed", "2024-04-01T00:00:00.000Z", "2024-05-01T00:00:00.000Z");
  insert.run(sample, "completed", "2024-01-01T00:00:00.000Z", "2024-01-01T00:00:00.000Z");
  expect(projects.list().map(p => p.id)).toEqual([first.id, second.id, sample]);
  expect(projects.get(first.id)).toMatchObject({ photoCount: 0, runCount: 2, latestState: "failed", lastChange: "2024-05-01T00:00:00.000Z" });
  expect(projects.get(sample)?.photoCount).toBe(73);
  expect(projects.update(first.id, "Renamed", "Notes")).toMatchObject({ name: "Renamed", notes: "Notes" });
  expect(projects.setPhotoCount(first.id, 4)).toEqual({ ok: true });
  expect(projects.get(first.id)?.photoCount).toBe(4);
  expect(projects.setPhotoCount(sample, 4)).toEqual({ ok: false, code: "project.sample_photos_forbidden" });
  expect(projects.get(sample)?.photoCount).toBe(73);
  expect(projects.update(sample, "Other", "Notes")?.name).toBe("Sample project");
  db.close();
});

test("an unrecognised stored run state is reported as unknown", () => {
  const db = new Database(":memory:");
  applyMigrations(db, migrations);
  const projects = new ProjectStore(db);
  const project = projects.create("Survey", "");
  db.query("INSERT INTO runs (project_id, options, state, created_at, updated_at) VALUES (?, '[]', 'new-state', ?, ?)").run(project.id, "2024-01-01", "2024-01-01");
  expect(projects.get(project.id)?.latestState).toBe("unknown");
  db.close();
});
