import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveSize, dockerSaveManifest, imageArchive, tarHeader } from "./image-archive.ts";
import { localName, type DownloadedImage } from "./image-download.ts";

const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
const scratch = mkdtempSync(join(tmpdir(), "aidm-ui-archive-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const digestOf = (bytes: Uint8Array) => `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const hexOf = (digest: string) => digest.slice("sha256:".length);

/**
 * A small image really on disk, as the downloader leaves it: blobs whose
 * contents hash to their digests, `oci-layout` and `index.json`. The layers
 * are listed in the order given, and a layer that is given twice is one blob.
 */
function makeImage(layerBytes: Uint8Array[]): DownloadedImage {
  const folder = mkdtempSync(join(scratch, "image-"));
  mkdirSync(join(folder, "blobs", "sha256"), { recursive: true });
  const put = (bytes: Uint8Array) => {
    const digest = digestOf(bytes);
    writeFileSync(join(folder, "blobs", "sha256", hexOf(digest)), bytes);
    return { digest, size: bytes.length };
  };
  const config = put(new TextEncoder().encode('{"architecture":"amd64","os":"linux"}\n'));
  const layers = layerBytes.map(put);
  const manifest = put(
    new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: OCI_MANIFEST,
        config: { mediaType: "application/vnd.oci.image.config.v1+json", ...config },
        layers: layers.map((layer) => ({ mediaType: "application/vnd.oci.image.layer.v1.tar", ...layer })),
      }),
    ),
  );
  const pinned = { repository: "ghcr.io/aidm-ui-loadtest/tiny", digest: manifest.digest };
  const name = localName(pinned);
  writeFileSync(join(folder, "oci-layout"), '{"imageLayoutVersion":"1.0.0"}\n');
  writeFileSync(
    join(folder, "index.json"),
    JSON.stringify({
      schemaVersion: 2,
      manifests: [{ mediaType: OCI_MANIFEST, ...manifest, annotations: { "io.containerd.image.name": name } }],
    }),
  );
  return { pinned, folder, name, manifest: { ...manifest, mediaType: OCI_MANIFEST }, config, layers, skipped: [] };
}

/** 1000 bytes: not a multiple of 512, so the archive pads it. */
const layerA = () => new Uint8Array(1000).map((_, index) => index % 251);
/** Exactly one block: needs no padding. */
const layerB = () => new Uint8Array(512).map((_, index) => (index * 7) % 256);

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    chunks.push(chunk.value);
  }
  const all = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.length;
  }
  return all;
}

/** The entries of a tar, by the 512-byte headers: name, bytes, and whether the padding after the bytes is all zero. */
function tarEntries(bytes: Uint8Array): Array<{ name: string; body: Uint8Array; paddedWithZeros: boolean }> {
  const entries: Array<{ name: string; body: Uint8Array; paddedWithZeros: boolean }> = [];
  for (let at = 0; at + 512 <= bytes.length; ) {
    const header = bytes.subarray(at, at + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = text(header.subarray(0, header.indexOf(0)));
    const size = Number.parseInt(text(header.subarray(124, 135)), 8);
    at += 512;
    const end = at + Math.ceil(size / 512) * 512;
    entries.push({ name, body: bytes.subarray(at, at + size), paddedWithZeros: bytes.subarray(at + size, end).every((byte) => byte === 0) });
    at = end;
  }
  return entries;
}

describe("the tar header", () => {
  /** The checksum the way a reader counts it: every byte, with the checksum field as spaces. */
  function checksumOf(header: Uint8Array): number {
    const counted = header.slice();
    counted.fill(0x20, 148, 156);
    return counted.reduce((sum, byte) => sum + byte, 0);
  }

  test("a small file has a 512-byte ustar header with its name, a regular-file type and the size in octal", () => {
    const header = tarHeader("blobs/sha256/abc", 1234);
    expect(header.length).toBe(512);
    expect(text(header.subarray(0, header.indexOf(0)))).toBe("blobs/sha256/abc");
    expect(text(header.subarray(257, 262))).toBe("ustar");
    expect(String.fromCharCode(header[156] ?? 0)).toBe("0");
    expect(text(header.subarray(124, 135))).toBe((1234).toString(8).padStart(11, "0"));
    expect(Number.parseInt(text(header.subarray(124, 135)), 8)).toBe(1234);
  });

  test("the checksum field is the right sum, in octal, ending in a zero byte and a space", () => {
    for (const size of [0, 1, 512, 1234, 0o77777777777]) {
      const header = tarHeader("oci-layout", size);
      expect(Number.parseInt(text(header.subarray(148, 154)), 8), `size ${size}`).toBe(checksumOf(header));
      expect(header[154]).toBe(0);
      expect(header[155]).toBe(0x20);
    }
  });

  test("the largest size that fits in eleven octal digits is still written in octal", () => {
    const header = tarHeader("big", 0o77777777777);
    expect(text(header.subarray(124, 135))).toBe("77777777777");
    expect((header[124] ?? 0) & 0x80).toBe(0);
  });

  test("a size above 8 GiB is written in the base-256 form: top bit set in byte 124, then the size big-endian in bytes 125 to 135", () => {
    for (const size of [0o77777777777 + 1, 12 * 1024 ** 3, 2 ** 40 + 5]) {
      const header = tarHeader("big", size);
      expect(header[124], `size ${size}`).toBe(0x80);
      let read = 0n;
      for (let at = 125; at <= 135; at++) read = (read << 8n) | BigInt(header[at] ?? 0);
      expect(Number(read), `size ${size}`).toBe(size);
      expect(Number.parseInt(text(header.subarray(148, 154)), 8), `size ${size}`).toBe(checksumOf(header));
    }
  });

  test("it carries no time and no owner, so the same image always makes the same archive", () => {
    expect(tarHeader("x", 5)).toEqual(tarHeader("x", 5));
    const header = tarHeader("x", 5);
    expect(text(header.subarray(136, 147))).toBe("00000000000");
    expect(text(header.subarray(108, 115))).toBe("0000000");
    expect(text(header.subarray(116, 123))).toBe("0000000");
  });

  test("a name longer than 100 bytes is refused", () => {
    expect(() => tarHeader("a".repeat(101), 1)).toThrow();
    expect(tarHeader("a".repeat(100), 1).length).toBe(512);
  });
});

describe("the docker save manifest", () => {
  test("it lists the config and the layers in order as blob paths, and the name as the one tag", () => {
    const image = makeImage([layerA(), layerB()]);
    const bytes = dockerSaveManifest(image);
    expect(text(bytes).endsWith("\n")).toBe(true);
    expect(JSON.parse(text(bytes))).toEqual([
      {
        Config: `blobs/sha256/${hexOf(image.config.digest)}`,
        RepoTags: [image.name],
        Layers: image.layers.map((layer) => `blobs/sha256/${hexOf(layer.digest)}`),
      },
    ]);
  });

  test("a layer that appears twice is listed twice", () => {
    const image = makeImage([layerA(), layerB(), layerA()]);
    const [entry] = JSON.parse(text(dockerSaveManifest(image))) as Array<{ Layers: string[] }>;
    expect(entry?.Layers).toHaveLength(3);
    expect(entry?.Layers[0]).toBe(entry?.Layers[2]);
  });
});

describe("the image archive", () => {
  test("the oci form holds oci-layout, index.json, then the manifest, config and layer blobs", async () => {
    const image = makeImage([layerA(), layerB()]);
    const bytes = await readAll(imageArchive(image, "oci"));
    expect(tarEntries(bytes).map((entry) => entry.name)).toEqual([
      "oci-layout",
      "index.json",
      ...[image.manifest, image.config, ...image.layers].map((blob) => `blobs/sha256/${hexOf(blob.digest)}`),
    ]);
  });

  test("the oci+docker form adds manifest.json after index.json", async () => {
    const image = makeImage([layerA(), layerB()]);
    const bytes = await readAll(imageArchive(image, "oci+docker"));
    const entries = tarEntries(bytes);
    expect(entries.map((entry) => entry.name)).toEqual([
      "oci-layout",
      "index.json",
      "manifest.json",
      ...[image.manifest, image.config, ...image.layers].map((blob) => `blobs/sha256/${hexOf(blob.digest)}`),
    ]);
    expect(entries[2]?.body).toEqual(dockerSaveManifest(image));
  });

  test("every entry carries the bytes of its file, and the blobs hash to the digest in their name", async () => {
    const image = makeImage([layerA(), layerB()]);
    const entries = tarEntries(await readAll(imageArchive(image, "oci+docker")));
    expect(entries[0]?.body).toEqual(new Uint8Array(readFileSync(join(image.folder, "oci-layout"))));
    expect(entries[1]?.body).toEqual(new Uint8Array(readFileSync(join(image.folder, "index.json"))));
    for (const entry of entries.filter((entry) => entry.name.startsWith("blobs/sha256/"))) {
      expect(digestOf(entry.body), entry.name).toBe(`sha256:${entry.name.slice("blobs/sha256/".length)}`);
    }
  });

  test("each entry is padded with zeros to a whole block, and the archive ends in two zero blocks", async () => {
    const image = makeImage([layerA(), layerB()]);
    for (const format of ["oci", "oci+docker"] as const) {
      const bytes = await readAll(imageArchive(image, format));
      expect(bytes.length % 512, format).toBe(0);
      expect(bytes.subarray(bytes.length - 1024).every((byte) => byte === 0), format).toBe(true);
      const entries = tarEntries(bytes);
      expect(entries.every((entry) => entry.paddedWithZeros), format).toBe(true);
      // Headers, padded data and the two closing blocks add up to the whole archive.
      const used = entries.reduce((sum, entry) => sum + 512 + Math.ceil(entry.body.length / 512) * 512, 0);
      expect(bytes.length, format).toBe(used + 1024);
    }
  });

  test("its length is archiveSize, in both forms", async () => {
    const image = makeImage([layerA(), layerB()]);
    for (const format of ["oci", "oci+docker"] as const) {
      const bytes = await readAll(imageArchive(image, format));
      expect(bytes.length, format).toBe(archiveSize(image, format));
    }
    expect(archiveSize(image, "oci+docker")).toBeGreaterThan(archiveSize(image, "oci"));
  });

  test("a layer that appears twice is written once", async () => {
    const image = makeImage([layerA(), layerB(), layerA()]);
    const bytes = await readAll(imageArchive(image, "oci+docker"));
    const names = tarEntries(bytes).map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.filter((name) => name.startsWith("blobs/sha256/"))).toHaveLength(4);
    expect(bytes.length).toBe(archiveSize(image, "oci+docker"));
  });

  test("the layers the runtime already holds are left out of the archive, but docker's manifest.json still lists every layer", async () => {
    const image = makeImage([layerA(), layerB()]);
    const [lower, top] = image.layers;
    // As the downloader leaves it: the skipped layer is not on disk.
    rmSync(join(image.folder, "blobs", "sha256", hexOf(lower?.digest ?? "")));
    const skipped = { ...image, skipped: lower === undefined ? [] : [lower] };
    for (const format of ["oci", "oci+docker"] as const) {
      const bytes = await readAll(imageArchive(skipped, format));
      const entries = tarEntries(bytes);
      expect(entries.map((entry) => entry.name).filter((name) => name.startsWith("blobs/sha256/")), format).toEqual(
        [image.manifest, image.config, top].map((blob) => `blobs/sha256/${hexOf(blob?.digest ?? "")}`),
      );
      expect(bytes.length, format).toBe(archiveSize(skipped, format));
      if (format === "oci+docker") {
        const [entry] = JSON.parse(text(entries.find((candidate) => candidate.name === "manifest.json")?.body ?? new Uint8Array())) as Array<{ Layers: string[] }>;
        expect(entry?.Layers).toEqual(image.layers.map((layer) => `blobs/sha256/${hexOf(layer.digest)}`));
      }
    }
  });

  test("a blob file shorter than its manifest size makes the stream error", async () => {
    const image = makeImage([layerA(), layerB()]);
    const layer = image.layers[0];
    truncateSync(join(image.folder, "blobs", "sha256", hexOf(layer?.digest ?? "")), 600);
    await expect(readAll(imageArchive(image, "oci"))).rejects.toThrow(/smaller than its manifest says/);
  });

  test("a blob file longer than its manifest size makes the stream error", async () => {
    const image = makeImage([layerA(), layerB()]);
    const layer = image.layers[0];
    writeFileSync(join(image.folder, "blobs", "sha256", hexOf(layer?.digest ?? "")), new Uint8Array(1500));
    await expect(readAll(imageArchive(image, "oci"))).rejects.toThrow(/larger than its manifest says/);
  });

  test("a blob file that is missing is an error when the archive is read", async () => {
    const image = makeImage([layerA()]);
    rmSync(join(image.folder, "blobs", "sha256", hexOf(image.config.digest)));
    await expect(readAll(imageArchive(image, "oci"))).rejects.toThrow();
  });

  // Not a requirement: the check above reads the tar headers by hand. When tar is on the PATH it also reads the archive.
  test.skipIf(Bun.which("tar") === null)("tar lists the archive and finds the entries in order", async () => {
    const image = makeImage([layerA(), layerB()]);
    const file = join(image.folder, "..", `${Bun.randomUUIDv7()}.tar`);
    writeFileSync(file, await readAll(imageArchive(image, "oci+docker")));
    const listing = Bun.spawnSync(["tar", "-tf", file]);
    expect(listing.exitCode).toBe(0);
    expect(text(listing.stdout).trim().split("\n")).toEqual([
      "oci-layout",
      "index.json",
      "manifest.json",
      ...[image.manifest, image.config, ...image.layers].map((blob) => `blobs/sha256/${hexOf(blob.digest)}`),
    ]);
  });
});
