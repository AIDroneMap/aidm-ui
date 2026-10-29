import type { ComponentProps } from "react";
export function Notice({ role = "status", ...props }: ComponentProps<"div">) {
  return <div role={role} {...props} />;
}
