import type { ComponentProps, ReactElement } from "react";

type Props = Omit<ComponentProps<"button">, "children" | "aria-label"> & {
  /** The words a screen reader says and the tooltip shows, since the button has no visible text. */
  label: string;
  icon: ReactElement;
};

/** A square quiet button with one icon. */
export function IconButton({ type = "button", label, icon, className, ...props }: Props) {
  return (
    <button type={type} className={className ? `icon-button ${className}` : "icon-button"} aria-label={label} title={label} {...props}>
      {icon}
    </button>
  );
}
