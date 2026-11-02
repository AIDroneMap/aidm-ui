import type { ComponentProps, ReactNode } from "react";
import { describedBy } from "./field-description.ts";

type Props = Omit<ComponentProps<"input">, "id"> & {
  id: string;
  label: ReactNode;
  /** One sentence under the field on what to enter. */
  hint?: ReactNode;
  /** What is wrong with the value and how to fix it. Marks the field invalid. */
  error?: ReactNode;
};

export function TextField({ id, label, hint, error, type = "text", ...props }: Props) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type={type}
        {...props}
        aria-describedby={describedBy(id, hint, error, props["aria-describedby"])}
        aria-invalid={error ? true : props["aria-invalid"]}
      />
      {hint ? <p id={`${id}-hint`} className="field-hint">{hint}</p> : null}
      {error ? <p id={`${id}-error`} className="field-error">{error}</p> : null}
    </div>
  );
}
