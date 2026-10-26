import { formatBytes } from "../format.ts";
import { t } from "../i18n/translate.ts";
import { installStatus, installSteps, type InstallStatus } from "../localEngine.ts";
import { messageParams } from "../machine.ts";
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

/** "200 MiB of 683 MiB, 3 MiB per second": the same words for the engine and for every download of the Mac steps. */
function ReceivedLine({ received, size, speed }: { received: number; size: number | null; speed: number | null }) {
  if (size === null) return <p>{formatBytes(received)}</p>;
  return (
    <p>
      {speed !== null && speed > 0
        ? t("local.install.received_speed", { received: formatBytes(received), size: formatBytes(size), speed: formatBytes(speed) })
        : t("local.install.received", { received: formatBytes(received), size: formatBytes(size) })}
    </p>
  );
}

/**
 * The bar, the bytes, the speed and the parts of a download, and why its
 * connection last broke. Only the line above it is announced, so a screen
 * reader hears each step once.
 */
export function DownloadProgress({ status, progressId }: { status: Extract<InstallStatus, { kind: "downloading" }>; progressId: string }) {
  const received = status.received;
  return (
    <>
      {received !== null ? (
        <progress id={progressId} max={status.size} value={Math.min(received, status.size)}></progress>
      ) : status.done !== null && status.total !== null ? (
        <progress id={progressId} max={status.total} value={status.done}></progress>
      ) : (
        <progress id={progressId}></progress>
      )}
      {received !== null && <ReceivedLine received={received} size={status.size} speed={status.speed} />}
      {status.done !== null && status.total !== null && (
        <p>{t("local.install.parts", { done: status.done, total: status.total })}</p>
      )}
      {status.retries > 0 && status.lastRetry !== null && (
        <p>
          {t(status.lastRetry.code, messageParams(status.lastRetry))} {t("local.install.retries", { count: status.retries })}
        </p>
      )}
    </>
  );
}

/**
 * Where the install of the local engine stands, in words. Only the line in the
 * status region changes when the step changes, so a screen reader hears each
 * step once; the counts below it change often and stay silent.
 */
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

export function LocalInstallStatus({ view, withSteps = true }: { view: LocalEngineView | null; withSteps?: boolean }) {
  const status = installStatus(view);
  if (!view) return <div role="status"></div>;
  // A download or a load that failed says why, under the general sentence.
  const cause = causeOf(view.problem);
  const failedStep = view.install !== null && view.install.phase === "failed" && view.install.steps.length > 1 ? view.install.step : null;
  const progressId = "install-progress";
  return (
    <div className="install-status">
      <div role="status">
        {status.kind === "preparing" ? (
          <p>
            {status.step === "approve" || status.step === "service" ? (
              t(`local.install.step.${status.step}`)
            ) : status.step === "kernel" && status.size === null ? (
              // A kernel whose size is not known: the step says so and the bar has no value.
              <label htmlFor={progressId}>{t("local.install.step.kernel_unknown")}</label>
            ) : (
              <label htmlFor={progressId}>
                {t(`local.install.step.${status.step}`, {
                  size: formatBytes(status.size ?? 0),
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
        ) : status.kind === "loading" ? (
          <p>{t("local.install.loading")}</p>
        ) : status.kind === "checking_gpu" ? (
          <p>{t("local.install.checking_gpu")}</p>
        ) : status.kind === "removing_gpu_package" ? (
          <p>{t("local.install.removing_gpu_package", { size: formatBytes(status.size) })}</p>
        ) : status.kind === "starting" ? (
          <p>{t("local.install.starting")}</p>
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
      {withSteps && <InstallSteps view={view} />}
      {view.lastTry !== null && (status.kind === "preparing" || status.kind === "downloading" || status.kind === "loading") && (
        <p className="hint">{t("local.install.last_try", { reason: lastTryText(view.lastTry) })}</p>
      )}
      {status.kind === "preparing" && (status.step === "installer" || status.step === "kernel" || status.step === "init") && (
        // Every download of the Mac steps reports its bytes; a kernel the tool downloads itself may not say its size.
        status.received !== null && status.size !== null ? (
          <progress id={progressId} max={status.size} value={Math.min(status.received, status.size)}></progress>
        ) : (
          <progress id={progressId}></progress>
        )
      )}
      {status.kind === "preparing" && (status.step === "installer" || status.step === "kernel" || status.step === "init") && status.received !== null && (
        <ReceivedLine received={status.received} size={status.size} speed={status.speed} />
      )}
      {status.kind === "downloading" && <DownloadProgress status={status} progressId={progressId} />}
      {view.warnings.map((warning) => (
        <Note key={warning.code} error={warning} kind="warning" />
      ))}
    </div>
  );
}
