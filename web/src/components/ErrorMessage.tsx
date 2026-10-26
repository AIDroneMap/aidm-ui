import type { ApiFailure } from "../api.ts";
import { t } from "../i18n/translate.ts";

// The server sends data of any shape; only strings and numbers can fill a placeholder.
function params(data: Record<string, unknown>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === "string" || typeof value === "number") out[key] = value;
  }
  return out;
}

export function ErrorMessage({ failure, id }: { failure: ApiFailure; id?: string }) {
  return (
    <p id={id} role="alert" className="error">
      {t(failure.code, params(failure.data))}
    </p>
  );
}
