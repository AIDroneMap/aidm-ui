import type { ComponentProps, ReactNode } from "react";

type Props = Omit<ComponentProps<"input">, "id"> & { id: string; label: ReactNode };
export function TextField({ id, label, type = "text", ...props }: Props) {
  return <div className="field"><label htmlFor={id}>{label}</label><input id={id} type={type} {...props} /></div>;
}
