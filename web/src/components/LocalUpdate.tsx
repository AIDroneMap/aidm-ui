import { useEffect, useRef, useState } from "react";
import { api, asApiFailure, type ApiFailure } from "../api.ts";
import { formatBytes } from "../format.ts";
import { t } from "../i18n/translate.ts";
import { finishedVersion, progressStatus, updateProblem } from "../localEngine.ts";
import { messageParams } from "../machine.ts";
import { BusyButton } from "./BusyButton.tsx";
import { ErrorMessage } from "./ErrorMessage.tsx";
import { DownloadProgress } from "./LocalInstall.tsx";
import type { ApiError } from "../../../shared/api-error.ts";
import type { LocalEngineView } from "../../../shared/api-types.ts";

export interface UpdateViewProps {
  view: LocalEngineView;
  /** True while a click is on its way to the server. */
  requesting: boolean;
  failure: ApiFailure | null;
  /** The version the engine has just changed to, to say aloud; null otherwise. */
  announcement?: string | null;
  onUpdate: () => void;
  onRollback: () => void;
}

/** The new engine version on offer, the way back to the previous one, and where either stands. Nothing when there is neither. */
export function UpdateView({ view, requesting, failure, announcement = null, onUpdate, onRollback }: UpdateViewProps) {
  const { update } = view;
  const left: ApiError | null = updateProblem(view);
  if (view.installed === null) return null;
  if (update.available === null && update.previous === null && update.applying === null && left === null && failure === null && announcement === null) {
    return null;
  }

  const working = requesting || update.applying !== null;
  // Refused for a reason the operator can fix: the button says so instead of vanishing.
  const refused = update.blockedBy !== null;
  const status = progressStatus(update.applying);
  const progressId = "update-progress";

  return (
    <div id="local-update" tabIndex={-1} className="local-update" aria-labelledby="local-update-title">
      <h3 id="local-update-title">{t("local.update.title")}</h3>
      <p>{t("local.update.hint")}</p>
      {update.available !== null && (
        <>
          <p>
            {t("local.update.available", { version: update.available.packageVersion, size: formatBytes(update.available.size) })}
          </p>
          <div className="actions">
            <BusyButton busy={working || refused} describedBy={refused ? "local-update-blocked" : undefined} onClick={onUpdate}>
              {working ? t("local.update.button_busy") : t("local.update.button")}
            </BusyButton>
          </div>
        </>
      )}
      {update.previous !== null && (
        <div className="actions">
          <BusyButton busy={working || refused} describedBy={refused ? "local-update-blocked" : undefined} onClick={onRollback}>
            {t("local.update.rollback", { version: update.previous.packageVersion })}
          </BusyButton>
        </div>
      )}
      {update.blockedBy !== null && (
        <p id="local-update-blocked" className="hint">
          {t(update.blockedBy.code, messageParams(update.blockedBy))}
        </p>
      )}
      <div role="status">
        {status.kind === "downloading" ? (
          <p>
            <label htmlFor={progressId}>{t("local.install.downloading", { size: formatBytes(status.size) })}</label>
          </p>
        ) : status.kind === "loading" ? (
          <p>{t("local.install.loading")}</p>
        ) : status.kind === "starting" ? (
          <p>{t("local.update.starting")}</p>
        ) : announcement !== null ? (
          <p>{t("local.update.done", { version: announcement })}</p>
        ) : null}
      </div>
      {status.kind === "downloading" && <DownloadProgress status={status} progressId={progressId} />}
      {failure !== null ? (
        <ErrorMessage failure={failure} />
      ) : (
        left !== null &&
        update.applying === null && (
          <p role="alert" className="error">
            {t(left.code, messageParams(left))}
          </p>
        )
      )}
    </div>
  );
}

/** The update block with its state: a click asks the server, and the live view carries the rest. */
export function LocalUpdate(props: {
  view: LocalEngineView;
  onView: (view: LocalEngineView) => void;
  onAuthRequired: () => void;
}) {
  const [requesting, setRequesting] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const wasApplying = useRef(false);
  const lastView = useRef(props.view);
  const [announcement, setAnnouncement] = useState<string | null>(null);

  // A successful change of version is said in the status region. A new click clears it.
  useEffect(() => {
    const version = finishedVersion(lastView.current, props.view);
    if (version !== null) setAnnouncement(version);
    else if (props.view.update.applying !== null) setAnnouncement(null);
    lastView.current = props.view;
  }, [props.view]);

  // When the work ends, the button that was pressed may be gone. Focus stays in this block instead of falling to the page.
  const applying = props.view.update.applying !== null;
  useEffect(() => {
    if (wasApplying.current && !applying) {
      const active = document.activeElement;
      if (active === null || active === document.body) document.getElementById("local-update")?.focus();
    }
    wasApplying.current = applying;
  }, [applying]);

  const ask = async (path: string) => {
    setRequesting(true);
    setFailure(null);
    try {
      props.onView(await api<LocalEngineView>("POST", path));
    } catch (error) {
      const result = asApiFailure(error);
      if (result.code === "auth.passphrase_required") props.onAuthRequired();
      setFailure(result);
    } finally {
      setRequesting(false);
    }
  };

  return (
    <UpdateView
      view={props.view}
      requesting={requesting}
      failure={failure}
      announcement={announcement}
      onUpdate={() => void ask("/api/local-engine/update")}
      onRollback={() => void ask("/api/local-engine/rollback")}
    />
  );
}
