import type { ComponentProps, ReactNode } from "react";
type Props = ComponentProps<"table"> & { label: ReactNode };
export function Table({ label, children, ...props }: Props) {
  return <table {...props}><caption>{label}</caption>{children}</table>;
}
