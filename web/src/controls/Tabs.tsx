import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

export type Tab = { id: string; label: ReactNode; content: ReactNode };

type Props = {
  /** Names the row of tabs for screen readers. */
  label: string;
  tabs: readonly Tab[];
  /** The open tab when the parent keeps it, for example in the address. */
  selected?: string;
  onSelect?: (id: string) => void;
};

/**
 * Views of one thing side by side. Tab reaches the open tab only; the arrow
 * keys, Home and End move between tabs and open them, as the WAI-ARIA tabs
 * pattern describes.
 */
export function Tabs({ label, tabs, selected, onSelect }: Props) {
  const base = useId();
  const [own, setOwn] = useState(tabs[0]?.id);
  const current = selected ?? own;
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  function choose(id: string) {
    setOwn(id);
    onSelect?.(id);
  }
  function move(event: KeyboardEvent) {
    const index = tabs.findIndex((tab) => tab.id === current);
    const next = event.key === "ArrowRight" ? index + 1 : event.key === "ArrowLeft" ? index - 1 : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    const tab = tabs[(next + tabs.length) % tabs.length]!;
    choose(tab.id);
    buttons.current.get(tab.id)?.focus();
  }
  return (
    <div className="tabs">
      <div role="tablist" aria-label={label} className="tabs-list" onKeyDown={move}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            ref={(element) => { if (element) buttons.current.set(tab.id, element); else buttons.current.delete(tab.id); }}
            type="button"
            role="tab"
            id={`${base}-tab-${tab.id}`}
            className="tabs-tab"
            aria-selected={tab.id === current}
            aria-controls={`${base}-panel-${tab.id}`}
            tabIndex={tab.id === current ? 0 : -1}
            onClick={() => choose(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tabpanel"
          id={`${base}-panel-${tab.id}`}
          aria-labelledby={`${base}-tab-${tab.id}`}
          className="tabs-panel"
          tabIndex={0}
          hidden={tab.id !== current}
        >
          {tab.id === current ? tab.content : null}
        </div>
      ))}
    </div>
  );
}
