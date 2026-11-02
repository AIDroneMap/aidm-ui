import type { ReactNode } from "react";
import { Disclosure } from "./Disclosure.tsx";

export type TimelineRow = {
  id: string;
  label: ReactNode;
  /** The facts in words: first and last time, count. The bar only repeats them. */
  detail: ReactNode;
  start: number;
  end: number;
  /** Left out: the bar is hollow. */
  muted?: boolean;
  /** A control at the end of the row, such as an include switch. */
  control?: ReactNode;
  /** A closer look, behind a disclosure. */
  more?: ReactNode;
  moreLabel?: ReactNode;
};

/** Rows on one shared time axis, such as the flights of a project. */
export function Timeline({ label, start, end, rows }: { label: string; start: number; end: number; rows: readonly TimelineRow[] }) {
  const span = Math.max(end - start, 1);
  const position = (value: number) => Math.min(100, Math.max(0, ((value - start) / span) * 100));
  return (
    <ul className="timeline" aria-label={label}>
      {rows.map((row) => {
        const left = position(row.start);
        const width = Math.max(position(row.end) - left, 0.75);
        return (
          <li key={row.id} className={row.muted ? "timeline-row timeline-muted" : "timeline-row"}>
            <div className="timeline-text">
              <span className="timeline-label">{row.label}</span>
              <span className="timeline-detail">{row.detail}</span>
            </div>
            <div className="timeline-track" aria-hidden="true">
              <span className="timeline-bar" style={{ left: `${left}%`, width: `${width}%` }} />
            </div>
            {row.control ? <div className="timeline-control">{row.control}</div> : null}
            {row.more ? <Disclosure className="timeline-more" label={row.moreLabel}>{row.more}</Disclosure> : null}
          </li>
        );
      })}
    </ul>
  );
}
