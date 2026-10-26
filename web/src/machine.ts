import type { ApiError } from "../../shared/api-error.ts";
import { formatBytes } from "./format.ts";

// Data keys that hold a number of bytes. The server sends bytes; the operator reads GiB.
const BYTE_KEYS = new Set(["total", "free", "needed", "minimum", "recommended"]);

/**
 * The values that fill the placeholders of a machine check sentence. Sizes
 * arrive in bytes and are shown with formatBytes. The one exception is the
 * minimum of macos_too_old, which is a version number. A list becomes words
 * separated by commas.
 */
export function messageParams(message: ApiError): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(message.data)) {
    if (typeof value === "number") {
      const isSize = BYTE_KEYS.has(key) && !(key === "minimum" && message.code === "machine.macos_too_old");
      out[key] = isSize ? formatBytes(value) : value;
    } else if (typeof value === "string") {
      out[key] = value;
    } else if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      out[key] = value.join(", ");
    }
  }
  return out;
}
