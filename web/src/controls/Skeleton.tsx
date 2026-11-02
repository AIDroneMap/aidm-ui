import { t } from "../i18n/translate.ts";

/** Grey rows in place of content that is on its way. Screen readers hear that it is loading. */
export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="skeleton" role="status" aria-busy="true">
      <span className="visually-hidden">{t("ui.loading")}</span>
      {Array.from({ length: lines }, (_, index) => <span className="skeleton-line" aria-hidden="true" key={index} />)}
    </div>
  );
}
