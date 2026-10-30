import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations, migrations } from "../db/migrations.ts";
import { ImportStore } from "./import-store.ts";
import { ProjectStore } from "./project-store.ts";
import { RunInputs, RunInputsChanged } from "./run-inputs.ts";

async function fixture(run: (context: { db: Database; root: string; id: number; inputs: RunInputs; imports: ImportStore }) => Promise<void>) {
  const temporary = await mkdtemp(join(tmpdir(), "run-inputs-"));
  const root = join(temporary, "data");
  const db = new Database(":memory:");
  try {
    db.run("PRAGMA foreign_keys = ON"); applyMigrations(db, migrations);
    const id = new ProjectStore(db).create("Survey", "").id;
    const imports = new ImportStore(db, root);
    await mkdir(join(root, "projects", String(id), "files"), { recursive: true });
    await run({ db, root, id, inputs: new RunInputs(db, root, imports), imports });
  } finally { db.close(); await rm(temporary, { recursive: true, force: true }); }
}

async function upload(db: Database, root: string, id: number, name: string, content: string, kind: string) {
  const hash = createHash("sha256").update(content).digest("hex");
  const storage = hash.slice(0, 32);
  await writeFile(join(root, "projects", String(id), "files", storage), content);
  db.query("INSERT OR IGNORE INTO project_upload_files VALUES (?,?,?,?)").run(id, hash, Buffer.byteLength(content), storage);
  db.query("INSERT INTO project_upload_aliases VALUES (?,?,?,?)").run(id, name, hash, kind);
  return hash;
}

test("snapshot counts unique included photos and copies their paired masks", async () => {
  await fixture(async ({ db, root, id, inputs }) => {
    await upload(db, root, id, "a.jpg", "photo", "photo");
    await upload(db, root, id, "z.jpg", "photo", "photo");
    await upload(db, root, id, "a_mask.jpg", "mask", "mask");
    const excluded = await upload(db, root, id, "b.jpg", "excluded", "photo");
    await upload(db, root, id, "b_mask.jpg", "excluded mask", "mask");
    db.query("INSERT INTO project_photo_exclusions VALUES (?,?)").run(id, excluded);
    const snapshot = await inputs.snapshot(id);
    expect(snapshot).toMatchObject({ wayIn: "upload", photoCount: 1, excludedPhotoCount: 1, totalPhotoCount: 2, photoBytes: 5 });
    const sent: Array<{ name: string; text: string }> = [];
    const client = { uploadImage: async (_uuid: string, name: string, data: Blob) => { sent.push({ name, text: await data.text() }); return { ok: true as const, value: undefined }; } };
    expect(await inputs.copyToTask(id, snapshot, client as never, "task")).toEqual({ ok: true, value: undefined });
    expect(sent.map(file => file.text).sort()).toEqual(["mask", "photo"]);
    expect(sent.find(file => file.text === "mask")!.name.replace("_mask.jpg", ".jpg")).toBe(sent.find(file => file.text === "photo")!.name);
  });
});

test("rejects damaged files and changes during upload", async () => {
  await fixture(async ({ db, root, id, inputs }) => {
    const hash = await upload(db, root, id, "a.jpg", "photo", "photo");
    const path = join(root, "projects", String(id), "files", hash.slice(0, 32));
    const snapshot = await inputs.snapshot(id);
    const client = { uploadImage: async () => { await writeFile(path, "other"); return { ok: true as const, value: undefined }; } };
    await expect(inputs.copyToTask(id, snapshot, client as never, "task")).rejects.toBeInstanceOf(RunInputsChanged);
    await expect(inputs.copyToTask(id, snapshot, client as never, "task")).rejects.toBeInstanceOf(RunInputsChanged);
  });
});

test("rejects inventory drift and cancellation", async () => {
  await fixture(async ({ db, root, id, inputs }) => {
    await upload(db, root, id, "a.jpg", "photo", "photo");
    const snapshot = await inputs.snapshot(id);
    await upload(db, root, id, "b.mp4", "video", "video");
    const client = { uploadImage: async () => ({ ok: true as const, value: undefined }) };
    await expect(inputs.copyToTask(id, snapshot, client as never, "task")).rejects.toBeInstanceOf(RunInputsChanged);
    const controller = new AbortController(); controller.abort();
    await expect(inputs.copyToTask(id, await inputs.snapshot(id), client as never, "task", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});

test("import copy preserves source and rejects exclusion drift", async () => {
  await fixture(async ({ root, id, inputs, imports }) => {
    const source = join(root, "..", "source"); await mkdir(source);
    await writeFile(join(source, "a.jpg"), "original");
    expect(await imports.select(id, source)).toBe("ok");
    const snapshot = await inputs.snapshot(id);
    const client = { uploadImage: async (_uuid: string, _name: string, data: Blob) => {
      expect(await data.text()).toBe("original");
      imports.setExcluded(id, [imports.photoRows(id)[0]!.sha256], true);
      return { ok: true as const, value: undefined };
    } };
    await expect(inputs.copyToTask(id, snapshot, client as never, "task")).rejects.toBeInstanceOf(RunInputsChanged);
    expect(await Bun.file(join(source, "a.jpg")).text()).toBe("original");
  });
});

test("distinct photos with the same alias get distinct task names", async () => {
  await fixture(async ({ db, root, id, inputs }) => {
    await upload(db, root, id, "a.jpg", "first", "photo");
    await upload(db, root, id, "a.jpg", "second", "photo");
    const names: string[] = [];
    const client = { uploadImage: async (_uuid: string, name: string) => { names.push(name); return { ok: true as const, value: undefined }; } };
    expect((await inputs.copyToTask(id, await inputs.snapshot(id), client as never, "task")).ok).toBe(true);
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
  });
});

test("rejects a changed imported source before copying", async () => {
  await fixture(async ({ root, id, inputs, imports }) => {
    const source = join(root, "..", "source"); await mkdir(source);
    const path = join(source, "a.jpg"); await writeFile(path, "original");
    expect(await imports.select(id, source)).toBe("ok");
    const snapshot = await inputs.snapshot(id);
    await writeFile(path, "changed");
    const client = { uploadImage: async () => { throw new Error("unexpected upload"); } };
    await expect(inputs.copyToTask(id, snapshot, client as never, "task")).rejects.toMatchObject({ state: "changed" });
    expect(await Bun.file(path).text()).toBe("changed");
  });
});
