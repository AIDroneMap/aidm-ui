import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { base64ToBytes, bytesToBase64 } from "../shared/base64.ts";
import { verifySignature } from "../server/manifest/verify.ts";
import { manifestBytes, sampleManifest } from "../test-support/signed-manifest.ts";
import { generateKeyPair, parseArguments, signManifest } from "./sign-manifest.ts";

const script = join(import.meta.dir, "sign-manifest.ts");
let folder: string | undefined;

afterEach(() => {
  if (folder !== undefined) rmSync(folder, { recursive: true, force: true });
  folder = undefined;
});

function tempFolder(): string {
  folder = mkdtempSync(join(os.tmpdir(), "aidm-ui-sign-"));
  return folder;
}

async function run(args: string[], stdin: string): Promise<{ code: number; out: string; err: string }> {
  const child = Bun.spawn([process.execPath, script, ...args], {
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, out, err };
}

function validManifestFile(): string {
  const manifest = join(tempFolder(), "manifest.json");
  writeFileSync(manifest, manifestBytes(sampleManifest()));
  return manifest;
}

test("a manifest is signed, and the signature verifies against the public key of the private key", async () => {
  const pair = await generateKeyPair();
  const bytes = manifestBytes(sampleManifest());
  const signed = await signManifest(bytes, pair.privateKeyPem);
  expect(signed.ok).toBe(true);
  if (!signed.ok) return;
  expect(signed.publicKey).toBe(pair.publicKey);
  expect(signed.signature).toHaveLength(64);
  expect(await verifySignature(bytes, signed.signature, [{ id: "k", publicKey: signed.publicKey, test: true }])).toEqual({
    ok: true,
    keyId: "k",
  });
});

test("a malformed manifest is not signed", async () => {
  const pair = await generateKeyPair();
  for (const text of ["{}", "not json", JSON.stringify({ ...sampleManifest(), schemaVersion: 2 })]) {
    const signed = await signManifest(new TextEncoder().encode(text), pair.privateKeyPem);
    expect(signed.ok).toBe(false);
    if (!signed.ok) expect(signed.problem).toContain("manifest.malformed");
  }
});

test("the command writes the raw signature and its base64 text next to the manifest", async () => {
  const manifest = validManifestFile();
  const pair = await generateKeyPair();
  const result = await run([manifest], pair.privateKeyPem);
  expect(result.code).toBe(0);
  const signature = readFileSync(`${manifest}.sig`);
  expect(signature).toHaveLength(64);
  expect(readFileSync(`${manifest}.sig.b64`, "utf8").trim()).toBe(bytesToBase64(signature));
  expect(result.out).toContain(`public key (base64): ${pair.publicKey}`);
  expect(await verifySignature(readFileSync(manifest), signature, [{ id: "k", publicKey: pair.publicKey, test: true }])).toMatchObject({ ok: true });
});

test("--out chooses the raw signature file and the base64 file follows its name", async () => {
  const manifest = validManifestFile();
  const out = join(folder as string, "other.sig");
  const result = await run([manifest, "--out", out], (await generateKeyPair()).privateKeyPem);
  expect(result.code).toBe(0);
  expect(readFileSync(out)).toHaveLength(64);
  expect(existsSync(`${out}.b64`)).toBe(true);
  expect(existsSync(`${manifest}.sig`)).toBe(false);
});

test("a malformed manifest file fails without writing any signature", async () => {
  const manifest = join(tempFolder(), "manifest.json");
  writeFileSync(manifest, "{}\n");
  const result = await run([manifest], (await generateKeyPair()).privateKeyPem);
  expect(result.code).toBe(1);
  expect(result.err).toContain("manifest.malformed");
  expect(existsSync(`${manifest}.sig`)).toBe(false);
  expect(existsSync(`${manifest}.sig.b64`)).toBe(false);
});

test("input that is not a private key fails without writing a signature", async () => {
  const manifest = validManifestFile();
  const result = await run([manifest], "not a key");
  expect(result.code).toBe(1);
  expect(existsSync(`${manifest}.sig`)).toBe(false);
});

test("--generate-key writes the private key to a new file that only its owner can read, and prints only the public key", async () => {
  const path = join(tempFolder(), "release.pem");
  const result = await run(["--generate-key", "--out-key", path], "");
  expect(result.code).toBe(0);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  const pem = readFileSync(path, "utf8");
  expect(pem).toContain("-----BEGIN PRIVATE KEY-----");
  expect(result.out + result.err).not.toContain("PRIVATE KEY");
  const body = pem.replace(/-----[A-Z ]+-----|\s+/g, "");
  expect(result.out + result.err).not.toContain(body.slice(0, 40));
  const publicKey = /public key \(base64\): (\S+)/.exec(result.out)?.[1];
  expect(publicKey).toBeDefined();
  expect(base64ToBytes(publicKey as string)).toHaveLength(32);
  const signed = await signManifest(manifestBytes(sampleManifest()), pem);
  expect(signed.ok && signed.publicKey).toBe(publicKey as string);
  expect(result.err).toContain("offline");
});

test("--generate-key refuses a path that already exists and leaves it alone", async () => {
  const path = join(tempFolder(), "release.pem");
  writeFileSync(path, "keep me");
  const result = await run(["--generate-key", "--out-key", path], "");
  expect(result.code).toBe(1);
  expect(readFileSync(path, "utf8")).toBe("keep me");
});

test("--generate-key without a file for the key is refused, so a key is never printed", async () => {
  const result = await run(["--generate-key"], "");
  expect(result.code).toBe(2);
  expect(result.out).toBe("");
  expect(result.err).toContain("--out-key");
});

test("the arguments are checked", () => {
  expect(parseArguments(["--generate-key", "--out-key", "k.pem"])).toEqual({ ok: true, mode: "generate", outKey: "k.pem" });
  expect(parseArguments(["--generate-key"]).ok).toBe(false);
  expect(parseArguments(["--generate-key", "--out-key"]).ok).toBe(false);
  expect(parseArguments(["--generate-key", "m.json"]).ok).toBe(false);
  expect(parseArguments(["m.json"])).toEqual({ ok: true, mode: "sign", manifest: "m.json", out: "m.json.sig" });
  expect(parseArguments(["m.json", "--out", "x.sig"])).toEqual({ ok: true, mode: "sign", manifest: "m.json", out: "x.sig" });
  expect(parseArguments([]).ok).toBe(false);
  expect(parseArguments(["a", "b"]).ok).toBe(false);
  expect(parseArguments(["a", "--out"]).ok).toBe(false);
  expect(parseArguments(["--key", "x"]).ok).toBe(false);
  expect(parseArguments(["m.json", "--out-key", "k"]).ok).toBe(false);
});
