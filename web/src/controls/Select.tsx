import type { ComponentProps, ReactNode } from "react";
type Props = Omit<ComponentProps<"select">, "id"> & { id: string; label: ReactNode };
export function Select({ id, label, ...props }: Props) {
  return <div className="field"><label htmlFor={id}>{label}</label><select id={id} {...props} /></div>;
}
