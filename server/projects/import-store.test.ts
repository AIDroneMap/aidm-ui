import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations, migrations } from "../db/migrations.ts";
import { ProjectStore } from "./project-store.ts";
import { ImportStore } from "./import-store.ts";

test("imports a folder and reports its files and facts", async () => {
  const root = await mkdtemp(join(tmpdir(), "aidm-import-"));
  const db = new Database(":memory:");
  try {
    db.run("PRAGMA foreign_keys = ON");
    applyMigrations(db, migrations);
    const id = new ProjectStore(db).create("Survey", "").id;
    await mkdir(join(root, "photos"));
    await writeFile(join(root, "photos", "one.jpg"), "photo");
    await writeFile(join(root, "photos", "notes.txt"), "ground control");
    const store = new ImportStore(db, join(root, "data"));
    expect(await store.select(id, join(root, "photos"))).toBe("ok");
    expect(await store.view(id, 0, 10)).toMatchObject({ state: "ready", acceptedCount: 1, groundControlCount: 1, files: [{ name: "one.jpg", size: 5, kind: "photo" }] });
    await store.prepareMetadata(id);
    expect(store.photoRows(id)[0]?.facts).not.toBeNull();
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});

test("relink preserves exclusions, skips links and leaves the previous source on failure", async () => {
  const { symlink, rename } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "aidm-import-"));
  const db = new Database(":memory:");
  try {
    db.run("PRAGMA foreign_keys = ON"); applyMigrations(db, migrations);
    const id = new ProjectStore(db).create("Survey", "").id;
    const first = join(root, "first"), second = join(root, "second");
    await mkdir(first); await mkdir(second); await mkdir(join(first, "nested"));
    await writeFile(join(first, "a.jpg"), "same"); await writeFile(join(first, "nested", "b.jpg"), "same");
    await writeFile(join(first, "other.bin"), "ignored");
    await symlink(join(first, "a.jpg"), join(first, "link.jpg"));
    await writeFile(join(second, "new.jpg"), "same");
    let store = new ImportStore(db, join(root, "data"));
    expect(await store.select(id, first)).toBe("ok");
    expect(await store.view(id, 0, 10)).toMatchObject({ acceptedCount: 2, skippedCount: 2 });
    expect(store.photoRows(id)).toHaveLength(1);
    store.setExcluded(id, [store.photoRows(id)[0]!.sha256], true);
    expect(await store.select(id, root)).toBe("invalid_path");
    expect((await store.view(id, 0, 10)).path).toBe(first);
    await rename(first, `${first}-moved`);
    store = new ImportStore(db, join(root, "data"));
    expect((await store.view(id, 0, 10)).state).toBe("missing");
    expect(await store.select(id, second)).toBe("ok");
    expect(store.photoRows(id)[0]?.excluded).toBe(1);
    db.query("DELETE FROM projects WHERE id=?").run(id);
    expect(await Bun.file(join(second, "new.jpg")).text()).toBe("same");
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});

test("copy detects a source changed during upload and leaves its task uncommitted", async () => {
  const { stat } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "aidm-import-"));
  const db = new Database(":memory:");
  try {
    db.run("PRAGMA foreign_keys = ON"); applyMigrations(db, migrations);
    const id = new ProjectStore(db).create("Survey", "").id;
    const source = join(root, "photos"); await mkdir(source);
    const path = join(source, "a.jpg"); await writeFile(path, "original");
    const store = new ImportStore(db, join(root, "data"));
    expect(await store.select(id, source)).toBe("ok");
    const before = await stat(path);
    const calls: string[] = [];
    const client = { uploadImage: async (_uuid: string, name: string, file: Blob) => { calls.push(name); expect(await file.text()).toBe("original"); return { ok: true as const, value: undefined }; } };
    expect(await store.copyToTask(id, client as never, "task")).toEqual({ ok: true, value: undefined });
    expect(calls[0]).toMatch(/^[a-f0-9]{64}\.jpg$/);
    const after = await stat(path);
    expect([after.size, after.mode, after.mtimeMs]).toEqual([before.size, before.mode, before.mtimeMs]);
    const changed = { uploadImage: async () => { await writeFile(path, "different"); return { ok: true as const, value: undefined }; } };
    await expect(store.copyToTask(id, changed as never, "task")).rejects.toMatchObject({ state: "changed" });
    expect((await store.view(id, 0, 10)).state).toBe("changed");
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});

test("pending uploads and folders overlapping app data cannot be imported", async () => {
  const root = await mkdtemp(join(tmpdir(), "aidm-import-"));
  const db = new Database(":memory:");
  try {
    db.run("PRAGMA foreign_keys = ON"); applyMigrations(db, migrations);
    const id = new ProjectStore(db).create("Survey", "").id;
    const data = join(root, "data"), source = join(root, "source");
    await mkdir(data); await mkdir(source); await mkdir(join(data, "inside"));
    const store = new ImportStore(db, data);
    expect(await store.select(id, root)).toBe("invalid_path");
    expect(await store.select(id, join(data, "inside"))).toBe("invalid_path");
    db.query("INSERT INTO project_uploads(id,project_id,name,size,sha256,chunk_size) VALUES (?,?,?,?,?,?)").run("pending", id, "a.jpg", 1, "hash", 1);
    expect(await store.select(id, source)).toBe("uploads_present");
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});

async function withSource(run: (store: ImportStore, id: number, source: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "aidm-import-"));
  const db = new Database(":memory:");
  try {
    db.run("PRAGMA foreign_keys = ON"); applyMigrations(db, migrations);
    const source = join(root, "photos"); await mkdir(source);
    await run(new ImportStore(db, join(root, "data")), new ProjectStore(db).create("Survey", "").id, source);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
}

test("copy keeps the verified file open if its path is replaced by a link", async () => {
  const { rename, symlink } = await import("node:fs/promises");
  await withSource(async (store, id, source) => {
    const photo = join(source, "a.jpg"), other = join(source, "outside.bin");
    await writeFile(photo, "original"); await writeFile(other, "outside");
    expect(await store.select(id, source)).toBe("ok");
    let received = "";
    const client = { uploadImage: async (_id: string, _name: string, file: Blob) => {
      await rename(photo, join(source, "old.jpg")); await symlink(other, photo);
      received = await file.text();
      return { ok: true as const, value: undefined };
    } };
    await expect(store.copyToTask(id, client as never, "task")).rejects.toMatchObject({ state: "changed" });
    expect(received).toBe("original");
  });
});

test("copy sends each photo checksum once with distinct bounded names and paired masks", async () => {
  await withSource(async (store, id, source) => {
    await writeFile(join(source, "a.jpg"), "photo");
    await writeFile(join(source, "z.jpg"), "photo");
    await writeFile(join(source, "a_mask.jpg"), "mask");
    await mkdir(join(source, "first")); await mkdir(join(source, "second"));
    await writeFile(join(source, "first", "a.jpg"), "first");
    await writeFile(join(source, "second", "a.jpg"), "second");
    await writeFile(join(source, "p".repeat(240) + ".jpg"), "long");
    expect(await store.select(id, source)).toBe("ok");
    const sent: Array<{ name: string; text: string }> = [];
    const client = { uploadImage: async (_id: string, name: string, data: Blob) => {
      sent.push({ name, text: await data.text() }); return { ok: true as const, value: undefined };
    } };
    expect((await store.copyToTask(id, client as never, "task")).ok).toBe(true);
    expect(sent.map(file => file.text).sort()).toEqual(["first", "long", "mask", "photo", "second"]);
    expect(new Set(sent.map(file => file.name)).size).toBe(5);
    expect(sent.every(file => Buffer.byteLength(file.name) <= 255)).toBe(true);
    expect(sent.find(file => file.text === "mask")!.name.replace("_mask.jpg", ".jpg")).toBe(sent.find(file => file.text === "photo")!.name);
  });
});

test("an active copy refuses relinking and an absent import cannot report a successful copy", async () => {
  await withSource(async (store, id, source) => {
    const client = { uploadImage: async () => {
      expect(await store.select(id, source)).toBe("busy");
      return { ok: true as const, value: undefined };
    } };
    await expect(store.copyToTask(id, client as never, "task")).rejects.toMatchObject({ state: "missing" });
    await writeFile(join(source, "a.jpg"), "photo");
    expect(await store.select(id, source)).toBe("ok");
    expect((await store.copyToTask(id, client as never, "task")).ok).toBe(true);
    expect(store.isBusy(id)).toBe(false);
  });
});

test("leaving a photo out also leaves its matching mask out of the engine copy", async () => {
  await withSource(async (store, id, source) => {
    await writeFile(join(source, "a.jpg"), "omitted photo"); await writeFile(join(source, "a_mask.jpg"), "omitted mask");
    await writeFile(join(source, "b.jpg"), "included photo");
    expect(await store.select(id, source)).toBe("ok");
    store.setExcluded(id, [store.photoRows(id).find(photo => photo.name === "a.jpg")!.sha256], true);
    const sent: string[] = [];
    const client = { uploadImage: async (_id: string, _name: string, data: Blob) => { sent.push(await data.text()); return { ok: true as const, value: undefined }; } };
    expect((await store.copyToTask(id, client as never, "task")).ok).toBe(true);
    expect(sent).toEqual(["included photo"]);
  });
});
