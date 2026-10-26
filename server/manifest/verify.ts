import type { ApiError } from "../../shared/api-error.ts";
import { ACCEPTED_KEYS, type AcceptedKey } from "./keys.ts";
import { parseManifest, type Manifest } from "./schema.ts";

const SIGNATURE_BYTES = 64;

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

/** True when one of the keys made this raw Ed25519 signature over exactly these bytes. */
export async function verifySignature(
  bytes: Uint8Array,
  signature: Uint8Array,
  keys: readonly AcceptedKey[],
): Promise<{ ok: true; keyId: string } | { ok: false }> {
  if (signature.length !== SIGNATURE_BYTES) return { ok: false };
  for (const key of keys) {
    try {
      const publicKey = await crypto.subtle.importKey("raw", fromBase64(key.publicKey), { name: "Ed25519" }, false, [
        "verify",
      ]);
      if (await crypto.subtle.verify("Ed25519", publicKey, signature as Uint8Array<ArrayBuffer>, bytes as Uint8Array<ArrayBuffer>)) {
        return { ok: true, keyId: key.id };
      }
    } catch {
      // A key in the list that cannot be read never verifies anything; try the next one.
    }
  }
  return { ok: false };
}

export type VerifiedManifest =
  | { ok: true; manifest: Manifest; keyId: string }
  | { ok: false; error: ApiError };

/** The signature is checked first, so that nothing unsigned is ever read as a manifest. */
export async function verifyManifest(
  bytes: Uint8Array,
  signature: Uint8Array,
  keys: readonly AcceptedKey[] = ACCEPTED_KEYS,
): Promise<VerifiedManifest> {
  const signed = await verifySignature(bytes, signature, keys);
  if (!signed.ok) return { ok: false, error: { code: "manifest.signature_invalid", data: {} } };
  const parsed = parseManifest(bytes);
  if (!parsed.ok) return parsed;
  return { ok: true, manifest: parsed.manifest, keyId: signed.keyId };
}

/**
 * What stops a release build: a test key in the accepted list, or a built-in
 * entry that is signed by one (or does not verify at all).
 */
export function releaseKeyProblems(keys: readonly AcceptedKey[], builtinKeyId: string | null): string[] {
  const problems: string[] = [];
  for (const key of keys) {
    if (key.test) problems.push(`The accepted key "${key.id}" is a test key.`);
  }
  if (builtinKeyId === null) {
    problems.push("The built-in manifest entry does not verify against the accepted keys.");
  } else if (keys.some((key) => key.test && key.id === builtinKeyId)) {
    problems.push(`The built-in manifest entry is signed with the test key "${builtinKeyId}".`);
  }
  return problems;
}
