import type { ComponentProps, ReactNode } from "react";
type Props = ComponentProps<"details"> & { label: ReactNode };
export function Disclosure({ label, children, ...props }: Props) {
  return <details {...props}><summary>{label}</summary>{children}</details>;
}
