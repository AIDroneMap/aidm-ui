import { base64ToBytes } from "../../shared/base64.ts";
import manifestText from "./builtin/2.7.0.json" with { type: "text" };
import signatureText from "./builtin/2.7.0.json.sig.b64" with { type: "text" };
import type { AcceptedKey } from "./keys.ts";
import { verifyManifest, type VerifiedManifest } from "./verify.ts";

/**
 * The type checker reads a .json import as parsed JSON, whatever the import
 * attribute says. Bun embeds the file as text, and the exact bytes are what
 * the signature covers, so this checks that the text arrived untouched.
 */
function embeddedFileText(module: unknown): string {
  if (typeof module !== "string") throw new Error("The built-in manifest entry was not embedded as text.");
  return module;
}

/** The built-in published 2.7.0 entry, checked like any downloaded manifest. */
export function verifyBuiltinManifest(keys?: readonly AcceptedKey[]): Promise<VerifiedManifest> {
  return verifyManifest(new TextEncoder().encode(embeddedFileText(manifestText)), base64ToBytes(signatureText), keys);
}
