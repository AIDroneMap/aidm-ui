import { useState } from "react";
import type { RunView } from "../../../shared/api-types.ts";
import { FINISHED_RUN_STATES } from "../../../shared/api-types.ts";
import { api, asApiFailure, type ApiFailure } from "../api.ts";
import { ErrorMessage } from "../components/ErrorMessage.tsx";
import { Button } from "../controls/Button.tsx";
import { t } from "../i18n/translate.ts";
import { DeleteConfirmation } from "../sections/details/DeleteConfirmation.tsx";
import { sectionHash } from "../router.ts";

export function RunActions({ run, onAuthRequired, onAgain }: { run: RunView; onAuthRequired(): void; onAgain(): void }) {
  const [working, setWorking] = useState(false), [asking, setAsking] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const finished = FINISHED_RUN_STATES.includes(run.state);
  const busy = working || run.state === "created" || run.state === "uploading" || run.step === "results";
  async function act(action: "retry" | "delete") {
    if (working) return;
    setWorking(true); setFailure(null);
    try {
      if (action === "delete") {
        await api<void>("DELETE", `/api/runs/${run.id}`);
        window.location.hash = sectionHash(run.projectId, "runs");
      } else {
        const next = await api<RunView>("POST", `/api/runs/${run.id}/retry`);
        window.location.hash = `#/runs/${next.id}`;
      }
    } catch (error) {
      const problem = asApiFailure(error);
      if (problem.code === "auth.passphrase_required") onAuthRequired(); else setFailure(problem);
      setAsking(false);
    } finally { setWorking(false); }
  }
  return <section aria-label={t("run_manage.actions")}>
    {failure && <ErrorMessage failure={failure} />}
    <div className="actions">
      {!run.sample && (run.state === "failed" || run.state === "cancelled") && <Button disabled={busy} onClick={() => void act("retry")}>{t("run_manage.retry")}</Button>}
      {!run.sample && finished && <Button className="secondary" disabled={busy} onClick={onAgain}>{t("run_manage.again")}</Button>}
      <Button className="secondary" disabled={busy} onClick={() => setAsking(true)}>{t("run_manage.delete")}</Button>
    </div>
    <DeleteConfirmation target={{ kind: "run", run }} open={asking} busy={working} onConfirm={() => void act("delete")} onCancel={() => setAsking(false)} />
  </section>;
}
