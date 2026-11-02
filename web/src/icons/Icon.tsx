import type { ReactNode } from "react";

export type IconProps = {
  /** Words for an icon that stands alone. Without them the icon is hidden from screen readers, because the text next to it says the same. */
  label?: string;
  className?: string;
};

/** A 24 pixel line icon in the colour of the text around it. */
export function Icon({ label, className, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ? `icon ${className}` : "icon"}
      focusable="false"
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      {children}
    </svg>
  );
}
