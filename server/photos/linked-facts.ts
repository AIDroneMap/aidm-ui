import type { LinkedPhotoFacts } from "../../shared/link-source.ts";
import { entryBody, readArchive, type ArchiveEntry } from "../results/zip.ts";

const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_RECORDS = 100_000;
const MAX_TEXT = 256;
const MAX_GROUPS = 256;

function optionalText(value: unknown): value is string | null | undefined {
  return value == null || (typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT && !/[\u0000-\u001f\u007f]/.test(value));
}

function coordinate(value: unknown, limit: number): boolean {
  return value == null || (typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= limit);
}

function dimension(value: unknown): boolean {
  return value == null || (typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff);
}

export async function readLinkedPhotoFacts(path: string, indexed?: readonly ArchiveEntry[]): Promise<LinkedPhotoFacts | null> {
  try {
    const entries = indexed ?? await readArchive(path);
    const matches = entries.filter((entry) => entry.name === "images.json");
    if (matches.length !== 1 || matches[0]!.size > MAX_JSON_BYTES) return null;
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of entryBody(path, matches[0]!)) {
      size += chunk.length;
      if (size > MAX_JSON_BYTES) return null;
      chunks.push(chunk);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const records: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!Array.isArray(records) || records.length > MAX_RECORDS) return null;
    const facts: LinkedPhotoFacts = { photoCount: records.length, withoutGps: 0, cameras: [], dimensions: [] };
    const names = new Set<string>();
    const cameras = new Map<string, LinkedPhotoFacts["cameras"][number]>();
    const dimensions = new Map<string, LinkedPhotoFacts["dimensions"][number]>();
    for (const record of records) {
      if (!record || typeof record !== "object" || Array.isArray(record)) return null;
      const { filename, camera_make, camera_model, width, height, latitude, longitude } = record as Record<string, unknown>;
      if (typeof filename !== "string" || !optionalText(filename) || filename === "." || filename === ".." || /[\\/]/.test(filename) || names.has(filename)) return null;
      names.add(filename);
      if (!optionalText(camera_make) || !optionalText(camera_model) || !dimension(width) || !dimension(height) || !coordinate(latitude, 90) || !coordinate(longitude, 180)) return null;
      if (latitude == null || longitude == null) facts.withoutGps++;
      if (camera_make != null || camera_model != null) {
        const make = camera_make ?? null, model = camera_model ?? null;
        const key = JSON.stringify([make, model]);
        let camera = cameras.get(key);
        if (!camera) { camera = { make, model, photoCount: 0 }; cameras.set(key, camera); facts.cameras.push(camera); }
        camera.photoCount++;
      }
      if (cameras.size > MAX_GROUPS) return null;
      if (typeof width === "number" && typeof height === "number") {
        const key = `${width},${height}`;
        let group = dimensions.get(key);
        if (!group) { group = { width, height, photoCount: 0 }; dimensions.set(key, group); facts.dimensions.push(group); }
        group.photoCount++;
        if (dimensions.size > MAX_GROUPS) return null;
      }
    }
    return facts;
  } catch {
    return null;
  }
}
