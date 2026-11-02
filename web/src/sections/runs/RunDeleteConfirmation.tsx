import type { ApiFailure } from "../../api.ts";
import type { RunView } from "../../../../shared/api-types.ts";
import { ConfirmDialog } from "../../controls/ConfirmDialog.tsx";
import { t } from "../../i18n/translate.ts";
import { formatBytes } from "../../format.ts";

type Props = {
  run: RunView | null;
  busy?: boolean;
  failure?: ApiFailure | null;
  onConfirm: () => void;
  onCancel: () => void;
};

function displayName(run: RunView): string {
  if (run.sample) return t("run.sample_name");
  return run.name || t("run.title", { id: run.id });
}

/** The Runs section calls this one confirmation until the shared deletion dialog lands. */
export function RunDeleteConfirmation({ run, busy, failure, onConfirm, onCancel }: Props) {
  return (
    <ConfirmDialog
      open={run !== null}
      title={t("runs.delete_title")}
      confirmLabel={run?.results?.archiveSize != null ? t("runs.confirm_delete_size", { size: formatBytes(run.results.archiveSize) }) : t("runs.confirm_delete")}
      danger
      busy={busy}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      {run && <p>{t("runs.delete_explain", { name: displayName(run) })}</p>}
      {failure && <p role="alert" className="error">{t("runs.delete_failed")}</p>}
    </ConfirmDialog>
  );
}
