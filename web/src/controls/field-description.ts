import type { ReactNode } from "react";

/** The ids a control's aria-describedby lists: its hint, then its error. */
export function describedBy(id: string, hint: ReactNode, error: ReactNode, given?: string): string | undefined {
  const ids = [given, hint ? `${id}-hint` : "", error ? `${id}-error` : ""].filter(Boolean);
  return ids.length ? ids.join(" ") : undefined;
}
