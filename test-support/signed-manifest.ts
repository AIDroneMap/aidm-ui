// Test keys and signed manifests. Every key pair is made in memory for the
// test that uses it, and nothing here is ever a production key.
import { bytesToBase64 } from "../shared/base64.ts";
import type { Manifest } from "../server/manifest/schema.ts";
import type { AcceptedKey } from "../server/manifest/keys.ts";

export interface TestSigner {
  /** The entry for the accepted-key list. */
  key: AcceptedKey;
  sign(bytes: Uint8Array): Promise<Uint8Array>;
}

export async function generateSigner(id = "test-key"): Promise<TestSigner> {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return {
    key: { id, publicKey: bytesToBase64(raw), test: true },
    sign: async (bytes) => new Uint8Array(await crypto.subtle.sign("Ed25519", pair.privateKey, bytes as Uint8Array<ArrayBuffer>)),
  };
}

const DIGEST = `sha256:${"ab".repeat(32)}`;

/** A small valid manifest; override any field. */
export function sampleManifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    schemaVersion: 1,
    sequence: 2,
    packageVersion: "2.6.0",
    engineVersion: "0.2.0",
    minimumUiVersion: "0.1.0",
    variants: {
      "linux-amd64-cpu": { kind: "container", image: "ghcr.io/aidronemap/aidm-api", digest: DIGEST, size: 111, gpu: false },
      "linux-arm64-cpu": { kind: "container", image: "ghcr.io/aidronemap/aidm-api", digest: DIGEST, size: 222, gpu: false },
      "windows-x64": { kind: "native", url: "https://example.org/aidm-api.zip", size: 333, sha256: "cd".repeat(32), gpu: false },
    },
    ...overrides,
  };
}

export function manifestBytes(manifest: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
}

/** The bytes and the raw signature of a manifest, as a release publishes them. */
export async function signedRelease(
  signer: TestSigner,
  manifest: unknown,
): Promise<{ bytes: Uint8Array; signature: Uint8Array }> {
  const bytes = manifestBytes(manifest);
  return { bytes, signature: await signer.sign(bytes) };
}
