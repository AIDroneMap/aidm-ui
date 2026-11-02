import { useId, useRef, type ReactNode } from "react";

type Props = {
  /** The words on the button that opens it, such as "More". */
  trigger: ReactNode;
  /** Names the open panel for screen readers. */
  label: string;
  children: ReactNode;
};

/**
 * A panel that opens on click, Enter or Space, never on hover alone. It uses
 * the browser's popover: Escape or a click outside closes it, and Tab from
 * the button moves into it.
 */
export function Popover({ trigger, label, children }: Props) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  function place() {
    const anchor = button.current?.getBoundingClientRect();
    const element = panel.current;
    if (!anchor || !element) return;
    const width = element.offsetWidth;
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8));
    const below = anchor.bottom + 4 + element.offsetHeight <= window.innerHeight;
    element.style.left = `${left}px`;
    element.style.top = below ? `${anchor.bottom + 4}px` : `${Math.max(8, anchor.top - 4 - element.offsetHeight)}px`;
  }
  return (
    <>
      <button ref={button} type="button" className="secondary popover-trigger" popoverTarget={id}>{trigger}</button>
      <div ref={panel} id={id} popover="auto" role="dialog" aria-label={label} className="popover" onToggle={(event) => { if (event.newState === "open") place(); }}>
        {children}
      </div>
    </>
  );
}
