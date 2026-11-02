import type { ComponentProps } from "react";
import { IconCircleCheck, IconCircleX, IconInfo, IconTriangleAlert } from "../icons/icons.tsx";

export type NoticeTone = "info" | "ok" | "warn" | "danger";

const ICONS = { info: IconInfo, ok: IconCircleCheck, warn: IconTriangleAlert, danger: IconCircleX };

/** A boxed message in the tone of what it says. The icon repeats the tone; the words carry it. */
export function Notice({ role = "status", tone = "info", className, children, ...props }: ComponentProps<"div"> & { tone?: NoticeTone }) {
  const Icon = ICONS[tone];
  return (
    <div role={role} className={`notice notice-${tone}${className ? ` ${className}` : ""}`} {...props}>
      <Icon />
      <div className="notice-body">{children}</div>
    </div>
  );
}
