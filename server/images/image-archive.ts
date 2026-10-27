import { readFileSync } from "node:fs";
import { join } from "node:path";
import { blobPath, type DownloadedImage } from "./image-download.ts";

/**
 * Which archive a runtime's load command reads. "oci": an OCI image layout
 * in a tar (Apple's `container image load` reads only this). "oci+docker":
 * the same with the `manifest.json` of `docker save` next to it, the form
 * `docker save` itself writes since Docker 25. Docker's classic image store
 * reads only `manifest.json`, its containerd store prefers the layout.
 */
export type ArchiveFormat = "oci" | "oci+docker";

const BLOCK = 512;
/** The largest size the 11 octal digits of a tar header hold. Bigger entries use the base-256 form. */
const OCTAL_MAX = 0o77777777777;

interface Entry {
  name: string;
  size: number;
  /** The bytes, for a small entry made here. */
  bytes?: Uint8Array;
  /** The file on disk, for a blob. */
  path?: string;
}

function writeText(header: Uint8Array, offset: number, length: number, text: string): void {
  header.set(new TextEncoder().encode(text).subarray(0, length), offset);
}

function writeOctal(header: Uint8Array, offset: number, length: number, value: number): void {
  writeText(header, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
}

/** The ustar header of one regular file. Times and owners are zero, so the same image always makes the same archive. */
export function tarHeader(name: string, size: number): Uint8Array {
  if (new TextEncoder().encode(name).length > 100) throw new Error(`Name too long for a tar header: ${name}`);
  const header = new Uint8Array(BLOCK);
  writeText(header, 0, 100, name);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  if (size <= OCTAL_MAX) {
    writeOctal(header, 124, 12, size);
  } else {
    // The base-256 form that GNU tar, Go and libarchive read: a set top bit, then the size big-endian.
    header[124] = 0x80;
    let rest = BigInt(size);
    for (let at = 135; at > 124; at--) {
      header[at] = Number(rest & 0xffn);
      rest >>= 8n;
    }
  }
  writeOctal(header, 136, 12, 0);
  // The checksum is counted with its own field as spaces.
  header.fill(0x20, 148, 156);
  header[156] = 0x30; // "0": a regular file
  writeText(header, 257, 6, "ustar\0");
  writeText(header, 263, 2, "00");
  const sum = header.reduce((total, byte) => total + byte, 0);
  writeText(header, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

/** The `manifest.json` of `docker save`: the config, the layers in order and the name. */
export function dockerSaveManifest(image: DownloadedImage): Uint8Array {
  const entry = {
    Config: `blobs/sha256/${image.config.digest.slice(7)}`,
    RepoTags: [image.name],
    Layers: image.layers.map((layer) => `blobs/sha256/${layer.digest.slice(7)}`),
  };
  return new TextEncoder().encode(`${JSON.stringify([entry])}\n`);
}

function entries(image: DownloadedImage, format: ArchiveFormat): Entry[] {
  const small = (name: string, bytes: Uint8Array): Entry => ({ name, size: bytes.length, bytes });
  const read = (name: string) => new Uint8Array(readFileSync(join(image.folder, name)));
  const list: Entry[] = [small("oci-layout", read("oci-layout")), small("index.json", read("index.json"))];
  if (format === "oci+docker") list.push(small("manifest.json", dockerSaveManifest(image)));
  // The layers the runtime already holds were not downloaded, so they are not in the archive; the manifests still name them.
  const seen = new Set<string>(image.skipped.map((blob) => blob.digest));
  for (const blob of [image.manifest, image.config, ...image.layers]) {
    if (seen.has(blob.digest)) continue;
    seen.add(blob.digest);
    list.push({ name: `blobs/sha256/${blob.digest.slice(7)}`, size: blob.size, path: blobPath(image.folder, blob.digest) });
  }
  return list;
}

/** The archive's size in bytes, for a disk check or a progress bar. */
export function archiveSize(image: DownloadedImage, format: ArchiveFormat): number {
  const padded = (size: number) => Math.ceil(size / BLOCK) * BLOCK;
  return entries(image, format).reduce((sum, entry) => sum + BLOCK + padded(entry.size), 0) + 2 * BLOCK;
}

/**
 * The archive as a stream, read from the blobs on disk as it goes, so the
 * disk never holds a second copy of the image. A blob whose size on disk is
 * not the size in the manifest ends the stream with an error.
 */
export function imageArchive(image: DownloadedImage, format: ArchiveFormat): ReadableStream<Uint8Array> {
  const list = entries(image, format);
  let index = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let written = 0;
  let current: Entry | undefined;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        if (reader !== null && current !== undefined) {
          const chunk = await reader.read();
          if (!chunk.done) {
            written += chunk.value.length;
            if (written > current.size) return controller.error(new Error(`${current.name} is larger than its manifest says.`));
            return controller.enqueue(chunk.value);
          }
          reader = null;
          if (written !== current.size) return controller.error(new Error(`${current.name} is smaller than its manifest says.`));
          const pad = (BLOCK - (current.size % BLOCK)) % BLOCK;
          if (pad > 0) return controller.enqueue(new Uint8Array(pad));
          continue;
        }
        current = list[index++];
        if (current === undefined) {
          controller.enqueue(new Uint8Array(2 * BLOCK));
          return controller.close();
        }
        controller.enqueue(tarHeader(current.name, current.size));
        if (current.bytes !== undefined) {
          const pad = (BLOCK - (current.size % BLOCK)) % BLOCK;
          const body = new Uint8Array(current.size + pad);
          body.set(current.bytes);
          controller.enqueue(body);
          continue;
        }
        written = 0;
        reader = Bun.file(current.path ?? "").stream().getReader();
        return;
      }
    },
    async cancel() {
      await reader?.cancel().catch(() => {});
    },
  });
}
