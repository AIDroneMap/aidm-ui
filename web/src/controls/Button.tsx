import type { ComponentProps } from "react";

export type ButtonVariant = "primary" | "secondary" | "quiet" | "danger";

type Props = ComponentProps<"button"> & {
  /** Primary is the one main action of a screen. Danger is only for the button that confirms a destructive action. */
  variant?: ButtonVariant;
};

export function Button({ type = "button", variant = "primary", className, ...props }: Props) {
  const classes = [variant === "primary" ? "" : variant, className ?? ""].filter(Boolean).join(" ");
  return <button type={type} className={classes || undefined} {...props} />;
}
