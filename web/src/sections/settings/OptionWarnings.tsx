import type { ReactNode } from "react";
import type { OptionWarning } from "../../../../shared/option-warnings.ts";
import { Notice } from "../../controls/Notice.tsx";
import { t } from "../../i18n/translate.ts";
import "./OptionWarnings.css";

/** The words of one warning. Other options are named by their plain names. */
export function warningText(warning: OptionWarning): ReactNode {
  if (warning.code === "warn.end_with") return <>
    <p>{t("warn.end_with", { stage: t(`run.stage.${warning.data?.stage}.name`) })}</p>
    <ul>{warning.data?.lost?.map((output) => <li key={output}>{t(`warn.lost.${output}`)}</li>)}</ul>
  </>;
  return <p>{t(warning.code, { cores: warning.data?.cores ?? "", skip3d: t("option.skip-3dmodel.name"), classify: t("option.pc-classify.name") })}</p>;
}

/** The warnings that name this row, as notices under it. They inform and never block. */
export function OptionWarnings({ id, option, warnings }: { id: string; option: string; warnings: readonly OptionWarning[] }) {
  const mine = warnings.filter((warning) => warning.options.includes(option));
  if (!mine.length) return null;
  return <div className="option-warnings" id={id}>
    {mine.map((warning) => <Notice key={warning.code} tone="warn" aria-label={t("warn.title")}>{warningText(warning)}</Notice>)}
  </div>;
}
