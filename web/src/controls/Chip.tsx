import type { ReactNode } from "react";

/** A small tag, such as what an option affects. It is text, not a control. */
export function Chip({ children }: { children: ReactNode }) {
  return <span className="chip">{children}</span>;
}
