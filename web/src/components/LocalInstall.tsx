import { formatBytes } from "../format.ts";
import { t } from "../i18n/translate.ts";
import { installStatus, installSteps, type InstallStatus } from "../localEngine.ts";
import { messageParams } from "../machine.ts";
import { DownloadBlock, interruptionText } from "./DownloadBlock.tsx";
import { GuideLink } from "./GuideLink.tsx";
import type { LocalEngineView } from "../../../shared/api-types.ts";
import type { ApiError } from "../../../shared/api-error.ts";

/** The steps in order, each with its size, so the operator knows what is coming before it starts. */
export function InstallSteps({ view }: { view: LocalEngineView | null }) {
  const steps = installSteps(view);
  if (steps.length === 0) return null;
  return (
    <ol className="install-steps" aria-label={t("local.install.steps_label")}>
      {steps.map((step) => (
        <li key={step.id} aria-current={step.state === "current" ? "step" : undefined} className={`install-step-${step.state}`}>
          <span>
            {step.size !== null
              ? t(`local.install.item.${step.id}`, { size: formatBytes(step.size) })
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

/** The cause an install failure carries in its data, when it is a message code. */
function causeOf(problem: ApiError | null): ApiError | null {
  const cause = problem?.data.cause as Partial<ApiError> | null | undefined;
  return typeof cause?.code === "string" && typeof cause.data === "object" && cause.data !== null ? (cause as ApiError) : null;
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

/** The download of the engine package, as the one download block. The parts of the image, when it reports them, add a line and a bar of their own while no bytes are counted. */
export function DownloadProgress({ status, progressId }: { status: Extract<InstallStatus, { kind: "downloading" }>; progressId: string }) {
  const parts = status.done !== null && status.total !== null ? { done: status.done, total: status.total } : null;
  const reused = status.reused !== null && status.reused > 0;
  return (
    <DownloadBlock
      title={t(status.graphics ? "local.install.downloading_gpu" : "local.install.downloading", { size: formatBytes(status.size) })}
      received={status.received}
      size={status.size}
      speed={status.speed}
      partsBar={parts === null ? null : { value: parts.done, max: parts.total }}
      extra={
        parts === null && !reused ? null : (
          <>
            {parts !== null && <p>{t("local.install.parts", parts)}</p>}
            {reused && <p>{t("local.install.reused", { size: formatBytes(status.reused ?? 0) })}</p>}
          </>
        )
      }
      interruption={interruptionText(status.retries, status.lastRetry)}
      progressId={progressId}
    />
  );
}

/** A download of the Mac steps: the installer, the Linux system or the startup files. Every one reports its bytes; a kernel the tool downloads itself may not say its size. */
function StepDownload({ status, progressId }: { status: Extract<InstallStatus, { kind: "preparing" }>; progressId: string }) {
  return (
    <DownloadBlock
      // A kernel whose size is not known: the step says so and the bar has no value.
      title={
        status.step === "kernel" && status.size === null
          ? t("local.install.step.kernel_unknown")
          : t(`local.install.step.${status.step}`, { size: formatBytes(status.size ?? 0) })
      }
      received={status.received}
      size={status.size}
      speed={status.speed}
      interruption={interruptionText(status.retries, status.lastRetry)}
      progressId={progressId}
    />
  );
}

/** The steps that download something. Approval and the service start download nothing. */
const DOWNLOADS = new Set(["installer", "kernel", "init", "engine"]);

/**
 * What the install downloads in all, said before the button. The steps of a
 * Mac each add their size; elsewhere it is the engine package alone. A size
 * that is not known (a kernel the tool fetches itself) makes it "at least".
 */
export function DownloadTotal({ view, engineSize }: { view: LocalEngineView | null; engineSize: number }) {
  const steps = installSteps(view);
  const downloads = steps.length > 0 ? steps.filter((step) => DOWNLOADS.has(step.id)) : [{ id: "engine", size: engineSize }];
  const total = downloads.reduce((sum, step) => sum + (step.size ?? 0), 0);
  const unknown = downloads.some((step) => step.size === null);
  return <p className="install-total">{t(unknown ? "wizard.install.total_at_least" : "wizard.install.total", { size: formatBytes(total) })}</p>;
}

/** Why the try before this one stopped, as one sentence with the cause it carried. */
function lastTryText(error: ApiError): string {
  const cause = causeOf(error);
  return `${t(error.code, messageParams(error))}${cause === null ? "" : ` ${t(cause.code, messageParams(cause))}`}`;
}

/**
 * Where the install of the local engine stands, in words. Only the line in the
 * status region changes when the step changes, so a screen reader hears each
 * step once; the counts below it change often and stay silent. A download is
 * the shared download block, whose first line is that status line.
 */
export function LocalInstallStatus({ view, withSteps = true }: { view: LocalEngineView | null; withSteps?: boolean }) {
  const status = installStatus(view);
  if (!view) return <div role="status"></div>;
  // A download or a load that failed says why, under the general sentence.
  const cause = causeOf(view.problem);
  const failedStep = view.install !== null && view.install.phase === "failed" && view.install.steps.length > 1 ? view.install.step : null;
  const progressId = "install-progress";
  // One place in the tree for every download, so the status line stays the same element from one step to the next.
  const download =
    status.kind === "downloading" ? (
      <DownloadProgress status={status} progressId={progressId} />
    ) : status.kind === "preparing" && status.step !== "approve" && status.step !== "service" ? (
      <StepDownload status={status} progressId={progressId} />
    ) : null;
  return (
    <div className="install-status">
      {download === null && (
        <div role="status">
          {status.kind === "preparing" ? (
            <p>{t(`local.install.step.${status.step}`)}</p>
          ) : status.kind === "loading" ? (
            <p>{t("local.install.loading")}</p>
          ) : status.kind === "checking_gpu" ? (
            <p>{t("local.install.checking_gpu")}</p>
          ) : status.kind === "removing_gpu_package" ? (
            <p>{t("local.install.removing_gpu_package", { size: formatBytes(status.size) })}</p>
          ) : status.kind === "starting" ? (
            <p>{t(view.install?.steps.some((step) => step.id === "network") ? "local.install.starting_network" : "local.install.starting")}</p>
          ) : status.kind === "ready" ? (
            <p>{t("local.install.ready")}</p>
          ) : status.kind === "failed" ? (
            <>
              <p className="error">
                {view.problem ? t(view.problem.code, messageParams(view.problem)) : t("local.install.failed")}
                {cause !== null && ` ${t(cause.code, messageParams(cause))}`}
              </p>
              {/* An install with steps says which one stopped, so each failure names its own step. */}
              {failedStep !== null && <p>{t("local.install.failed_step", { step: t(`local.install.step_name.${failedStep}`) })}</p>}
            </>
          ) : status.kind === "state" ? (
            <p>{t("local.install.state", { state: t(`engine.state.${view.state}`) })}</p>
          ) : null}
        </div>
      )}
      {withSteps && <InstallSteps view={view} />}
      {view.lastTry !== null && (status.kind === "preparing" || status.kind === "downloading" || status.kind === "loading") && (
        <p className="hint">{t("local.install.last_try", { reason: lastTryText(view.lastTry) })}</p>
      )}
      {download}
      {view.warnings.map((warning) => (
        <Note key={warning.code} error={warning} kind="warning" />
      ))}
    </div>
  );
}
