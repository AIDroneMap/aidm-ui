import type { ComponentProps, ReactNode } from "react";
type Props = Omit<ComponentProps<"progress">, "id"> & {
  id: string;
  label: ReactNode;
  /** Keep the label for screen readers only, when the words next to the bar already say what it measures. */
  hideLabel?: boolean;
};
export function Progress({ id, label, hideLabel, ...props }: Props) {
  return <div className="field"><label htmlFor={id} className={hideLabel ? "visually-hidden" : undefined}>{label}</label><progress id={id} {...props} /></div>;
}
