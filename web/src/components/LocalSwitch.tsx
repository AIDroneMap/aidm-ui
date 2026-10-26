import { useRef, useState, type Ref } from "react";
import { api, asApiFailure, type ApiFailure } from "../api.ts";
import { t } from "../i18n/translate.ts";
import { BusyButton } from "./BusyButton.tsx";
import { ErrorMessage } from "./ErrorMessage.tsx";
import type { LocalEngineEnabledRequest, LocalEngineView } from "../../../shared/api-types.ts";

export interface SwitchProps {
  view: LocalEngineView;
  /** True while a change of the switch or a start is on its way. */
  busy: boolean;
  failure: ApiFailure | null;
  onToggle: (enabled: boolean) => void;
  onStartAgain: () => void;
  switchRef?: Ref<HTMLInputElement>;
}

/**
 * The switch that turns the engine on this computer on and off, the tries to
 * bring it back after a crash, and the way out after the manager gave up.
 */
export function SwitchView({ view, busy, failure, onToggle, onStartAgain, switchRef }: SwitchProps) {
  const gaveUp = view.problem?.code === "local.restart_gave_up";
  return (
    <div className="local-switch">
      <div className="check">
        <input
          ref={switchRef}
          id="local-enabled"
          type="checkbox"
          role="switch"
          checked={view.enabled}
          aria-describedby="local-enabled-hint"
          aria-disabled={busy ? "true" : undefined}
          onChange={(event) => {
            if (!busy) onToggle(event.target.checked);
          }}
        />
        <label htmlFor="local-enabled">{t("local.switch.label")}</label>
      </div>
      <p id="local-enabled-hint" className="hint">
        {t("local.switch.hint")}
      </p>
      <div role="status">
        {view.restarts && <p>{t("local.restarting", { attempt: view.restarts.attempts, max: view.restarts.max })}</p>}
      </div>
      {gaveUp && (
        <div className="actions">
          <BusyButton busy={busy} onClick={onStartAgain}>
            {busy ? t("local.start_again_busy") : t("local.start_again")}
          </BusyButton>
        </div>
      )}
      {failure && <ErrorMessage failure={failure} />}
    </div>
  );
}

/** The switch with its state: the answers of the server replace the view. */
export function LocalSwitch(props: {
  view: LocalEngineView;
  onView: (view: LocalEngineView) => void;
  onAuthRequired: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const checkbox = useRef<HTMLInputElement>(null);

  const change = async (call: () => Promise<LocalEngineView>) => {
    setBusy(true);
    setFailure(null);
    try {
      props.onView(await call());
    } catch (error) {
      const result = asApiFailure(error);
      if (result.code === "auth.passphrase_required") props.onAuthRequired();
      setFailure(result);
    } finally {
      setBusy(false);
      // The button that was pressed may be gone now; the switch is where focus belongs.
      if (document.activeElement === document.body) checkbox.current?.focus();
    }
  };

  return (
    <SwitchView
      view={props.view}
      busy={busy}
      failure={failure}
      switchRef={checkbox}
      onToggle={(enabled) =>
        void change(() => api<LocalEngineView>("PUT", "/api/local-engine/enabled", { enabled } satisfies LocalEngineEnabledRequest))
      }
      onStartAgain={() => void change(() => api<LocalEngineView>("POST", "/api/local-engine/start"))}
    />
  );
}
