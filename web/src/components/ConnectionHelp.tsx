import { useState } from "react";
import { api, asApiFailure, type ApiFailure } from "../api.ts";
import { t } from "../i18n/translate.ts";
import { useEngineLog } from "../localEngine.ts";
import { messageParams } from "../machine.ts";
import { BusyButton } from "./BusyButton.tsx";
import { EngineLog } from "./EngineLog.tsx";
import { ErrorMessage } from "./ErrorMessage.tsx";
import type { LocalEngineView } from "../../../shared/api-types.ts";

const LOG_ID = "connection-log";

/** The engine's log, for an engine that runs and that nothing else explains. It opens with the message. */
function LogBelow() {
  const lines = useEngineLog(true);
  return <EngineLog id={LOG_ID} lines={lines} />;
}

/**
 * Why the engine on a Mac runs and cannot be reached, in the words of the
 * checks (ADR 0006), and the move of the tool's network when it can help.
 * The move restarts Apple's tool and every container on it, so the page asks first.
 */
export function ConnectionHelp(props: { view: LocalEngineView; onView: (view: LocalEngineView) => void; onAuthRequired: () => void }) {
  const connection = props.view.connection;
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  if (connection === null || (connection.problem === null && connection.conflict === null)) return null;
  const { problem, conflict } = connection;
  const inside = problem?.code === "mac.engine_unreachable" ? String(problem.data.inside ?? "unknown") : null;
  const via = problem?.code === "mac.vpn_route" ? String(problem.data.via ?? "tunnel") : null;
  // The engine's log helps where the checks found no cause outside the engine.
  const withLog = inside !== null || problem?.code === "mac.engine_not_answering";

  const move = async () => {
    setBusy(true);
    setFailure(null);
    try {
      props.onView(await api<LocalEngineView>("POST", "/api/local-engine/network/move", { confirm: true }));
      setAsking(false);
    } catch (error) {
      const result = asApiFailure(error);
      if (result.code === "auth.passphrase_required") props.onAuthRequired();
      setFailure(result);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="connection-help">
      {problem !== null && (
        <div className="error" role="alert">
          <p>{t(problem.code, messageParams(problem))}</p>
          {inside !== null && <p>{t(`local.connection.inside.${inside}`)}</p>}
          {via !== null && <p>{t(`local.connection.vpn.${via}`, messageParams(problem as NonNullable<typeof problem>))}</p>}
        </div>
      )}
      {conflict !== null && (
        <div className="warning">
          <p>{t(conflict.code, messageParams(conflict))}</p>
        </div>
      )}
      {withLog && <LogBelow />}
      {connection.canMove &&
        (asking ? (
          <div className="ask" role="group" aria-label={t("local.connection.move")}>
            <p>{t("local.connection.move_confirm")}</p>
            <div className="actions">
              <BusyButton busy={busy} onClick={() => void move()}>
                {busy ? t("local.connection.moving") : t("local.connection.move_yes")}
              </BusyButton>
              <button type="button" className="secondary" disabled={busy} onClick={() => setAsking(false)}>
                {t("local.connection.move_no")}
              </button>
            </div>
          </div>
        ) : (
          <div className="actions">
            <button type="button" className="secondary" onClick={() => setAsking(true)}>
              {t("local.connection.move")}
            </button>
          </div>
        ))}
      {failure && <ErrorMessage failure={failure} />}
    </div>
  );
}
