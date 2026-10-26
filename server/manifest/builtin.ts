import manifestText from "./builtin/2.5.0.json" with { type: "text" };
import signatureText from "./builtin/2.5.0.json.sig.b64" with { type: "text" };
import type { AcceptedKey } from "./keys.ts";
import { verifyManifest, type VerifiedManifest } from "./verify.ts";

/** Decodes standard base64 text, ignoring surrounding white space. */
export function base64Bytes(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(text.trim()), (char) => char.charCodeAt(0));
}

/**
 * The compiler reads a .json import as parsed JSON, whatever the import
 * attribute says. Bun embeds the file as text, and the exact bytes are what
 * the signature covers.
 */
function textOf(module: unknown): string {
  if (typeof module !== "string") throw new Error("The built-in manifest entry was not embedded as text.");
  return module;
}

/** The built-in 2.5.0 entry, checked like any downloaded manifest. */
export function verifyBuiltinManifest(keys?: readonly AcceptedKey[]): Promise<VerifiedManifest> {
  return verifyManifest(new TextEncoder().encode(textOf(manifestText)), base64Bytes(signatureText), keys);
}
