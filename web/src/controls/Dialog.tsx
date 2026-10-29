import type { ComponentProps } from "react";
type Props = ComponentProps<"dialog"> & { label: string };
export function Dialog({ label, ...props }: Props) {
  return <dialog aria-label={label} {...props} />;
}
