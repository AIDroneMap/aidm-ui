import type { ComponentProps, ReactNode } from "react";
type Props = Omit<ComponentProps<"progress">, "id"> & { id: string; label: ReactNode };
export function Progress({ id, label, ...props }: Props) {
  return <div className="field"><label htmlFor={id}>{label}</label><progress id={id} {...props} /></div>;
}
