import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detailedTiff } from "../../test-support/photo-metadata.ts";
import type { ProjectPhotoFactsView, ProjectPhotoPositionsView } from "../../shared/api-types.ts";
import { lanTest, openHarness, type Harness } from "../testing/harness.ts";

let harness: Harness;
beforeEach(() => { harness = openHarness(); });
const folders: string[] = [];
afterEach(async () => {
  await harness.stop();
  for (const path of folders.splice(0)) await rm(path, { recursive: true, force: true });
});
async function scratch(): Promise<string> { const path = await mkdtemp(join(tmpdir(), "aidm-photo-visuals-")); folders.push(path); return path; }
function flipped(bytes: Buffer): Buffer { const copy = Buffer.from(bytes); copy.writeUInt8(copy.readUInt8(20) ^ 1, 20); return copy; }
const sha256Of = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function importFolder(id: number, path: string): Promise<void> {
  const response = await fetch(`${harness.base}/api/projects/${id}/import`, { method: "PUT", body: JSON.stringify({ path }) });
  expect(response.status).toBe(200);
}

async function createProject(): Promise<number> {
  const response = await fetch(`${harness.base}/api/projects`, { method: "POST", body: JSON.stringify({ name: "Field", notes: "" }) });
  return (await response.json() as { id: number }).id;
}
async function upload(projectId: number, name: string, bytes: Uint8Array): Promise<string> {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const root = `${harness.base}/api/projects/${projectId}/uploads`;
  const response = await fetch(root, { method: "POST", body: JSON.stringify({ name, size: bytes.length, sha256 }) });
  expect(response.status).toBe(201);
  const session = await response.json() as { id: string; complete: boolean };
  if (!session.complete) {
    expect((await fetch(`${root}/${session.id}/chunks/0`, { method: "PUT", headers: { "x-chunk-sha256": sha256 }, body: new Uint8Array(bytes) })).status).toBe(204);
    expect((await fetch(`${root}/${session.id}/complete`, { method: "POST" })).status).toBe(200);
  }
  return sha256;
}

/** Not a real picture: the server must hand these bytes back untouched. */
const THUMBNAIL = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("embedded preview, not decoded"), Buffer.from([0xff, 0xd9])]);

/** A little-endian TIFF whose second image directory points at a JPEG preview. */
function tiffWithThumbnail(thumbnail: Buffer): Buffer {
  const head = Buffer.alloc(8 + 2 + 12 + 4);
  head.write("II", 0); head.writeUInt16LE(42, 2); head.writeUInt32LE(8, 4);
  head.writeUInt16LE(1, 8);
  head.writeUInt16LE(0x0100, 10); head.writeUInt16LE(4, 12); head.writeUInt32LE(1, 14); head.writeUInt32LE(640, 18);
  head.writeUInt32LE(head.length, 22);
  const second = Buffer.alloc(2 + 3 * 12 + 4);
  second.writeUInt16LE(3, 0);
  const entry = (at: number, tag: number, type: number, value: number) => {
    second.writeUInt16LE(tag, at); second.writeUInt16LE(type, at + 2); second.writeUInt32LE(1, at + 4); second.writeUInt32LE(value, at + 8);
  };
  entry(2, 0x0103, 3, 6); entry(14, 0x0201, 4, head.length + second.length); entry(26, 0x0202, 4, thumbnail.length);
  return Buffer.concat([head, second, thumbnail]);
}

test("the thumbnail of an uploaded photo is the embedded preview, byte for byte", async () => {
  const id = await createProject();
  const sha256 = await upload(id, "a.tif", tiffWithThumbnail(THUMBNAIL));
  const response = await fetch(`${harness.base}/api/projects/${id}/photos/${sha256}/thumbnail`);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/jpeg");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("cache-control")).toContain("private");
  expect(Buffer.from(await response.arrayBuffer()).equals(THUMBNAIL)).toBe(true);
});

function jpegWithExif(tiff: Buffer, before: Buffer[] = []): Buffer {
  const segment = (marker: number, data: Buffer) => {
    const header = Buffer.alloc(4); header.writeUInt16BE(0xff00 | marker, 0); header.writeUInt16BE(data.length + 2, 2);
    return Buffer.concat([header, data]);
  };
  return Buffer.concat([Buffer.from([0xff, 0xd8]), ...before, segment(0xe1, Buffer.concat([Buffer.from("Exif\0\0"), tiff])), Buffer.from([0xff, 0xd9])]);
}
async function thumbnailOf(id: number, sha256: string): Promise<Response> {
  return fetch(`${harness.base}/api/projects/${id}/photos/${sha256}/thumbnail`);
}

test("the thumbnail is found in the Exif segment of a JPEG after other segments", async () => {
  const id = await createProject();
  const comment = Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 0x07]), Buffer.from("hello")]);
  const sha256 = await upload(id, "a.jpg", jpegWithExif(tiffWithThumbnail(THUMBNAIL), [comment]));
  const response = await thumbnailOf(id, sha256);
  expect(response.status).toBe(200);
  expect(Buffer.from(await response.arrayBuffer()).equals(THUMBNAIL)).toBe(true);
});

const NOT_FOUND = { error: { code: "api.not_found", data: {} } };
const IFD1 = 8 + 2 + 12 + 4;
function patched(change: (bytes: Buffer) => void, bytes = tiffWithThumbnail(THUMBNAIL)): Buffer { change(bytes); return bytes; }

/** The first directory carries the preview tags and its next pointer leads back to itself. */
function selfReferencing(): Buffer {
  const bytes = Buffer.alloc(8 + 2 + 3 * 12 + 4 + THUMBNAIL.length);
  bytes.write("II", 0); bytes.writeUInt16LE(42, 2); bytes.writeUInt32LE(8, 4); bytes.writeUInt16LE(3, 8);
  const entry = (at: number, tag: number, type: number, value: number) => {
    bytes.writeUInt16LE(tag, at); bytes.writeUInt16LE(type, at + 2); bytes.writeUInt32LE(1, at + 4); bytes.writeUInt32LE(value, at + 8);
  };
  entry(10, 0x0103, 3, 6); entry(22, 0x0201, 4, 8 + 2 + 3 * 12 + 4); entry(34, 0x0202, 4, THUMBNAIL.length);
  bytes.writeUInt32LE(8, 46);
  THUMBNAIL.copy(bytes, 50);
  return bytes;
}
const unusable: Array<[string, Buffer]> = [
  ["no second image directory", Buffer.concat([Buffer.from("II"), Buffer.from([42, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0])])],
  ["a preview that is not a JPEG", tiffWithThumbnail(Buffer.from("this is not a picture"))],
  ["a preview offset past the end of the file", patched(b => b.writeUInt32LE(b.length, IFD1 + 2 + 14))],
  ["a preview length that would overflow", patched(b => b.writeUInt32LE(0xffffffff, IFD1 + 2 + 26))],
  ["a preview length of zero", patched(b => b.writeUInt32LE(0, IFD1 + 2 + 26))],
  ["a preview over the size limit", tiffWithThumbnail(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(600 * 1024)]))],
  ["a preview that is not JPEG compressed", patched(b => b.writeUInt16LE(1, IFD1 + 2 + 8))],
  ["a second directory that points back to the first", selfReferencing()],
  ["a second directory past the end of the file", patched(b => b.writeUInt32LE(0x7fffffff, 22))],
  ["a second directory with too many entries", patched(b => b.writeUInt16LE(600, IFD1), Buffer.concat([tiffWithThumbnail(THUMBNAIL), Buffer.alloc(16 * 1024)]))],
  ["a preview offset tag that is not one number", patched(b => b.writeUInt32LE(2, IFD1 + 2 + 12 + 4))],
];
test.each(unusable)("no thumbnail is served for %s", async (_name, bytes) => {
  const id = await createProject();
  const response = await thumbnailOf(id, await upload(id, "a.tif", bytes));
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual(NOT_FOUND);
});

test("a JPEG whose preview reaches past its Exif segment or whose segment is cut short has no thumbnail", async () => {
  const id = await createProject();
  const whole = tiffWithThumbnail(THUMBNAIL);
  const outside = jpegWithExif(whole.subarray(0, whole.length - 4)); // the preview is four bytes short of its bytes
  const trailing = Buffer.concat([outside, Buffer.from([0xff, 0xd9, 0xff, 0xd9, 0xff, 0xd9])]);
  const cut = jpegWithExif(whole).subarray(0, 30);
  for (const bytes of [trailing, cut]) {
    const response = await thumbnailOf(id, await upload(id, `${bytes.length}.jpg`, bytes));
    expect(response.status).toBe(404);
  }
});

test("a thumbnail in big-endian Exif is served as it is", async () => {
  const id = await createProject();
  const big = Buffer.alloc(8 + 2 + 4);
  big.write("MM", 0); big.writeUInt16BE(42, 2); big.writeUInt32BE(8, 4); big.writeUInt16BE(0, 8); big.writeUInt32BE(14, 10);
  const second = Buffer.alloc(2 + 2 * 12 + 4);
  second.writeUInt16BE(2, 0);
  for (const [at, tag, value] of [[2, 0x0201, 14 + second.length], [14, 0x0202, THUMBNAIL.length]] as const) {
    second.writeUInt16BE(tag, at); second.writeUInt16BE(4, at + 2); second.writeUInt32BE(1, at + 4); second.writeUInt32BE(value, at + 8);
  }
  const response = await thumbnailOf(id, await upload(id, "a.jpg", jpegWithExif(Buffer.concat([big, second, THUMBNAIL]))));
  expect(response.status).toBe(200);
  expect(Buffer.from(await response.arrayBuffer()).equals(THUMBNAIL)).toBe(true);
});

test("the thumbnail route refuses unknown projects, malformed hashes, hashes the project does not hold and the sample project", async () => {
  const id = await createProject();
  const sha256 = await upload(id, "a.tif", tiffWithThumbnail(THUMBNAIL));
  const video = await upload(id, "flight.mp4", tiffWithThumbnail(THUMBNAIL).subarray(0, 40));
  const other = await createProject();
  expect((await thumbnailOf(id + 100, sha256)).status).toBe(404);
  expect((await thumbnailOf(0 as number, sha256)).status).toBe(404);
  for (const bad of ["abc", sha256.toUpperCase(), sha256.slice(1), `${sha256}0`, "..%2f..%2fetc"]) {
    const response = await fetch(`${harness.base}/api/projects/${id}/photos/${bad}/thumbnail`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(NOT_FOUND);
  }
  expect((await thumbnailOf(other, sha256)).status).toBe(404);
  expect((await thumbnailOf(id, video)).status).toBe(404);
  expect((await thumbnailOf(id, "0".repeat(64))).status).toBe(404);
  const sample = await thumbnailOf(harness.ctx.projects.sampleId() ?? -1, sha256);
  expect(sample.status).toBe(409);
  expect(await sample.json()).toMatchObject({ error: { code: "project.sample_photos_forbidden" } });
});

test("the thumbnail of an imported photo comes from the file in the chosen folder", async () => {
  const id = await createProject(), source = await scratch();
  const bytes = tiffWithThumbnail(THUMBNAIL);
  await mkdir(join(source, "nested"));
  await writeFile(join(source, "nested", "a.tif"), bytes);
  await importFolder(id, source);
  const response = await thumbnailOf(id, sha256Of(bytes));
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/jpeg");
  expect(Buffer.from(await response.arrayBuffer()).equals(THUMBNAIL)).toBe(true);
});

async function importedPhoto(): Promise<{ id: number; source: string; path: string; sha256: string; bytes: Buffer }> {
  const id = await createProject(), source = await scratch();
  const bytes = tiffWithThumbnail(THUMBNAIL), path = join(source, "a.tif");
  await writeFile(path, bytes);
  await importFolder(id, source);
  return { id, source, path, sha256: sha256Of(bytes), bytes };
}
async function expectRefused(id: number, sha256: string, code: string): Promise<void> {
  const response = await thumbnailOf(id, sha256);
  expect(response.status).toBe(409);
  expect(response.headers.get("content-type")).not.toBe("image/jpeg");
  expect(await response.json()).toMatchObject({ error: { code } });
}

test("an imported photo that changed, was swapped for a link or vanished gives no thumbnail, even after one was served", async () => {
  const one = await importedPhoto();
  expect((await thumbnailOf(one.id, one.sha256)).status).toBe(200);
  const changed = flipped(one.bytes);
  await writeFile(one.path, changed);
  await expectRefused(one.id, one.sha256, "import.changed");

  const two = await importedPhoto();
  expect((await thumbnailOf(two.id, two.sha256)).status).toBe(200);
  const outside = await scratch(); await writeFile(join(outside, "other.tif"), two.bytes);
  await rm(two.path); await symlink(join(outside, "other.tif"), two.path);
  await expectRefused(two.id, two.sha256, "import.changed");

  const three = await importedPhoto();
  expect((await thumbnailOf(three.id, three.sha256)).status).toBe(200);
  await rm(three.path);
  await expectRefused(three.id, three.sha256, "import.missing");

  const four = await importedPhoto();
  await rename(four.source, `${four.source}-moved`); folders.push(`${four.source}-moved`);
  await expectRefused(four.id, four.sha256, "import.missing");
});

test("an imported photo with the same size and time but different bytes is caught", async () => {
  const { id, path, sha256, bytes } = await importedPhoto();
  const before = (await Bun.file(path).stat());
  const forged = flipped(bytes);
  await writeFile(path, forged);
  await utimes(path, before.atime, before.mtime);
  await expectRefused(id, sha256, "import.changed");
});

test("a thumbnail already served is kept in memory, and a photo without one is remembered too", async () => {
  const id = await createProject();
  const withPreview = await upload(id, "a.tif", tiffWithThumbnail(THUMBNAIL));
  const without = await upload(id, "b.tif", Buffer.from("II*\0\0\0\0\0"));
  expect((await thumbnailOf(id, withPreview)).status).toBe(200);
  expect((await thumbnailOf(id, without)).status).toBe(404);
  await rm(join(harness.dataFolder, "projects", String(id), "files"), { recursive: true });
  const again = await thumbnailOf(id, withPreview);
  expect(again.status).toBe(200);
  expect(Buffer.from(await again.arrayBuffer()).equals(THUMBNAIL)).toBe(true);
  expect((await thumbnailOf(id, without)).status).toBe(404);
});

test("a thumbnail is not served while the import is being chosen", async () => {
  const { id, sha256 } = await importedPhoto();
  harness.ctx.imports.isBusy = () => true;
  await expectRefused(id, sha256, "import.busy");
});

function positionsOf(id: number, query = ""): Promise<Response> {
  return fetch(`${harness.base}/api/projects/${id}/photo-positions${query}`);
}
function flightPhoto(time: string): Buffer {
  const bytes = detailedTiff(true);
  bytes.write(`${time}\0`, 310);
  return bytes;
}
const bySha = (a: { sha256: string }, b: { sha256: string }) => a.sha256.localeCompare(b.sha256);

test("positions list every photo with its place, time and flight, those without a position too", async () => {
  const id = await createProject();
  const morning = flightPhoto("2024:02:29 09:00:00"), later = flightPhoto("2024:02:29 12:34:56");
  const noGps = tiffWithThumbnail(THUMBNAIL);
  const shas = {
    morning: await upload(id, "morning.tif", morning), later: await upload(id, "later.tif", later), noGps: await upload(id, "plain.tif", noGps),
  };
  await upload(id, "flight.mp4", Buffer.from("video")); await upload(id, "duplicate.tif", noGps);
  const response = await positionsOf(id);
  expect(response.status).toBe(200);
  const view = await response.json() as ProjectPhotoPositionsView;
  expect(view.photos.map(photo => photo.sha256)).toEqual(Object.values(shas).sort());
  expect(view).toMatchObject({ nextOffset: null, pendingMetadata: 0, localImportAllowed: true });
  const facts = await (await fetch(`${harness.base}/api/projects/${id}/photo-facts`)).json() as ProjectPhotoFactsView;
  expect(facts.flights).toHaveLength(2);
  const flightIds = facts.flights.map(flight => flight.id);
  const photo = (sha256: string) => view.photos.find(candidate => candidate.sha256 === sha256)!;
  expect(photo(shas.morning)).toEqual({ sha256: shas.morning, name: "morning.tif", make: null, model: "Model", flightId: flightIds[0]!, latitude: -12.5, longitude: -45.25, altitude: -25, captureTime: "2024-02-29T09:00:00.123+05:30", excluded: false });
  expect(photo(shas.later)).toMatchObject({ name: "later.tif", flightId: flightIds[1], latitude: -12.5, captureTime: "2024-02-29T12:34:56.123+05:30" });
  expect(photo(shas.noGps)).toEqual({ sha256: shas.noGps, name: "duplicate.tif", make: null, model: null, flightId: null, latitude: null, longitude: null, altitude: null, captureTime: null, excluded: false });
});

test("an empty project has no positions and still says whether a local folder can be chosen", async () => {
  const id = await createProject();
  const response = await positionsOf(id);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ photos: [], nextOffset: null, pendingMetadata: 0, localImportAllowed: true });
});

test("positions are paged in a stable order without gaps or repeats", async () => {
  const id = await createProject();
  for (let index = 0; index < 5; index++) await upload(id, `p${index}.tif`, flightPhoto(`2024:02:29 0${index}:00:00`));
  const everything = await (await positionsOf(id)).json() as ProjectPhotoPositionsView;
  expect(everything.photos).toHaveLength(5);
  expect(everything.photos.map(photo => photo.sha256)).toEqual(everything.photos.map(photo => photo.sha256).sort());
  const seen: string[] = [];
  let next: number | null = 0, pages = 0;
  while (next !== null) {
    const page = await (await positionsOf(id, `?offset=${next}&limit=2`)).json() as ProjectPhotoPositionsView;
    expect(page.photos.length).toBeLessThanOrEqual(2);
    seen.push(...page.photos.map(photo => photo.sha256));
    next = page.nextOffset; pages++;
  }
  expect(pages).toBe(3);
  expect(seen).toEqual(everything.photos.map(photo => photo.sha256));
  const beyond = await (await positionsOf(id, "?offset=50")).json() as ProjectPhotoPositionsView;
  expect(beyond).toMatchObject({ photos: [], nextOffset: null });
});

test("positions stop at 100 photos a page and refuse bad paging, unknown projects and the sample project", async () => {
  const id = await createProject();
  for (const query of ["?limit=0", "?limit=101", "?limit=x", "?offset=-1", "?offset=01", "?offset=1.5", "?offset=99999999999999999999"]) {
    const response = await positionsOf(id, query);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "api.invalid_body" } });
  }
  expect((await positionsOf(id, "?limit=100")).status).toBe(200);
  expect((await positionsOf(id + 100)).status).toBe(404);
  expect((await positionsOf(0)).status).toBe(404);
  const sample = await positionsOf(harness.ctx.projects.sampleId() ?? -1);
  expect(sample.status).toBe(409);
  expect(await sample.json()).toMatchObject({ error: { code: "project.sample_photos_forbidden" } });
});

test("positions report photos whose facts are still to be read and keep reading them", async () => {
  const id = await createProject();
  for (let index = 0; index < 40; index++) await upload(id, `p${index}.tif`, Buffer.concat([flightPhoto("2024:02:29 09:00:00"), Buffer.from([index])]));
  const first = await (await positionsOf(id, "?limit=100")).json() as ProjectPhotoPositionsView;
  expect(first.pendingMetadata).toBe(8);
  expect(first.photos.filter(photo => photo.captureTime === null)).toHaveLength(8);
  const second = await (await positionsOf(id, "?limit=100")).json() as ProjectPhotoPositionsView;
  expect(second.pendingMetadata).toBe(0);
  expect(second.photos.every(photo => photo.latitude === -12.5)).toBe(true);
});

test("a flight left out is shown as excluded on each of its photos and back when it returns", async () => {
  const id = await createProject();
  const morning = await upload(id, "morning.tif", flightPhoto("2024:02:29 09:00:00"));
  const later = await upload(id, "later.tif", flightPhoto("2024:02:29 12:34:56"));
  const view = async () => (await (await positionsOf(id)).json() as ProjectPhotoPositionsView).photos;
  const flightId = (await view()).find(photo => photo.sha256 === morning)!.flightId!;
  const toggle = (excluded: boolean) => fetch(`${harness.base}/api/projects/${id}/flights/${flightId}`, { method: "PUT", body: JSON.stringify({ excluded }) });
  expect((await toggle(true)).status).toBe(204);
  expect((await view()).map(photo => [photo.sha256, photo.excluded, photo.flightId === flightId])).toEqual(
    [[morning, true, true], [later, false, false]].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  expect((await toggle(false)).status).toBe(204);
  expect((await view()).every(photo => !photo.excluded)).toBe(true);
});

test("positions of an imported folder list its photos with and without a position, and follow a left out flight", async () => {
  const id = await createProject(), source = await scratch();
  const placed = flightPhoto("2024:02:29 09:00:00"), plain = tiffWithThumbnail(THUMBNAIL);
  await mkdir(join(source, "nested"));
  await writeFile(join(source, "nested", "placed.tif"), placed); await writeFile(join(source, "plain.tif"), plain);
  await writeFile(join(source, "clip.mp4"), "video");
  await importFolder(id, source);
  const view = async () => await (await positionsOf(id)).json() as ProjectPhotoPositionsView;
  const first = await view();
  expect(first).toMatchObject({ nextOffset: null, pendingMetadata: 0, localImportAllowed: true });
  expect(first.photos.map(photo => [photo.name, photo.latitude, photo.longitude, photo.excluded]).sort()).toEqual([
    [join("nested", "placed.tif"), -12.5, -45.25, false], ["plain.tif", null, null, false],
  ]);
  const flightId = first.photos.find(photo => photo.name === "plain.tif")!.flightId;
  expect(flightId).toBeNull();
  const placedFlight = first.photos.find(photo => photo.sha256 === sha256Of(placed))!.flightId!;
  expect((await fetch(`${harness.base}/api/projects/${id}/flights/${placedFlight}`, { method: "PUT", body: JSON.stringify({ excluded: true }) })).status).toBe(204);
  expect((await view()).photos.filter(photo => photo.excluded).map(photo => photo.sha256)).toEqual([sha256Of(placed)]);
});

test("positions of an imported folder that changed or vanished are refused with the import codes", async () => {
  const one = await importedPhoto();
  expect((await positionsOf(one.id)).status).toBe(200);
  await writeFile(one.path, Buffer.concat([one.bytes, Buffer.from([0])]));
  const changed = await positionsOf(one.id);
  expect(changed.status).toBe(409);
  expect(await changed.json()).toMatchObject({ error: { code: "import.changed" } });

  const two = await importedPhoto();
  await rm(two.source, { recursive: true });
  const missing = await positionsOf(two.id);
  expect(missing.status).toBe(409);
  expect(await missing.json()).toMatchObject({ error: { code: "import.missing" } });
});

test("positions are refused while the import is being chosen", async () => {
  const { id } = await importedPhoto();
  harness.ctx.imports.isBusy = () => true;
  const response = await positionsOf(id);
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: "import.busy" } });
});

lanTest("a remote browser is told it cannot choose a local folder, with photos or without", async address => {
  await harness.stop();
  harness = openHarness({ hostname: "0.0.0.0" });
  const empty = await createProject(), full = await createProject();
  await upload(full, "a.tif", tiffWithThumbnail(THUMBNAIL));
  const passphrase = "photo-visuals-test";
  expect((await fetch(`${harness.base}/api/settings/lan`, { method: "PUT", body: JSON.stringify({ enabled: true, passphrase }) })).status).toBe(200);
  const remote = `http://${address}:${harness.port}`;
  const login = await fetch(`${remote}/api/auth/login`, { method: "POST", body: JSON.stringify({ passphrase }) });
  expect(login.status).toBe(204);
  // A proxy header must not make a remote browser look local.
  const headers = { cookie: (login.headers.get("set-cookie") ?? "").split(";")[0]!, "x-forwarded-for": "127.0.0.1", "x-real-ip": "127.0.0.1" };
  expect(await (await fetch(`${remote}/api/projects/${empty}/photo-positions`, { headers })).json()).toEqual({ photos: [], nextOffset: null, pendingMetadata: 0, localImportAllowed: false });
  const view = await (await fetch(`${remote}/api/projects/${full}/photo-positions`, { headers })).json() as ProjectPhotoPositionsView;
  expect(view.photos).toHaveLength(1);
  expect(view.localImportAllowed).toBe(false);
  const local = await (await positionsOf(full)).json() as ProjectPhotoPositionsView;
  expect(local.localImportAllowed).toBe(true);
});
