import type { ComponentProps, ReactNode } from "react";
type Props = Omit<ComponentProps<"input">, "id" | "type"> & { id: string; label: ReactNode };
export function Toggle({ id, label, ...props }: Props) {
  return <div className="check"><input id={id} type="checkbox" {...props} /><label htmlFor={id}>{label}</label></div>;
}
