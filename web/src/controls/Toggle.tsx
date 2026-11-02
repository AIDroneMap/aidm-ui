import type { ComponentProps, ReactNode } from "react";
import { describedBy } from "./field-description.ts";

type Props = Omit<ComponentProps<"input">, "id" | "type" | "role"> & { id: string; label: ReactNode; hint?: ReactNode };

/** An on and off switch: a native checkbox that screen readers announce as a switch. */
export function Toggle({ id, label, hint, ...props }: Props) {
  return (
    <div className="check">
      <input id={id} type="checkbox" role="switch" {...props} aria-describedby={describedBy(id, hint, null, props["aria-describedby"])} />
      <label htmlFor={id}>{label}</label>
      {hint ? <p id={`${id}-hint`} className="field-hint">{hint}</p> : null}
    </div>
  );
}
