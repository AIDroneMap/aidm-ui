// Signs a manifest with the release key. For the maintainer.
//
//   bun scripts/sign-manifest.ts <manifest.json> [--out <file.sig>] < private-key.pem
//   bun scripts/sign-manifest.ts --generate-key --out-key <new-file.pem>
//
// The private key (PKCS#8, PEM) comes from standard input, never from an
// argument and never from a file in this repository. The manifest is read
// with the same code the app uses and refused when it is malformed. The raw
// 64-byte signature goes to <file.sig> (default: <manifest.json>.sig) and its
// base64 text to <file.sig>.b64, the form the built-in entry keeps. The
// signature is checked against the public key of the private key before
// anything is written.
//
// --generate-key writes the new private key to a file that did not exist,
// readable by its owner only. A private key is never printed.
import { readFileSync, writeFileSync } from "node:fs";
import { base64ToBytes, bytesToBase64 } from "../shared/base64.ts";
import { parseManifest } from "../server/manifest/schema.ts";
import { verifySignature } from "../server/manifest/verify.ts";

function pemOf(label: string, der: Uint8Array): string {
  const lines = bytesToBase64(der).match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

function derOf(pem: string): Uint8Array {
  const match = /-----BEGIN PRIVATE KEY-----([^-]+)-----END PRIVATE KEY-----/.exec(pem);
  if (!match) throw new Error("Standard input does not hold a PKCS#8 private key in PEM form.");
  return base64ToBytes(match[1] as string);
}

export interface KeyPairText {
  /** PKCS#8 in PEM form. Store it offline. */
  privateKeyPem: string;
  /** Base64 of the 32 raw bytes, the form the accepted-key list uses. */
  publicKey: string;
}

export async function generateKeyPair(): Promise<KeyPairText> {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { privateKeyPem: pemOf("PRIVATE KEY", der), publicKey: bytesToBase64(raw) };
}

/** Writes a new private key file, readable by its owner only. Fails when the path already exists. */
export function writeNewPrivateKey(path: string, pem: string): void {
  writeFileSync(path, pem, { mode: 0o600, flag: "wx" });
}

export type SignedManifest =
  | { ok: true; signature: Uint8Array; publicKey: string }
  | { ok: false; problem: string };

/**
 * The raw signature over the exact bytes of a manifest, and the public half of
 * the key that made it. A manifest the app would not read is not signed, and a
 * signature that does not verify against the key's own public half is not returned.
 */
export async function signManifest(bytes: Uint8Array, privateKeyPem: string): Promise<SignedManifest> {
  const parsed = parseManifest(bytes);
  if (!parsed.ok) {
    return { ok: false, problem: `The manifest is not valid (${parsed.error.code}, field ${String(parsed.error.data.field)}).` };
  }
  const key = await crypto.subtle.importKey("pkcs8", derOf(privateKeyPem) as Uint8Array<ArrayBuffer>, { name: "Ed25519" }, true, [
    "sign",
  ]);
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", key, bytes as Uint8Array<ArrayBuffer>));
  // The public half is the "x" of the key's JWK form, in base64url.
  const jwk = await crypto.subtle.exportKey("jwk", key);
  if (typeof jwk.x !== "string") throw new Error("The key has no public half.");
  const publicKey = bytesToBase64(new Uint8Array(Buffer.from(jwk.x, "base64url")));
  const checked = await verifySignature(bytes, signature, [{ id: "signer", publicKey, test: false }]);
  if (!checked.ok) return { ok: false, problem: "The signature did not verify against the public key of the private key." };
  return { ok: true, signature, publicKey };
}

export type SignArguments =
  | { ok: true; mode: "generate"; outKey: string }
  | { ok: true; mode: "sign"; manifest: string; out: string }
  | { ok: false; problem: string };

const USAGE =
  "usage: bun scripts/sign-manifest.ts <manifest.json> [--out <file.sig>] < key.pem\n       bun scripts/sign-manifest.ts --generate-key --out-key <new-file.pem>";

export function parseArguments(args: string[]): SignArguments {
  if (args.includes("--generate-key")) {
    if (args.length === 3 && args[0] === "--generate-key" && args[1] === "--out-key") {
      return { ok: true, mode: "generate", outKey: args[2] as string };
    }
    return { ok: false, problem: "--generate-key needs --out-key <new-file.pem>, because a private key is never printed." };
  }
  let manifest: string | undefined;
  let out: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--out") {
      out = args[++i];
      if (out === undefined) return { ok: false, problem: "--out needs a file name." };
    } else if (arg.startsWith("--")) {
      return { ok: false, problem: `Unknown flag: ${arg}` };
    } else if (manifest === undefined) {
      manifest = arg;
    } else {
      return { ok: false, problem: "Give one manifest file." };
    }
  }
  if (manifest === undefined) return { ok: false, problem: USAGE };
  return { ok: true, mode: "sign", manifest, out: out ?? `${manifest}.sig` };
}

async function main(): Promise<number> {
  const parsed = parseArguments(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(parsed.problem);
    return 2;
  }
  try {
    if (parsed.mode === "generate") {
      const pair = await generateKeyPair();
      writeNewPrivateKey(parsed.outKey, pair.privateKeyPem);
      console.error("Keep the private key file offline. Never commit it, never paste it into a pull request or a log.");
      console.log(`public key (base64): ${pair.publicKey}`);
      return 0;
    }
    const signed = await signManifest(readFileSync(parsed.manifest), await Bun.stdin.text());
    if (!signed.ok) {
      console.error(signed.problem);
      return 1;
    }
    const text = bytesToBase64(signed.signature);
    writeFileSync(parsed.out, signed.signature);
    writeFileSync(`${parsed.out}.b64`, `${text}\n`);
    console.log(`signature (base64): ${text}`);
    console.log(`public key (base64): ${signed.publicKey}`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.main) process.exit(await main());
