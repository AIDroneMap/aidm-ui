import type { ReactNode } from "react";
import { t } from "../i18n/translate.ts";
import { messageParams } from "../machine.ts";
import type { RuntimeSetupView } from "../../../shared/api-types.ts";
import { BusyButton } from "./BusyButton.tsx";

export interface RuntimeSetupProps {
  /** True when no container tool works on this Linux computer, so Podman can be installed. */
  offered: boolean;
  /** The setup as the server last said it, or null before one began. */
  setup: RuntimeSetupView | null;
  /** True while the end of the wizard is being saved. */
  remoteBusy: boolean;
  onRemote: () => void;
  /** The install button, which is the only button for this: it sets Podman up first when that is needed. */
  children: ReactNode;
}

/** True when this part has anything to say or do. */
export function runtimeSetupShown(offered: boolean, setup: RuntimeSetupView | null): boolean {
  return offered || (setup !== null && setup.phase === "failed");
}

/**
 * Installing Podman where nothing runs the engine: what will happen, the
 * install button, the step it is at in words, and when it fails, the reason
 * and a way out.
 */
export function RuntimeSetupPanel(props: RuntimeSetupProps) {
  const { setup } = props;
  const failed = setup !== null && setup.phase === "failed";
  if (!runtimeSetupShown(props.offered, setup)) return null;
  return (
    <div className="choice runtime-setup">
      <h2>{t("setup.title")}</h2>
      {props.offered && <p>{t("setup.intro")}</p>}
      {props.children}
      <div role="status">
        {setup !== null && setup.phase !== "failed" && <p>{t(`setup.progress.${setup.phase}`)}</p>}
      </div>
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
