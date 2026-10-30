import { useEffect, useRef, useState } from "react";
import type { RunView } from "../../../shared/api-types.ts";
import { api, asApiFailure, type ApiFailure } from "../api.ts";
import { Button } from "../controls/Button.tsx";
import { Dialog } from "../controls/Dialog.tsx";
import { formatBytes } from "../format.ts";
import { t } from "../i18n/translate.ts";
import { parseRunEvent } from "../runs.ts";
import { ErrorMessage } from "./ErrorMessage.tsx";

const outputNames = ["orthophoto", "surface", "ground", "point-cloud", "textured-model", "glb", "report"];

export function Results({ run: view, onChange }: { run: RunView; onChange: (run: RunView) => void }) {
  const [working, setWorking] = useState(false);
  const [asking, setAsking] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (asking) dialog.current?.showModal(); }, [asking]);
  useEffect(() => {
    if (view.results?.state !== "fetching") return;
    const source = new EventSource(`/api/runs/${view.id}/events`);
    source.addEventListener("run", event => {
      const next = parseRunEvent((event as MessageEvent<string>).data);
      if (next?.id === view.id) onChange(next);
    });
    return () => source.close();
  }, [view.id, view.results?.state, onChange]);
  async function change(method: "POST" | "DELETE") {
    if (working) return;
    setWorking(true); setFailure(null);
    try {
      await api<unknown>(method, `/api/runs/${view.id}/results`);
      onChange(await api<RunView>("GET", `/api/runs/${view.id}`));
      setAsking(false);
    } catch (error) { setFailure(asApiFailure(error)); setAsking(false); }
    finally { setWorking(false); }
  }
  const results = view.results;
  if (!results) return null;
  return <section>
    <h3>{t("results.title")}</h3>
    {failure && <ErrorMessage failure={failure} />}
    {results.state === "fetching" && <p role="status">{t("run.results_fetching")}</p>}
    {results.state === "failed" && <><p>{t("results.failed")}</p><Button disabled={working} onClick={() => void change("POST")}>{t("results.retry")}</Button></>}
    {results.state === "deleted" && <p>{t("results.deleted")}</p>}
    {results.state === "ready" && <>
      <p><a href={`/api/runs/${view.id}/results`} download>{t("run.results_link")}</a>{results.archiveSize !== null && t("results.size_suffix", { size: formatBytes(results.archiveSize) })}</p>
      <ul>{results.outputs.filter(output => outputNames.includes(output.name)).map(output => <li key={output.name}><a href={`/api/runs/${view.id}/outputs/${encodeURIComponent(output.name)}`} download>{t(`results.output.${output.name}`)}</a>{t("results.size_suffix", { size: formatBytes(output.size) })}</li>)}</ul>
      <Button className="secondary" disabled={working} onClick={() => setAsking(true)}>{t("results.delete")}</Button>
    </>}
    {asking && <Dialog ref={dialog} label={t("results.delete_title")} onCancel={event => { event.preventDefault(); if (!working) setAsking(false); }}>
      <h3>{t("results.delete_title")}</h3><p>{t("results.delete_explain")}</p>
      <Button className="secondary" disabled={working} onClick={() => setAsking(false)}>{t("results.keep")}</Button>{" "}
      <Button disabled={working} onClick={() => void change("DELETE")}>{t("results.delete")}</Button>
    </Dialog>}
  </section>;
}
