import type { ComponentProps, ReactNode } from "react";
import { describedBy } from "./field-description.ts";

type Props = Omit<ComponentProps<"textarea">, "id"> & {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
};

export function TextAreaField({ id, label, hint, error, ...props }: Props) {
  return (
    <div className="field text-area-field">
      <label htmlFor={id}>{label}</label>
      <textarea
        id={id}
        {...props}
        aria-describedby={describedBy(id, hint, error, props["aria-describedby"])}
        aria-invalid={error ? true : props["aria-invalid"]}
      />
      {hint ? <p id={`${id}-hint`} className="field-hint">{hint}</p> : null}
      {error ? <p id={`${id}-error`} className="field-error">{error}</p> : null}
    </div>
  );
}
