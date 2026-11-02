import type { ComponentProps, ReactNode } from "react";
type Props = ComponentProps<"table"> & { label: ReactNode; dense?: boolean };
export function Table({ label, dense, children, className, ...props }: Props) {
  const classes = [dense ? "table-dense" : "", className ?? ""].filter(Boolean).join(" ");
  return <table className={classes || undefined} {...props}><caption>{label}</caption>{children}</table>;
}
