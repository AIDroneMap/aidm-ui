import type { ReactNode } from "react";

export type RadioOption<Value extends string> = { value: Value; label: ReactNode; hint?: ReactNode; disabled?: boolean };

type Props<Value extends string> = {
  name: string;
  legend: ReactNode;
  options: readonly RadioOption<Value>[];
  value: Value | null;
  onChange: (value: Value) => void;
  disabled?: boolean;
  /** The id of the text that describes the whole group. */
  describedBy?: string;
  /** While true the choices say they are unavailable and ignore a change, but keep the focus where it is. */
  busy?: boolean;
  /** What follows the choices inside the group, such as a hint, an error or a status line. */
  children?: ReactNode;
};

/** One choice out of a few, each with a sentence on when to pick it. The arrow keys move between choices, as in every native radio group. */
export function RadioGroup<Value extends string>({ name, legend, options, value, onChange, disabled, describedBy, busy, children }: Props<Value>) {
  return (
    <fieldset className="radio-group" disabled={disabled} aria-describedby={describedBy}>
      <legend>{legend}</legend>
      {options.map((option) => {
        const id = `${name}-${option.value}`;
        return (
          <div className="check" key={option.value}>
            <input
              id={id}
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              disabled={option.disabled}
              aria-disabled={busy ? "true" : undefined}
              onChange={() => {
                if (!busy) onChange(option.value);
              }}
              aria-describedby={option.hint ? `${id}-hint` : undefined}
            />
            <label htmlFor={id}>{option.label}</label>
            {option.hint ? <p id={`${id}-hint`} className="field-hint">{option.hint}</p> : null}
          </div>
        );
      })}
      {children}
    </fieldset>
  );
}
