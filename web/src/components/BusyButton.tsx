import type { ReactNode } from "react";

export interface BusyButtonProps {
  /** While true the button says it is busy and ignores clicks, but keeps keyboard focus. */
  busy: boolean;
  onClick: () => void;
  className?: string;
  children: ReactNode;
}

/** A busy button stays in the tab order: the disabled attribute would drop focus to the page. */
export function BusyButton({ busy, onClick, className, children }: BusyButtonProps) {
  return (
    <button
      type="button"
      className={className}
      aria-disabled={busy ? "true" : undefined}
      onClick={() => {
        if (!busy) onClick();
      }}
    >
      {children}
    </button>
  );
}
