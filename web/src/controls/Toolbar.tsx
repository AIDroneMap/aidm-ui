import { useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

const ITEMS = "button:not(:disabled), a[href], select:not(:disabled), input:not(:disabled)";

/**
 * A row of controls over a viewer. Tab enters and leaves it in one step; the
 * left and right arrows, Home and End move between its controls, as the
 * WAI-ARIA toolbar pattern describes.
 */
export function Toolbar({ label, children }: { label: string; children: ReactNode }) {
  const bar = useRef<HTMLDivElement>(null);
  const active = useRef(0);
  const items = () => [...(bar.current?.querySelectorAll<HTMLElement>(ITEMS) ?? [])];
  useLayoutEffect(() => {
    const all = items();
    active.current = Math.min(active.current, Math.max(all.length - 1, 0));
    all.forEach((item, index) => { item.tabIndex = index === active.current ? 0 : -1; });
  });
  function focus(index: number) {
    const all = items();
    if (!all.length) return;
    active.current = (index + all.length) % all.length;
    all.forEach((item, position) => { item.tabIndex = position === active.current ? 0 : -1; });
    all[active.current]!.focus();
  }
  function move(event: KeyboardEvent) {
    // Inside a field the arrow keys move the text cursor or the choice, so they stay there.
    if ((event.target as HTMLElement).matches("select, textarea, input:not([type=checkbox], [type=radio], [type=button])")) return;
    const next = event.key === "ArrowRight" ? active.current + 1 : event.key === "ArrowLeft" ? active.current - 1 : event.key === "Home" ? 0 : event.key === "End" ? items().length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    focus(next);
  }
  return (
    <div
      ref={bar}
      role="toolbar"
      aria-label={label}
      className="toolbar"
      onKeyDown={move}
      onFocus={(event) => { const index = items().indexOf(event.target as HTMLElement); if (index >= 0) active.current = index; }}
    >
      {children}
    </div>
  );
}
