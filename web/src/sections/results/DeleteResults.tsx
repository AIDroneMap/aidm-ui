import { useState } from "react";
import type { RunView } from "../../../../shared/api-types.ts";
import { api, asApiFailure, type ApiFailure } from "../../api.ts";
import { ErrorMessage } from "../../components/ErrorMessage.tsx";
import { Button } from "../../controls/Button.tsx";
import { t } from "../../i18n/translate.ts";
import { DeleteConfirmation } from "../details/DeleteConfirmation.tsx";

/** "Delete the results of this run", apart from the rest. The run, its settings and its log stay. */
export function DeleteResults({ run, onDeleted }: { run: RunView; onDeleted(run: RunView): void }) {
  const [asking, setAsking] = useState(false);
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  async function remove() {
    if (working) return;
    setWorking(true); setFailure(null);
    try {
      await api<unknown>("DELETE", `/api/runs/${run.id}/results`);
      const next = await api<RunView>("GET", `/api/runs/${run.id}`);
      setAsking(false);
      onDeleted(next);
    } catch (error) { setFailure(asApiFailure(error)); setAsking(false); }
    finally { setWorking(false); }
  }
  return (
    <section className="results-danger" aria-labelledby={`delete-results-${run.id}`}>
      <h2 id={`delete-results-${run.id}`}>{t("results.delete_area_title")}</h2>
      <p>{t("results.delete_area_text")}</p>
      {failure && <ErrorMessage failure={failure} />}
      <Button variant="secondary" disabled={working} onClick={() => setAsking(true)}>{t("results.delete_this_run")}</Button>
      <DeleteConfirmation target={{ kind: "results", run }} open={asking} busy={working} onConfirm={() => void remove()} onCancel={() => setAsking(false)} />
    </section>
  );
}
