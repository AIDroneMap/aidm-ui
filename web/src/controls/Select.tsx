import type { ComponentProps, ReactNode } from "react";
import { describedBy } from "./field-description.ts";

type Props = Omit<ComponentProps<"select">, "id"> & { id: string; label: ReactNode; hint?: ReactNode };

export function Select({ id, label, hint, ...props }: Props) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} {...props} aria-describedby={describedBy(id, hint, null, props["aria-describedby"])} />
      {hint ? <p id={`${id}-hint`} className="field-hint">{hint}</p> : null}
    </div>
  );
}
