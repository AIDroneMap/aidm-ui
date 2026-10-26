import { describe, expect, test } from "bun:test";
import { generateSigner, manifestBytes, sampleManifest, signedRelease } from "../../test-support/signed-manifest.ts";
import { verifyBuiltinManifest } from "./builtin.ts";
import { ACCEPTED_KEYS } from "./keys.ts";
import { releaseKeyProblems, verifyManifest, verifySignature } from "./verify.ts";

describe("verifySignature", () => {
  test("accepts a signature made by a listed key and names the key", async () => {
    const signer = await generateSigner("one");
    const bytes = new TextEncoder().encode("hello");
    expect(await verifySignature(bytes, await signer.sign(bytes), [signer.key])).toEqual({ ok: true, keyId: "one" });
  });

  test("finds the right key in a list of several", async () => {
    const first = await generateSigner("first");
    const second = await generateSigner("second");
    const bytes = new TextEncoder().encode("hello");
    expect(await verifySignature(bytes, await second.sign(bytes), [first.key, second.key])).toEqual({
      ok: true,
      keyId: "second",
    });
  });

  test("refuses a key that is not listed, a changed byte and an empty list", async () => {
    const signer = await generateSigner();
    const other = await generateSigner();
    const bytes = new TextEncoder().encode("hello");
    const signature = await signer.sign(bytes);
    expect((await verifySignature(bytes, signature, [other.key])).ok).toBe(false);
    expect((await verifySignature(new TextEncoder().encode("hellp"), signature, [signer.key])).ok).toBe(false);
    expect((await verifySignature(bytes, signature, [])).ok).toBe(false);
  });

  test("refuses a signature that is not 64 bytes, or a changed signature", async () => {
    const signer = await generateSigner();
    const bytes = new TextEncoder().encode("hello");
    const signature = await signer.sign(bytes);
    expect((await verifySignature(bytes, signature.subarray(0, 63), [signer.key])).ok).toBe(false);
    expect((await verifySignature(bytes, new Uint8Array(65), [signer.key])).ok).toBe(false);
    expect((await verifySignature(bytes, new Uint8Array(0), [signer.key])).ok).toBe(false);
    const changed = signature.slice();
    changed[10] = (changed[10] as number) ^ 1;
    expect((await verifySignature(bytes, changed, [signer.key])).ok).toBe(false);
  });

  test("skips a listed key that is not a public key", async () => {
    const signer = await generateSigner("good");
    const bytes = new TextEncoder().encode("hello");
    const broken = { id: "broken", publicKey: btoa("short"), test: false };
    expect(await verifySignature(bytes, await signer.sign(bytes), [broken, signer.key])).toEqual({ ok: true, keyId: "good" });
  });
});

describe("verifyManifest", () => {
  test("a signed, valid manifest is returned with the key that signed it", async () => {
    const signer = await generateSigner("k");
    const { bytes, signature } = await signedRelease(signer, sampleManifest());
    expect(await verifyManifest(bytes, signature, [signer.key])).toEqual({ ok: true, manifest: sampleManifest(), keyId: "k" });
  });

  test("the signature is checked before the content", async () => {
    const signer = await generateSigner();
    const other = await generateSigner();
    const bytes = manifestBytes({ not: "a manifest" });
    const result = await verifyManifest(bytes, await other.sign(bytes), [signer.key]);
    expect(result).toEqual({ ok: false, error: { code: "manifest.signature_invalid", data: {} } });
  });

  test("a signed file that is not a valid manifest is malformed", async () => {
    const signer = await generateSigner();
    const { bytes, signature } = await signedRelease(signer, { schemaVersion: 1 });
    const result = await verifyManifest(bytes, signature, [signer.key]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("manifest.malformed");
  });
});

describe("the built-in 2.5.0 entry", () => {
  test("verifies against the accepted keys through the same path as a downloaded manifest", async () => {
    const result = await verifyBuiltinManifest();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.packageVersion).toBe("2.5.0");
    expect(result.manifest.sequence).toBe(1);
    expect(Object.keys(result.manifest.variants)).toEqual(["linux-amd64-cpu", "linux-arm64-cpu", "linux-amd64-gpu"]);
    for (const variant of Object.values(result.manifest.variants)) expect(variant?.kind).toBe("container");
    expect(ACCEPTED_KEYS.some((key) => key.id === result.keyId)).toBe(true);
  });

  test("does not verify against a key list without its key", async () => {
    const stranger = await generateSigner();
    expect((await verifyBuiltinManifest([stranger.key])).ok).toBe(false);
  });
});

describe("releaseKeyProblems", () => {
  const test1 = { id: "t", publicKey: "x", test: true };
  const prod = { id: "p", publicKey: "x", test: false };

  test("no problem when only production keys remain and the entry is signed by one", () => {
    expect(releaseKeyProblems([prod], "p")).toEqual([]);
  });

  test("a test key in the list is a problem", () => {
    expect(releaseKeyProblems([prod, test1], "p")).toHaveLength(1);
  });

  test("a built-in entry signed by a test key, or not verifying, is a problem", () => {
    expect(releaseKeyProblems([test1], "t").length).toBeGreaterThanOrEqual(1);
    expect(releaseKeyProblems([prod], null)).toHaveLength(1);
  });
});
