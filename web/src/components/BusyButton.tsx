import { Button } from "../controls/Button.tsx";
import type { ReactNode } from "react";

export interface BusyButtonProps {
  /** While true the button says it is busy and ignores clicks, but keeps keyboard focus. */
  busy: boolean;
  onClick: () => void;
  className?: string;
  /** The id of the text that says why the button is busy or refused. */
  describedBy?: string;
  children: ReactNode;
}

/** A busy button stays in the tab order: the disabled attribute would drop focus to the page. */
export function BusyButton({ busy, onClick, className, describedBy, children }: BusyButtonProps) {
  return (
    <Button
      type="button"
      className={className}
      aria-disabled={busy ? "true" : undefined}
      aria-describedby={describedBy}
      onClick={() => {
        if (!busy) onClick();
      }}
    >
      {children}
    </Button>
  );
}
