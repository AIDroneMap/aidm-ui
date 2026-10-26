import { describe, expect, test } from "bun:test";
import { manifestBytes, sampleManifest } from "../../test-support/signed-manifest.ts";
import { parseManifest } from "./schema.ts";

function malformedField(input: unknown): unknown {
  const result = parseManifest(typeof input === "string" ? new TextEncoder().encode(input) : manifestBytes(input));
  if (result.ok) return "accepted";
  expect(result.error.code).toBe("manifest.malformed");
  return result.error.data.field;
}

function withVariant(variant: unknown, id = "linux-amd64-cpu") {
  return { ...sampleManifest(), variants: { [id]: variant } };
}

const container = { kind: "container", image: "ghcr.io/aidronemap/aidm-api", digest: `sha256:${"a".repeat(64)}`, size: 5, gpu: false };
const native = { kind: "native", url: "https://example.org/a.zip", size: 5, sha256: "b".repeat(64), gpu: false };

describe("parseManifest", () => {
  test("a complete manifest is read as it is", () => {
    const manifest = sampleManifest();
    const result = parseManifest(manifestBytes(manifest));
    expect(result).toEqual({ ok: true, manifest });
  });

  test("a manifest with no variants is valid and offers nothing", () => {
    expect(parseManifest(manifestBytes({ ...sampleManifest(), variants: {} })).ok).toBe(true);
  });

  test("fields it does not know are ignored", () => {
    const result = parseManifest(manifestBytes({ ...sampleManifest(), note: "hello" }));
    expect(result).toEqual({ ok: true, manifest: sampleManifest() });
  });

  test("text that is not JSON, or not an object, is malformed", () => {
    expect(malformedField("not json")).toBe("manifest");
    expect(malformedField("[]")).toBe("manifest");
    expect(malformedField("null")).toBe("manifest");
    expect(parseManifest(new Uint8Array([0xff, 0xfe, 0x7b])).ok).toBe(false);
  });

  test("an unknown schema version is malformed", () => {
    expect(malformedField({ ...sampleManifest(), schemaVersion: 2 })).toBe("schemaVersion");
    expect(malformedField({ ...sampleManifest(), schemaVersion: "1" })).toBe("schemaVersion");
  });

  test("a missing top-level field is malformed", () => {
    for (const field of ["sequence", "packageVersion", "engineVersion", "minimumUiVersion", "variants"]) {
      const manifest: Record<string, unknown> = { ...sampleManifest() };
      delete manifest[field];
      expect(malformedField(manifest)).toBe(field);
    }
  });

  test("a wrong type or a bad value at the top is malformed", () => {
    expect(malformedField({ ...sampleManifest(), sequence: "2" })).toBe("sequence");
    expect(malformedField({ ...sampleManifest(), sequence: 0 })).toBe("sequence");
    expect(malformedField({ ...sampleManifest(), sequence: 1.5 })).toBe("sequence");
    expect(malformedField({ ...sampleManifest(), packageVersion: 2 })).toBe("packageVersion");
    expect(malformedField({ ...sampleManifest(), engineVersion: "latest" })).toBe("engineVersion");
    expect(malformedField({ ...sampleManifest(), minimumUiVersion: "" })).toBe("minimumUiVersion");
    expect(malformedField({ ...sampleManifest(), variants: [] })).toBe("variants");
  });

  test("an unknown variant id is malformed and the name is not echoed", () => {
    expect(malformedField({ ...sampleManifest(), variants: { "linux-riscv": container } })).toBe("variants");
  });

  test("a container variant needs an image without a tag and a sha256 digest", () => {
    expect(parseManifest(manifestBytes(withVariant(container))).ok).toBe(true);
    expect(malformedField(withVariant({ ...container, digest: "sha256:abc" }))).toBe("variants.linux-amd64-cpu.digest");
    expect(malformedField(withVariant({ ...container, digest: `sha512:${"a".repeat(64)}` }))).toBe("variants.linux-amd64-cpu.digest");
    expect(malformedField(withVariant({ ...container, digest: `sha256:${"A".repeat(64)}` }))).toBe("variants.linux-amd64-cpu.digest");
    expect(malformedField(withVariant({ ...container, image: "ghcr.io/aidronemap/aidm-api:2.5.0" }))).toBe("variants.linux-amd64-cpu.image");
    expect(malformedField(withVariant({ ...container, image: `ghcr.io/x/y@sha256:${"a".repeat(64)}` }))).toBe("variants.linux-amd64-cpu.image");
    expect(malformedField(withVariant({ ...container, image: "--privileged" }))).toBe("variants.linux-amd64-cpu.image");
    expect(malformedField(withVariant({ ...container, image: "has space/x" }))).toBe("variants.linux-amd64-cpu.image");
    expect(parseManifest(manifestBytes(withVariant({ ...container, image: "localhost:5000/team/aidm-api" }))).ok).toBe(true);
  });

  test("a native variant needs an https address and a sha256", () => {
    expect(parseManifest(manifestBytes(withVariant(native, "windows-x64"))).ok).toBe(true);
    expect(malformedField(withVariant({ ...native, url: "http://example.org/a.zip" }, "windows-x64"))).toBe("variants.windows-x64.url");
    expect(malformedField(withVariant({ ...native, url: "file:///etc/passwd" }, "windows-x64"))).toBe("variants.windows-x64.url");
    expect(malformedField(withVariant({ ...native, url: "not a url" }, "windows-x64"))).toBe("variants.windows-x64.url");
    expect(malformedField(withVariant({ ...native, sha256: "xyz" }, "windows-x64"))).toBe("variants.windows-x64.sha256");
  });

  test("a variant with a wrong size, gpu flag or kind is malformed", () => {
    expect(malformedField(withVariant({ ...container, size: -1 }))).toBe("variants.linux-amd64-cpu.size");
    expect(malformedField(withVariant({ ...container, size: "5" }))).toBe("variants.linux-amd64-cpu.size");
    expect(malformedField(withVariant({ ...container, gpu: "no" }))).toBe("variants.linux-amd64-cpu.gpu");
    expect(malformedField(withVariant({ ...container, kind: "vm" }))).toBe("variants.linux-amd64-cpu.kind");
    expect(malformedField(withVariant("container"))).toBe("variants.linux-amd64-cpu");
  });
});
