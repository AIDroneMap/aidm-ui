import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { verifySignature } from "../server/manifest/verify.ts";
import { generateKeyPair, parseArguments, signBytes } from "./sign-manifest.ts";

const script = join(import.meta.dir, "sign-manifest.ts");
let folder: string | undefined;

afterEach(() => {
  if (folder !== undefined) rmSync(folder, { recursive: true, force: true });
  folder = undefined;
});

async function run(args: string[], stdin: string): Promise<{ code: number; out: string; err: string }> {
  const child = Bun.spawn([process.execPath, script, ...args], {
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, out, err };
}

test("a signature made with a generated key verifies against the printed public key", async () => {
  const pair = await generateKeyPair();
  const bytes = new TextEncoder().encode('{"a":1}\n');
  const { signature, publicKey } = await signBytes(bytes, pair.privateKeyPem);
  expect(publicKey).toBe(pair.publicKey);
  expect(signature).toHaveLength(64);
  expect(await verifySignature(bytes, signature, [{ id: "k", publicKey, test: true }])).toEqual({ ok: true, keyId: "k" });
});

test("the command reads the key from standard input and writes the raw signature next to the manifest", async () => {
  folder = mkdtempSync(join(os.tmpdir(), "aidm-ui-sign-"));
  const manifest = join(folder, "manifest.json");
  writeFileSync(manifest, '{"x":2}\n');
  const pair = await generateKeyPair();
  const result = await run([manifest], pair.privateKeyPem);
  expect(result.code).toBe(0);
  const signature = readFileSync(`${manifest}.sig`);
  expect(signature).toHaveLength(64);
  expect(result.out).toContain(`signature (base64): ${signature.toString("base64")}`);
  expect(result.out).toContain(`public key (base64): ${pair.publicKey}`);
  expect(await verifySignature(readFileSync(manifest), signature, [{ id: "k", publicKey: pair.publicKey, test: true }])).toMatchObject({ ok: true });
});

test("--out chooses the signature file", async () => {
  folder = mkdtempSync(join(os.tmpdir(), "aidm-ui-sign-"));
  const manifest = join(folder, "manifest.json");
  const out = join(folder, "other.sig");
  writeFileSync(manifest, "{}\n");
  const result = await run([manifest, "--out", out], (await generateKeyPair()).privateKeyPem);
  expect(result.code).toBe(0);
  expect(readFileSync(out)).toHaveLength(64);
});

test("--generate-key prints a usable pair and warns on standard error", async () => {
  const result = await run(["--generate-key"], "");
  expect(result.code).toBe(0);
  expect(result.err).toContain("offline");
  const pem = /-----BEGIN PRIVATE KEY-----[^-]+-----END PRIVATE KEY-----\n/.exec(result.out)?.[0];
  const publicKey = /public key \(base64\): (\S+)/.exec(result.out)?.[1];
  expect(pem).toBeDefined();
  const bytes = new TextEncoder().encode("hello");
  const signed = await signBytes(bytes, pem as string);
  expect(signed.publicKey).toBe(publicKey as string);
});

test("input that is not a private key fails without writing a signature", async () => {
  folder = mkdtempSync(join(os.tmpdir(), "aidm-ui-sign-"));
  const manifest = join(folder, "manifest.json");
  writeFileSync(manifest, "{}\n");
  const result = await run([manifest], "not a key");
  expect(result.code).toBe(1);
  expect(await Bun.file(`${manifest}.sig`).exists()).toBe(false);
});

test("the arguments are checked", () => {
  expect(parseArguments(["--generate-key"])).toEqual({ ok: true, mode: "generate" });
  expect(parseArguments(["m.json"])).toEqual({ ok: true, mode: "sign", manifest: "m.json", out: "m.json.sig" });
  expect(parseArguments(["m.json", "--out", "x.sig"])).toEqual({ ok: true, mode: "sign", manifest: "m.json", out: "x.sig" });
  expect(parseArguments([]).ok).toBe(false);
  expect(parseArguments(["a", "b"]).ok).toBe(false);
  expect(parseArguments(["a", "--out"]).ok).toBe(false);
  expect(parseArguments(["--key", "x"]).ok).toBe(false);
});
