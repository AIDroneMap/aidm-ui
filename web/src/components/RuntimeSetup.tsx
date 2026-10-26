import type { ApiFailure } from "../api.ts";
import { t } from "../i18n/translate.ts";
import { messageParams } from "../machine.ts";
import { setupUnderWay } from "../localEngine.ts";
import type { RuntimeSetupView } from "../../../shared/api-types.ts";
import { BusyButton } from "./BusyButton.tsx";
import { ErrorMessage } from "./ErrorMessage.tsx";

export interface RuntimeSetupProps {
  /** True when no container tool works on this Linux computer, so Podman can be installed. */
  offered: boolean;
  /** The setup as the server last said it, or null before one began. */
  setup: RuntimeSetupView | null;
  /** True while the request to begin is on its way. */
  starting: boolean;
  /** Why the server refused to begin, when it did. */
  refusal: ApiFailure | null;
  /** True while the end of the wizard is being saved. */
  remoteBusy: boolean;
  onSetup: () => void;
  onRemote: () => void;
}

/** True when this part has anything to say or do. */
export function runtimeSetupShown(offered: boolean, setup: RuntimeSetupView | null): boolean {
  return offered || (setup !== null && setup.phase === "failed");
}

/**
 * Installing Podman where nothing runs the engine: what will happen, one button,
 * the step it is at in words, and when it fails, the reason and a way out.
 */
export function RuntimeSetupPanel(props: RuntimeSetupProps) {
  const { setup } = props;
  const underWay = setupUnderWay(setup);
  const failed = setup !== null && setup.phase === "failed";
  if (!runtimeSetupShown(props.offered, setup)) return null;
  return (
    <div className="choice runtime-setup">
      <h2>{t("setup.title")}</h2>
      {props.offered && (
        <>
          <p>{t("setup.intro")}</p>
          {/* The button stays in place after the click, so keyboard focus stays on it. */}
          <div className="actions">
            <BusyButton busy={props.starting || underWay} onClick={props.onSetup}>
              {props.starting || underWay ? t("setup.button_busy") : t("setup.button")}
            </BusyButton>
          </div>
        </>
      )}
      <div role="status">
        {setup !== null && setup.phase !== "failed" && <p>{t(`setup.progress.${setup.phase}`)}</p>}
      </div>
      {props.refusal && <ErrorMessage failure={props.refusal} />}
      {failed && (
        <>
          <p role="alert" className="error">
            {setup.problem ? t(setup.problem.code, messageParams(setup.problem)) : t("setup.failed_generic")}
          </p>
          <p>{t("setup.remote_offer")}</p>
          <BusyButton className="secondary" busy={props.remoteBusy} onClick={props.onRemote}>
            {t("wizard.engine.remote.button")}
          </BusyButton>
        </>
      )}
    </div>
  );
}
