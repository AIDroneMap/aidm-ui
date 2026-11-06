import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, realpathSync, type Stats } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { applyMigrations, migrations } from "../db/migrations.ts";
import { ImportStore } from "./import-store.ts";
import { ProjectStore } from "./project-store.ts";
import { RunInputs, RunInputsChanged, type RunFiles } from "./run-inputs.ts";

type Context = { db: Database; root: string; id: number; inputs: RunInputs; imports: ImportStore };
type Setup = { root?: (temporary: string) => Promise<string>; files?: RunFiles };

async function fixture(run: (context: Context) => Promise<void>, setup: Setup = {}) {
  const temporary = await mkdtemp(join(tmpdir(), "run-inputs-"));
  const root = setup.root ? await setup.root(temporary) : join(temporary, "data");
  const db = new Database(":memory:");
  try {
    db.run("PRAGMA foreign_keys = ON"); applyMigrations(db, migrations);
    const id = new ProjectStore(db).create("Survey", "").id;
    const imports = new ImportStore(db, root);
    await mkdir(join(root, "projects", String(id), "files"), { recursive: true });
    await run({ db, root, id, inputs: new RunInputs(db, root, imports, setup.files), imports });
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

// What Bun reported on a Windows machine for the checks of an upload, in test-support/recorded/windows/file-identity.json.
type RecordedStats = { dev: number; ino: number; mode: number; size: number; isFile: boolean; isSymbolicLink: boolean };
const windows = JSON.parse(await readFile(join(import.meta.dir, "..", "..", "test-support", "recorded", "windows", "file-identity.json"), "utf8")) as {
  folder: string; realpath: string; photo: { lstat: RecordedStats; fstat: RecordedStats }; link: { lstat: RecordedStats; fstat: RecordedStats }; junction: { realpath: string };
};
const stats = (recorded: RecordedStats) => ({ ...recorded, isFile: () => recorded.isFile, isSymbolicLink: () => recorded.isSymbolicLink }) as unknown as Stats;
// The folder of the recording, where the data folder sat, by its short 8.3 name and by the long name `realpath` answered.
const [shortName, longName] = [windows.folder, windows.realpath].map(path => win32.basename(win32.resolve(path, "..", "..", "..", "..")));
const probeName = win32.basename(win32.resolve(windows.folder, "..", "..", ".."));

/**
 * A data folder reached by another spelling than the one `realpath` answers, as Windows reached the recorded one by its
 * short name. Windows with 8.3 names on gives the long folder that short name itself. Where it does not, as on Linux,
 * the short name is a link to the long one, which `realpath` follows the same way.
 */
async function shortNamed(temporary: string): Promise<string> {
  await mkdir(join(temporary, longName!, probeName), { recursive: true });
  if (!existsSync(join(temporary, shortName!))) await symlink(join(temporary, longName!), join(temporary, shortName!), "junction");
  return join(temporary, shortName!, probeName);
}

/** The system's answers, with the photo's `lstat` and `fstat` replaced by the recorded Windows ones, in the order given. */
function recordedIdentity(lstats: RecordedStats[], fstat: RecordedStats): RunFiles {
  let calls = 0;
  return { realpath: path => realpathSync.native(path), lstat: async () => stats(lstats[Math.min(calls++, lstats.length - 1)]!), fstat: async () => stats(fstat) };
}

const sent = () => {
  const texts: string[] = [];
  return { texts, client: { uploadImage: async (_uuid: string, _name: string, data: Blob) => { texts.push(await data.text()); return { ok: true as const, value: undefined }; } } };
};

test("the recording is a short 8.3 name that realpath answers with the long name, and one file for lstat and fstat", () => {
  expect(shortName).toBe("LONGFO~1");
  expect(longName).toBe("long folder name for probe");
  expect(windows.folder.replace(shortName!, longName!)).toBe(windows.realpath);
  expect(windows.photo.lstat).toEqual(windows.photo.fstat);
});

test("photos in a data folder under a short 8.3 name reach the engine, with lstat and fstat as Windows reports them", async () => {
  await fixture(async ({ db, root, id, inputs }) => {
    expect(realpathSync.native(root)).not.toBe(root);
    await upload(db, root, id, "a.jpg", "photo", "photo");
    const { texts, client } = sent();
    expect(await inputs.copyToTask(id, await inputs.snapshot(id), client as never, "task")).toEqual({ ok: true, value: undefined });
    expect(texts).toEqual(["photo"]);
  }, { root: shortNamed, files: recordedIdentity([windows.photo.lstat], windows.photo.fstat) });
});

test("under a short 8.3 name, a changed photo is still refused", async () => {
  await fixture(async ({ db, root, id, inputs }) => {
    const hash = await upload(db, root, id, "a.jpg", "photo", "photo");
    const snapshot = await inputs.snapshot(id);
    await writeFile(join(root, "projects", String(id), "files", hash.slice(0, 32)), "other");
    await expect(inputs.copyToTask(id, snapshot, sent().client as never, "task")).rejects.toBeInstanceOf(RunInputsChanged);
  }, { root: shortNamed });
});

test("a photo replaced by another file with the same bytes is refused", async () => {
  await fixture(async ({ db, root, id, inputs }) => {
    const hash = await upload(db, root, id, "a.jpg", "photo", "photo");
    const path = join(root, "projects", String(id), "files", hash.slice(0, 32));
    const client = { uploadImage: async () => {
      await writeFile(path + ".new", "photo"); await rename(path + ".new", path);
      return { ok: true as const, value: undefined };
    } };
    await expect(inputs.copyToTask(id, await inputs.snapshot(id), client as never, "task")).rejects.toBeInstanceOf(RunInputsChanged);
  }, { root: shortNamed });
});

test("a link in the photo's place is refused, before and after it is opened, as Windows reports it", async () => {
  // Before: lstat sees the link.
  await fixture(async ({ db, root, id, inputs }) => {
    await upload(db, root, id, "a.jpg", "photo", "photo");
    await expect(inputs.copyToTask(id, await inputs.snapshot(id), sent().client as never, "task")).rejects.toBeInstanceOf(RunInputsChanged);
  }, { root: shortNamed, files: recordedIdentity([windows.link.lstat], windows.photo.fstat) });
  // After: Windows has no O_NOFOLLOW, so the name now leads to the link's target, another file than the one opened.
  await fixture(async ({ db, root, id, inputs }) => {
    await upload(db, root, id, "a.jpg", "photo", "photo");
    await expect(inputs.copyToTask(id, await inputs.snapshot(id), sent().client as never, "task")).rejects.toBeInstanceOf(RunInputsChanged);
  }, { root: shortNamed, files: recordedIdentity([windows.photo.lstat, windows.link.fstat], windows.photo.fstat) });
});

test("a files folder replaced by a link to another folder is refused, as realpath follows a Windows junction", async () => {
  // The recording: realpath answers the junction's target, not the files folder.
  expect(win32.basename(windows.junction.realpath)).toBe("other-files");
  await fixture(async ({ db, root, id, inputs }) => {
    const hash = await upload(db, root, id, "a.jpg", "photo", "photo");
    const files = join(root, "projects", String(id), "files"), other = join(root, "other-files");
    const snapshot = await inputs.snapshot(id);
    await mkdir(other); await writeFile(join(other, hash.slice(0, 32)), "photo");
    await rename(files, files + "-old"); await symlink(other, files, "junction");
    expect((await lstat(files)).isSymbolicLink()).toBe(true);
    await expect(inputs.copyToTask(id, snapshot, sent().client as never, "task")).rejects.toBeInstanceOf(RunInputsChanged);
  }, { root: shortNamed });
});

test("a data folder replaced by a link after Review is refused, under its own name and under a short 8.3 name", async () => {
  for (const place of [undefined, shortNamed]) {
    await fixture(async ({ db, root, id, inputs }) => {
      await upload(db, root, id, "a.jpg", "photo", "photo");
      const snapshot = await inputs.snapshot(id);
      const moved = join(root, "..", "moved");
      await rename(root, moved); await symlink(moved, root, "junction");
      await expect(inputs.copyToTask(id, snapshot, sent().client as never, "task")).rejects.toBeInstanceOf(RunInputsChanged);
    }, { root: place });
  }
});

test("nothing is sent when the data folder could not be read when the server started", async () => {
  await fixture(async ({ db, root, id, imports }) => {
    await upload(db, root, id, "a.jpg", "photo", "photo");
    const inputs = new RunInputs(db, root, imports, { realpath: () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); }, lstat, fstat: file => file.stat() });
    await expect(inputs.copyToTask(id, await inputs.snapshot(id), sent().client as never, "task")).rejects.toBeInstanceOf(RunInputsChanged);
  });
});
