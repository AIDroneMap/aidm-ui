import type { ReactNode } from "react";
import { IconImage } from "../icons/icons.tsx";

export type Thumbnail = {
  id: string;
  /** The file name, shown under the picture. */
  name: string;
  /** The address of the picture. Without one the tile shows the name and the detail on a plain background. */
  src?: string | null;
  /** A short line under the name, such as the camera. */
  detail?: ReactNode;
};

type Props = {
  label: string;
  items: readonly Thumbnail[];
  /** Makes each tile a button. */
  onOpen?: (id: string) => void;
  /** Under the grid: a button for the next page, or a skeleton while it loads. */
  footer?: ReactNode;
};

/** Pictures in a grid that fills the width. Pictures load only as they scroll into view. */
export function ThumbnailGrid({ label, items, onOpen, footer }: Props) {
  return (
    <div className="thumbnail-grid-wrap">
      <ul className="thumbnail-grid" aria-label={label}>
        {items.map((item) => {
          // Spans, not a figure: a button may hold only phrasing content, and a figure inside one hides its caption from the button's name.
          const tile = (
            <span className="thumbnail">
              {item.src
                ? <img src={item.src} alt="" loading="lazy" decoding="async" />
                : <span className="thumbnail-none"><IconImage /></span>}
              <span className="thumbnail-caption">
                <span className="thumbnail-name">{item.name}</span>
                {item.detail ? <span className="thumbnail-detail">{item.detail}</span> : null}
              </span>
            </span>
          );
          return <li key={item.id}>{onOpen ? <button type="button" className="thumbnail-button" onClick={() => onOpen(item.id)}>{tile}</button> : tile}</li>;
        })}
      </ul>
      {footer}
    </div>
  );
}
