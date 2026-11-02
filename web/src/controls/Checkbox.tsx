import type { ComponentProps, ReactNode } from "react";
import { describedBy } from "./field-description.ts";

type Props = Omit<ComponentProps<"input">, "id" | "type"> & { id: string; label: ReactNode; hint?: ReactNode };

/** A native checkbox drawn on the tokens, for a choice that is kept until it is saved or applied. */
export function Checkbox({ id, label, hint, ...props }: Props) {
  return (
    <div className="check">
      <input id={id} type="checkbox" {...props} aria-describedby={describedBy(id, hint, null, props["aria-describedby"])} />
      <label htmlFor={id}>{label}</label>
      {hint ? <p id={`${id}-hint`} className="field-hint">{hint}</p> : null}
    </div>
  );
}
