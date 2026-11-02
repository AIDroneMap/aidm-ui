import type { ReactNode } from "react";

export type Segment<Value extends string> = { value: Value; label: ReactNode };

type Props<Value extends string> = {
  name: string;
  legend: ReactNode;
  /** Keep the legend for screen readers only, when the screen already says what the choice is. */
  hideLegend?: boolean;
  options: readonly Segment<Value>[];
  value: Value;
  onChange: (value: Value) => void;
};

/** Two to four choices side by side, one always chosen. Native radio buttons underneath, so the arrow keys move the choice. */
export function SegmentedControl<Value extends string>({ name, legend, hideLegend, options, value, onChange }: Props<Value>) {
  return (
    <fieldset className="segmented">
      <legend className={hideLegend ? "visually-hidden" : undefined}>{legend}</legend>
      <div className="segmented-track">
        {options.map((option) => {
          const id = `${name}-${option.value}`;
          return (
            <span className="segmented-item" key={option.value}>
              <input className="segmented-input" id={id} type="radio" name={name} value={option.value} checked={value === option.value} onChange={() => onChange(option.value)} />
              <label className="segmented-option" htmlFor={id}>{option.label}</label>
            </span>
          );
        })}
      </div>
    </fieldset>
  );
}
