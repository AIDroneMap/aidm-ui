import { useEffect, useRef } from "react";
import { t } from "../i18n/translate.ts";

/** How far from the end, in pixels, the panel still counts as scrolled to the end. */
const AT_END = 24;

/**
 * The engine log. The panel can be reached with the keyboard so it can be
 * scrolled. New lines follow the end of the log unless the operator scrolled up.
 */
export function EngineLog({ id, lines }: { id: string; lines: string[] }) {
  const panel = useRef<HTMLPreElement>(null);
  const following = useRef(true);
  useEffect(() => {
    const element = panel.current;
    if (element && following.current) element.scrollTop = element.scrollHeight;
  }, [lines]);
  return (
    <pre
      id={id}
      ref={panel}
      className="run-log"
      tabIndex={0}
      role="region"
      aria-label={t("engines.log.label")}
      onScroll={(event) => {
        const element = event.currentTarget;
        following.current = element.scrollHeight - element.scrollTop - element.clientHeight <= AT_END;
      }}
    >
      {lines.length === 0 ? t("engines.log.empty") : lines.join("\n")}
    </pre>
  );
}
