import { useState } from "react";
import type { RunView } from "../../../../shared/api-types.ts";
import { api, asApiFailure, type ApiFailure } from "../../api.ts";
import { ErrorMessage } from "../../components/ErrorMessage.tsx";
import { Button } from "../../controls/Button.tsx";
import { ConfirmDialog } from "../../controls/ConfirmDialog.tsx";
import { formatBytes } from "../../format.ts";
import { t } from "../../i18n/translate.ts";

/**
 * The confirmation before a run's results go. It is kept in this one place so
 * that the delete dialog shared by the three deletions replaces it alone.
 */
function ConfirmResultsDeletion({ run, open, busy, onConfirm, onCancel }: { run: RunView; open: boolean; busy: boolean; onConfirm(): void; onCancel(): void }) {
  const size = run.results?.archiveSize ?? null;
  return (
    <ConfirmDialog danger open={open} busy={busy} title={t("results.delete_title")} confirmLabel={size === null ? t("results.delete") : t("results.delete_sized", { size: formatBytes(size) })} cancelLabel={t("results.keep")} onConfirm={onConfirm} onCancel={onCancel}>
      <p>{t("results.delete_explain")}</p>
    </ConfirmDialog>
  );
}

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
      <ConfirmResultsDeletion run={run} open={asking} busy={working} onConfirm={() => void remove()} onCancel={() => setAsking(false)} />
    </section>
  );
}
