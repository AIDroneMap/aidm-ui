import type { ReactNode } from "react";
import type { RunView } from "../../../shared/api-types.ts";
import { Results } from "../components/Results.tsx";
import { Progress } from "../controls/Progress.tsx";
import { t } from "../i18n/translate.ts";

/**
 * What a finished run made, first on the run screen: the fetch progress
 * while AIDM UI fetches the archive, then the downloads and the viewers.
 * A placeholder for the shared results component of the Results and
 * viewers work, which takes this band's place when it lands.
 */
export function ResultsBand({ run, onChange, viewers }: { run: RunView; onChange: (run: RunView) => void; viewers?: ReactNode }) {
  return (
    <section className="run-band run-results" aria-label={t("run.screen.results")}>
      {run.step === "results" && <Progress id="run-results-fetching" label={t("run.results_fetching")} hideLabel />}
      {run.results ? (
        <Results run={run} onChange={onChange} />
      ) : run.step !== "results" && (
        run.resultsAvailable ? (
          <p><a href={`/api/runs/${run.id}/results`} download>{t("run.results_link")}</a></p>
        ) : (
          <p role="status">{t("run.results_preparing")}</p>
        )
      )}
      {viewers}
    </section>
  );
}
