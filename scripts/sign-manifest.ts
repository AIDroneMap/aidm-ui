// Signs a manifest with the release key. For the maintainer.
//
//   bun scripts/sign-manifest.ts <manifest.json> [--out <file.sig>] < private-key.pem
//   bun scripts/sign-manifest.ts --generate-key
//
// The private key (PKCS#8, PEM) comes from standard input, never from an
// argument and never from a file in this repository. The raw 64-byte
// signature goes to <file.sig> (default: <manifest.json>.sig). The base64
// signature and the base64 raw public key are printed.
import { readFileSync, writeFileSync } from "node:fs";

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function base64Url(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "base64url"));
}

function pemOf(label: string, der: Uint8Array): string {
  const lines = base64(der).match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

function derOf(pem: string): Uint8Array {
  const match = /-----BEGIN PRIVATE KEY-----([^-]+)-----END PRIVATE KEY-----/.exec(pem);
  if (!match) throw new Error("Standard input does not hold a PKCS#8 private key in PEM form.");
  return new Uint8Array(Buffer.from((match[1] as string).replace(/\s+/g, ""), "base64"));
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
  return { privateKeyPem: pemOf("PRIVATE KEY", der), publicKey: base64(raw) };
}

/** The raw signature over the exact bytes, and the public half of the key that made it. */
export async function signBytes(
  bytes: Uint8Array,
  privateKeyPem: string,
): Promise<{ signature: Uint8Array; publicKey: string }> {
  const key = await crypto.subtle.importKey("pkcs8", derOf(privateKeyPem) as Uint8Array<ArrayBuffer>, { name: "Ed25519" }, true, [
    "sign",
  ]);
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", key, bytes as Uint8Array<ArrayBuffer>));
  // The public half is the "x" of the key's JWK form.
  const jwk = await crypto.subtle.exportKey("jwk", key);
  if (typeof jwk.x !== "string") throw new Error("The key has no public half.");
  return { signature, publicKey: base64(base64Url(jwk.x)) };
}

export type SignArguments =
  | { ok: true; mode: "generate" }
  | { ok: true; mode: "sign"; manifest: string; out: string }
  | { ok: false; problem: string };

export function parseArguments(args: string[]): SignArguments {
  if (args.length === 1 && args[0] === "--generate-key") return { ok: true, mode: "generate" };
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
  if (manifest === undefined) {
    return { ok: false, problem: "usage: bun scripts/sign-manifest.ts <manifest.json> [--out <file.sig>] < key.pem" };
  }
  return { ok: true, mode: "sign", manifest, out: out ?? `${manifest}.sig` };
}

async function main(): Promise<number> {
  const parsed = parseArguments(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(parsed.problem);
    return 2;
  }
  if (parsed.mode === "generate") {
    const pair = await generateKeyPair();
    console.error("Keep the private key offline. Never commit it, never paste it into a pull request or a log.");
    console.log(pair.privateKeyPem);
    console.log(`public key (base64): ${pair.publicKey}`);
    return 0;
  }
  try {
    const { signature, publicKey } = await signBytes(readFileSync(parsed.manifest), await Bun.stdin.text());
    writeFileSync(parsed.out, signature);
    console.log(`signature (base64): ${base64(signature)}`);
    console.log(`public key (base64): ${publicKey}`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.main) process.exit(await main());
