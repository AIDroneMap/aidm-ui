import type { ApiError } from "../../shared/api-error.ts";
import { VARIANT_IDS, type VariantId } from "../../shared/api-types.ts";
import { isReadableVersion } from "../engines/versions.ts";

export type ManifestVariant =
  | {
      kind: "container";
      /** The image without a tag, such as "ghcr.io/aidronemap/aidm-api". */
      image: string;
      /** "sha256:" and 64 lowercase hex digits. */
      digest: string;
      /** Bytes to download. */
      size: number;
      gpu: boolean;
      /**
       * The task API in the image can listen on a Unix socket named in its
       * config file (AIDroneMap/aidm-api#34). On a Mac aidm-ui then reaches it
       * through the socket and publishes no port (ADR 0006). Absent: false.
       */
      taskApiSocket?: boolean;
    }
  | {
      kind: "native";
      /** An https address of the archive. */
      url: string;
      /** Bytes to download. */
      size: number;
      sha256: string;
      gpu: boolean;
    };

export interface Manifest {
  schemaVersion: 1;
  /** A positive whole number. A held manifest is never replaced by a lower one. */
  sequence: number;
  /** The task API release, such as "2.5.0". */
  packageVersion: string;
  /** The engine release, such as "0.1.0". */
  engineVersion: string;
  /** The oldest aidm-ui that may install it. */
  minimumUiVersion: string;
  variants: Partial<Record<VariantId, ManifestVariant>>;
}

export type ParsedManifest =
  | {
      ok: true;
      manifest: Manifest;
      /** Variant ids this version does not know. They are left out so that an older interface can still read a newer manifest. */
      skippedVariants: string[];
    }
  | { ok: false; error: ApiError };

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
// Host (with an optional port), then one or more path parts, no tag and no digest.
// It must start with a letter or digit so that it can never read as a command-line flag.
const IMAGE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::\d{1,5})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/;

class Malformed extends Error {
  constructor(readonly field: string) {
    super(field);
  }
}

function malformed(error: unknown): ParsedManifest {
  const field = error instanceof Malformed ? error.field : "manifest";
  return { ok: false, error: { code: "manifest.malformed", data: { field } } };
}

function asObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Malformed(field);
  return value as Record<string, unknown>;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") throw new Malformed(field);
  return value;
}

function asVersion(value: unknown, field: string): string {
  const text = asString(value, field);
  if (!isReadableVersion(text)) throw new Malformed(field);
  return text;
}

function asWholeNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Malformed(field);
  return value;
}

function asBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Malformed(field);
  return value;
}

function isVariantId(id: string): id is VariantId {
  return (VARIANT_IDS as readonly string[]).includes(id);
}

function parseVariant(value: unknown, id: VariantId): ManifestVariant {
  const at = (name: string) => `variants.${id}.${name}`;
  const entry = asObject(value, `variants.${id}`);
  const size = asWholeNumber(entry.size, at("size"));
  const gpu = asBoolean(entry.gpu, at("gpu"));
  if (entry.kind === "container") {
    const image = asString(entry.image, at("image"));
    if (!IMAGE.test(image)) throw new Malformed(at("image"));
    const digest = asString(entry.digest, at("digest"));
    if (!DIGEST.test(digest)) throw new Malformed(at("digest"));
    if (entry.taskApiSocket === undefined) return { kind: "container", image, digest, size, gpu };
    return { kind: "container", image, digest, size, gpu, taskApiSocket: asBoolean(entry.taskApiSocket, at("taskApiSocket")) };
  }
  if (entry.kind === "native") {
    const url = asString(entry.url, at("url"));
    if (!isHttps(url)) throw new Malformed(at("url"));
    const sha256 = asString(entry.sha256, at("sha256"));
    if (!SHA256.test(sha256)) throw new Malformed(at("sha256"));
    return { kind: "native", url, size, sha256, gpu };
  }
  throw new Malformed(at("kind"));
}

function isHttps(text: string): boolean {
  try {
    return new URL(text).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Reads the exact bytes of a manifest. It is strict: an unknown schema
 * version, a missing field, a wrong type, a bad digest or an archive address
 * that is not https is manifest.malformed. Fields it does not know are
 * ignored, and so are variants it does not know (they are listed in
 * skippedVariants); the schema version is what marks an incompatible change.
 */
export function parseManifest(bytes: Uint8Array): ParsedManifest {
  try {
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new Malformed("manifest");
    }
    const root = asObject(json, "manifest");
    if (root.schemaVersion !== 1) throw new Malformed("schemaVersion");
    const variantsIn = asObject(root.variants, "variants");
    const variants: Manifest["variants"] = {};
    const skippedVariants: string[] = [];
    for (const [id, entry] of Object.entries(variantsIn)) {
      if (!isVariantId(id)) {
        skippedVariants.push(id);
        continue;
      }
      variants[id] = parseVariant(entry, id);
    }
    return {
      ok: true,
      manifest: {
        schemaVersion: 1,
        sequence: asWholeNumber(root.sequence, "sequence"),
        packageVersion: asVersion(root.packageVersion, "packageVersion"),
        engineVersion: asVersion(root.engineVersion, "engineVersion"),
        minimumUiVersion: asVersion(root.minimumUiVersion, "minimumUiVersion"),
        variants,
      },
      skippedVariants,
    };
  } catch (error) {
    return malformed(error);
  }
}
