import { formatBytes } from "../format.ts";
import { t } from "../i18n/translate.ts";
import { installStatus, installSteps, type InstallStatus } from "../localEngine.ts";
import { messageParams } from "../machine.ts";
import { GuideLink } from "./GuideLink.tsx";
import type { LocalEngineView } from "../../../shared/api-types.ts";
import type { ApiError } from "../../../shared/api-error.ts";

/** The steps in order, each with its size, so the operator knows what is coming before it starts. */
function InstallSteps({ view }: { view: LocalEngineView | null }) {
  const steps = installSteps(view);
  if (steps.length === 0) return null;
  return (
    <ol className="install-steps" aria-label={t("local.install.steps_label")}>
      {steps.map((step) => (
        <li key={step.id} aria-current={step.state === "current" ? "step" : undefined} className={`install-step-${step.state}`}>
          <span>
            {step.size !== null
              ? t(`local.install.item.${step.id}`, { size: formatBytes(step.size, step.id === "kernel" ? "up" : "nearest") })
              : step.id === "kernel"
                ? t("local.install.item.kernel_unknown")
                : t(`local.install.item.${step.id}`)}
          </span>
          <span className="install-step-state">{t(`local.install.item_state.${step.state}`)}</span>
        </li>
      ))}
    </ol>
  );
}

function Note({ error, kind }: { error: ApiError; kind: "problem" | "warning" }) {
  return (
    <div className={kind === "problem" ? "error" : "warning"}>
      <p>
        {t(error.code, messageParams(error))} <GuideLink url={error.data.guideUrl} />
      </p>
    </div>
  );
}

/** The bar, the parts and the try of a download. Only the line above it is announced, so a screen reader hears each step once. */
export function DownloadProgress({ status, progressId }: { status: Extract<InstallStatus, { kind: "downloading" }>; progressId: string }) {
  return (
    <>
      {status.done !== null && status.total !== null ? (
        <progress id={progressId} max={status.total} value={status.done}></progress>
      ) : (
        <progress id={progressId}></progress>
      )}
      {status.done !== null && status.total !== null && (
        <p>{t("local.install.parts", { done: status.done, total: status.total })}</p>
      )}
      {status.attempt > 1 && <p>{t("local.install.attempt", { attempt: status.attempt, max: status.maxAttempts })}</p>}
    </>
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
        {status.kind === "preparing" ? (
          <p>
            {status.step === "approve" || status.step === "init" ? (
              t(`local.install.step.${status.step}`)
            ) : status.step === "kernel" && status.size === null ? (
              // A kernel whose size is not known: the step says so and the bar has no value.
              <label htmlFor={progressId}>{t("local.install.step.kernel_unknown")}</label>
            ) : (
              <label htmlFor={progressId}>
                {t(`local.install.step.${status.step}`, {
                  size: formatBytes(status.size ?? 0, status.step === "kernel" ? "up" : "nearest"),
                })}
              </label>
            )}
          </p>
        ) : status.kind === "downloading" ? (
          <p>
            <label htmlFor={progressId}>
              {t(status.graphics ? "local.install.downloading_gpu" : "local.install.downloading", { size: formatBytes(status.size) })}
            </label>
          </p>
        ) : status.kind === "checking_gpu" ? (
          <p>{t("local.install.checking_gpu")}</p>
        ) : status.kind === "removing_gpu_package" ? (
          <p>{t("local.install.removing_gpu_package", { size: formatBytes(status.size) })}</p>
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
      <InstallSteps view={view} />
      {status.kind === "preparing" && (status.step === "installer" || status.step === "kernel") && (
        // The kernel download shows no progress of its own, so its bar has no value.
        status.step === "installer" && status.received !== null && status.size !== null ? (
          <progress id={progressId} max={status.size} value={status.received}></progress>
        ) : (
          <progress id={progressId}></progress>
        )
      )}
      {status.kind === "downloading" && <DownloadProgress status={status} progressId={progressId} />}
      {view.warnings.map((warning) => (
        <Note key={warning.code} error={warning} kind="warning" />
      ))}
    </div>
  );
}
