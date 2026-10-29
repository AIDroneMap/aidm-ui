import { Database } from "bun:sqlite";
import { DATABASE_FILE } from "../db/database.ts";
import { applyMigrations, migrations } from "../db/migrations.ts";
import { ProjectStore } from "./project-store.ts";
import { UploadStore } from "./upload-store.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { openHarness, type Harness } from "../testing/harness.ts";

let harness: Harness;
beforeEach(() => { harness = openHarness(); });
afterEach(async () => { await harness.stop(); });

async function createProject(): Promise<number> {
  const response = await fetch(`${harness.base}/api/projects`, { method: "POST", body: JSON.stringify({ name: "Field", notes: "" }) });
  return (await response.json() as { id: number }).id;
}
async function upload(projectId: number, name: string, bytes: Uint8Array): Promise<void> {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const root = `${harness.base}/api/projects/${projectId}/uploads`;
  const response = await fetch(root, { method: "POST", body: JSON.stringify({ name, size: bytes.length, sha256 }) });
  expect(response.status).toBe(201);
  const session = await response.json() as { id: string; complete: boolean };
  if (session.complete) return;
  expect((await fetch(`${root}/${session.id}/chunks/0`, { method: "PUT", headers: { "x-chunk-sha256": sha256 }, body: new Uint8Array(bytes) })).status).toBe(204);
  expect((await fetch(`${root}/${session.id}/complete`, { method: "POST" })).status).toBe(200);
}

test("photo facts count stored content once, disclose duplicate names and separate videos and masks", async () => {
  const id = await createProject();
  const bytes = new TextEncoder().encode("corrupt photo");
  await upload(id, "a.jpg", bytes);
  await upload(id, "copy.jpg", bytes);
  await upload(id, "a_mask.jpg", bytes);
  await upload(id, "flight.mp4", new Uint8Array([1, 2, 3]));
  const response = await fetch(`${harness.base}/api/projects/${id}/photo-facts`);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ photoCount: 1, photoBytes: 13, duplicates: 1, videoCount: 1, withoutGps: 1, cameras: [], bands: [], dateSpans: [], flights: [], unassignedCount: 1, pendingMetadata: 0, nextOffset: null });
});

function timedPhoto(time: string): Uint8Array {
  const bytes = Buffer.alloc(112);
  bytes.write("II", 0); bytes.writeUInt16LE(42, 2); bytes.writeUInt32LE(8, 4);
  bytes.writeUInt16LE(3, 8);
  function entry(at: number, tag: number, type: number, count: number, value: number) {
    bytes.writeUInt16LE(tag, at); bytes.writeUInt16LE(type, at + 2); bytes.writeUInt32LE(count, at + 4); bytes.writeUInt32LE(value, at + 8);
  }
  entry(10, 0x010f, 2, 6, 50);
  entry(22, 0x0110, 2, 7, 56);
  entry(34, 0x8769, 4, 1, 64);
  bytes.write("Maker\0", 50); bytes.write("Survey\0", 56);
  bytes.writeUInt16LE(1, 64);
  entry(66, 0x9003, 2, 20, 88);
  bytes.write(time + "\0", 88);
  return bytes;
}

test("project facts include recorded cameras, date spans and thirty-minute flights", async () => {
  const id = await createProject();
  await upload(id, "first.tif", timedPhoto("2026:10:29 09:00:00"));
  await upload(id, "second.tif", timedPhoto("2026:10:29 09:30:00"));
  await upload(id, "third.tif", timedPhoto("2026:10:29 10:00:01"));
  const response = await fetch(`${harness.base}/api/projects/${id}/photo-facts?limit=1`);
  expect(response.status).toBe(200);
  const facts = await response.json() as { flights: unknown[]; nextOffset: number | null };
  expect(facts).toMatchObject({ photoCount: 3, photoBytes: 336, cameras: [{ make: "Maker", model: "Survey", photoCount: 3 }], dateSpans: [{ clock: "camera", first: "2026-10-29T09:00:00", last: "2026-10-29T10:00:01" }], withoutGps: 3, flightCount: 2, unassignedCount: 0, nextOffset: 1 });
  expect(facts.flights).toHaveLength(1);
  expect(facts.flights[0]).toMatchObject({ make: "Maker", model: "Survey", first: "2026-10-29T09:00:00", last: "2026-10-29T09:30:00", clock: "camera", photoCount: 2, excludedPhotoCount: 0 });
  const second = await (await fetch(`${harness.base}/api/projects/${id}/photo-facts?offset=1&limit=1`)).json() as { flights: unknown[]; nextOffset: number | null };
  expect(second.flights).toHaveLength(1);
  expect(second.flights[0]).toMatchObject({ first: "2026-10-29T10:00:01", photoCount: 1 });
  expect(second.nextOffset).toBeNull();
});


test("flight choices survive reopening, retain known photos and disclose newly added photos", async () => {
  await harness.stop();
  const folder = await mkdtemp(join(tmpdir(), "photo-facts-"));
  harness = openHarness({ dataFolder: folder });
  try {
    const id = await createProject();
    await upload(id, "first.tif", timedPhoto("2026:10:29 09:00:00"));
    await upload(id, "second.tif", timedPhoto("2026:10:29 09:30:00"));
    const root = `/api/projects/${id}`;
    const facts = async () => await (await fetch(harness.base + root + "/photo-facts")).json() as { flights: Array<{ id: string; photoCount: number; excludedPhotoCount: number }> };
    const oldId = (await facts()).flights[0]!.id;
    const change = (flightId: string, excluded: boolean) => fetch(harness.base + root + "/flights/" + flightId, { method: "PUT", body: JSON.stringify({ excluded }) });
    expect((await change(oldId, true)).status).toBe(204);
    await harness.stop();
    harness = openHarness({ dataFolder: folder });
    expect((await facts()).flights).toMatchObject([{ id: oldId, photoCount: 2, excludedPhotoCount: 2 }]);
    await upload(id, "third.tif", timedPhoto("2026:10:29 09:45:00"));
    const updated = (await facts()).flights[0]!;
    expect(updated).toMatchObject({ photoCount: 3, excludedPhotoCount: 2 });
    expect(updated.id).not.toBe(oldId);
    expect((await change(oldId, true)).status).toBe(404);
    expect((await change(updated.id, false)).status).toBe(204);
    expect((await facts()).flights[0]!.excludedPhotoCount).toBe(0);
    expect((await change(updated.id, true)).status).toBe(204);
    expect((await fetch(harness.base + root, { method: "DELETE" })).status).toBe(204);
    expect((await fetch(harness.base + root + "/photo-facts")).status).toBe(404);
    const fresh = await createProject();
    await upload(fresh, "first.tif", timedPhoto("2026:10:29 09:00:00"));
    expect(await (await fetch(`${harness.base}/api/projects/${fresh}/photo-facts`)).json()).toMatchObject({ flights: [{ photoCount: 1, excludedPhotoCount: 0 }] });
  } finally {
    await harness.stop();
    await rm(folder, { recursive: true, force: true });
  }
});


function bandPhoto(band: string): Uint8Array {
  const xmp = Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:cam="http://pix4d.com/camera/1.0/" cam:BandName="' + band + '"/></rdf:RDF></x:xmpmeta>');
  const header = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 0]);
  header.writeUInt16BE(xmp.length + 2, 4);
  return Buffer.concat([header, xmp, Buffer.from([0xff, 0xd9])]);
}

test("bands come from the photo XMP, and a supported alias can supply facts for stored RAW content", async () => {
  const id = await createProject();
  const green = bandPhoto("Green");
  await upload(id, "green.raw", green);
  const first = await (await fetch(`${harness.base}/api/projects/${id}/photo-facts`)).json();
  expect(first).toMatchObject({ photoCount: 1, bands: [] });
  await upload(id, "green.jpg", green);
  await upload(id, "red.jpg", bandPhoto("Red"));
  const response = await fetch(`${harness.base}/api/projects/${id}/photo-facts`);
  expect(await response.json()).toMatchObject({ photoCount: 2, duplicates: 1, bands: [{ name: "Green", photoCount: 1 }, { name: "Red", photoCount: 1 }], withoutGps: 2, unassignedCount: 2 });
});

test("metadata preparation stays bounded and selection waits for a complete grouping", async () => {
  const id = await createProject();
  for (let index = 0; index < 34; index++) await upload(id, `photo-${index}.tif`, timedPhoto(`2026:10:29 09:00:${String(index).padStart(2, "0")}`));
  const root = `${harness.base}/api/projects/${id}`;
  const first = await (await fetch(root + "/photo-facts")).json() as { pendingMetadata: number; flights: Array<{ id: string; photoCount: number }> };
  expect(first.pendingMetadata).toBe(2);
  expect(first.flights[0]!.photoCount).toBe(32);
  const changed = await fetch(`${root}/flights/${first.flights[0]!.id}`, { method: "PUT", body: JSON.stringify({ excluded: true }) });
  expect(changed.status).toBe(404);
  const final = await (await fetch(root + "/photo-facts")).json();
  expect(final).toMatchObject({ photoCount: 34, pendingMetadata: 0, flights: [{ photoCount: 34, excludedPhotoCount: 0 }] });
});

test("facts and selections reject invalid requests and share the project deletion gate", async () => {
  const id = await createProject();
  await upload(id, "first.tif", timedPhoto("2026:10:29 09:00:00"));
  const root = `${harness.base}/api/projects/${id}`;
  const facts = await (await fetch(root + "/photo-facts")).json() as { flights: Array<{ id: string }> };
  for (const query of ["?limit=101", "?offset=-1", "?offset=9007199254740992", "?limit=0"]) expect((await fetch(root + "/photo-facts" + query)).status).toBe(400);
  for (const body of [{ excluded: "yes" }, { excluded: true, other: true }]) expect((await fetch(`${root}/flights/${facts.flights[0]!.id}`, { method: "PUT", body: JSON.stringify(body) })).status).toBe(400);
  expect((await fetch(`${root}/flights/unknown`, { method: "PUT", body: JSON.stringify({ excluded: true }) })).status).toBe(404);
  expect((await fetch(`${harness.base}/api/projects/99999/photo-facts`)).status).toBe(404);
  const hold = harness.ctx.projectDeletion.beginWrite(id)!;
  try { expect((await fetch(root, { method: "DELETE" })).status).toBe(409); }
  finally { hold(); }
  expect((await fetch(root, { method: "DELETE" })).status).toBe(204);
});


test("upgrading a version 6 project reads its existing photos without changing stored content", async () => {
  await harness.stop();
  const folder = await mkdtemp(join(tmpdir(), "photo-facts-upgrade-"));
  const db = new Database(join(folder, DATABASE_FILE), { strict: true });
  let legacyOpen = true;
  try {
    applyMigrations(db, migrations.slice(0, 6));
    const id = new ProjectStore(db).create("Field", "Keep these notes").id;
    const store = new UploadStore(db, folder);
    const bytes = timedPhoto("2026:10:29 09:00:00");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const session = store.create(id, { name: "first.tif", size: bytes.length, sha256 });
    expect(await store.chunk(id, session.id, 0, sha256, new Response(new Uint8Array(bytes)).body)).toBe("ok");
    expect(await store.complete(id, session.id)).toBe("ok");
    db.close(); legacyOpen = false;
    harness = openHarness({ dataFolder: folder });
    expect(await (await fetch(`${harness.base}/api/projects/${id}`)).json()).toMatchObject({ name: "Field", notes: "Keep these notes", photoCount: 1 });
    expect(await (await fetch(`${harness.base}/api/projects/${id}/photos`)).json()).toMatchObject({ files: [{ name: "first.tif", sha256, size: 112 }] });
    expect(await (await fetch(`${harness.base}/api/projects/${id}/photo-facts`)).json()).toMatchObject({ photoCount: 1, cameras: [{ make: "Maker", model: "Survey", photoCount: 1 }], pendingMetadata: 0 });
  } finally {
    if (legacyOpen) db.close();
    await harness.stop();
    await rm(folder, { recursive: true, force: true });
  }
});
