import { formatBytes } from "../format.ts";
import { t } from "../i18n/translate.ts";
import { installStatus } from "../localEngine.ts";
import { messageParams } from "../machine.ts";
import { GuideLink } from "./GuideLink.tsx";
import type { LocalEngineView } from "../../../shared/api-types.ts";
import type { ApiError } from "../../../shared/api-error.ts";

function Note({ error, kind }: { error: ApiError; kind: "problem" | "warning" }) {
  return (
    <div className={kind === "problem" ? "error" : "warning"}>
      <p>
        {t(error.code, messageParams(error))} <GuideLink url={error.data.guideUrl} />
      </p>
    </div>
  );
}

/**
 * Where the install of the local engine stands, in words. Only the line in the
 * status region changes when the step changes, so a screen reader hears each
 * step once; the counts below it change often and stay silent.
 */
export function LocalInstallStatus({ view }: { view: LocalEngineView | null }) {
  const status = installStatus(view);
  if (!view) return <div role="status"></div>;
  const progressId = "install-progress";
  return (
    <div className="install-status">
      <div role="status">
        {status.kind === "downloading" ? (
          <p>
            <label htmlFor={progressId}>{t("local.install.downloading", { size: formatBytes(status.size) })}</label>
          </p>
        ) : status.kind === "starting" ? (
          <p>{t("local.install.starting")}</p>
        ) : status.kind === "ready" ? (
          <p>{t("local.install.ready")}</p>
        ) : status.kind === "failed" ? (
          <p className="error">{view.problem ? t(view.problem.code, messageParams(view.problem)) : t("local.install.failed")}</p>
        ) : status.kind === "state" ? (
          <p>{t("local.install.state", { state: t(`engine.state.${view.state}`) })}</p>
        ) : null}
      </div>
      {status.kind === "downloading" && (
        <>
          {status.done !== null && status.total !== null ? (
            <progress id={progressId} max={status.total} value={status.done}></progress>
          ) : (
            <progress id={progressId}></progress>
          )}
          {status.done !== null && status.total !== null && (
            <p>{t("local.install.parts", { done: status.done, total: status.total })}</p>
          )}
          {status.attempt > 1 && (
            <p>{t("local.install.attempt", { attempt: status.attempt, max: status.maxAttempts })}</p>
          )}
        </>
      )}
      {view.warnings.map((warning) => (
        <Note key={warning.code} error={warning} kind="warning" />
      ))}
    </div>
  );
}
