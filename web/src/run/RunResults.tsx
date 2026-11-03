import { useEffect, useState } from "react";
import type { RunView } from "../../../shared/api-types.ts";
import { api, asApiFailure, type ApiFailure } from "../api.ts";
import { ErrorMessage } from "../components/ErrorMessage.tsx";
import { Button } from "../controls/Button.tsx";
import { Notice } from "../controls/Notice.tsx";
import { Progress } from "../controls/Progress.tsx";
import { t } from "../i18n/translate.ts";
import { parseRunEvent } from "../runs.ts";
import { DeleteResults } from "../sections/results/DeleteResults.tsx";
import { RunOutputs } from "../sections/results/RunOutputs.tsx";

/**
 * What a finished run made, first on the run screen: the fetch progress
 * while AIDM UI fetches the archive, then the Results section's viewer
 * tiles and downloads, and the deletion of the results apart from them.
 */
export function RunResults({ run, onChange }: { run: RunView; onChange: (run: RunView) => void }) {
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const state = run.results?.state;
  // A fetch started again from here comes after the run's own stream closed, so it is followed on a stream of its own.
  useEffect(() => {
    if (state !== "fetching") return;
    const source = new EventSource(`/api/runs/${run.id}/events`);
    source.addEventListener("run", (event) => {
      const next = parseRunEvent((event as MessageEvent<string>).data);
      if (next?.id === run.id) onChange(next);
    });
    return () => source.close();
  }, [run.id, state, onChange]);
  async function retry() {
    setFailure(null);
    try {
      await api<unknown>("POST", `/api/runs/${run.id}/results`);
      onChange(await api<RunView>("GET", `/api/runs/${run.id}`));
    } catch (error) {
      setFailure(asApiFailure(error));
    }
  }
  return (
    <section className="run-band run-results" aria-label={t("results.title")}>
      {(run.step === "results" || state === "fetching") && <Progress id="run-results-fetching" label={t("run.results_fetching")} hideLabel />}
      {state === "ready" && <><RunOutputs run={run} /><DeleteResults run={run} onDeleted={onChange} /></>}
      {state === "failed" && <Notice tone="warn"><p>{t("results.failed")}</p><Button variant="secondary" onClick={() => void retry()}>{t("results.retry")}</Button></Notice>}
      {state === "deleted" && <Notice>{t("results.deleted")}</Notice>}
      {state === undefined && run.step !== "results" && <Notice>{t("results.none_for_run")}</Notice>}
      {failure && <ErrorMessage failure={failure} />}
    </section>
  );
}
