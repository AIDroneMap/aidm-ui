import { useEffect, useRef, useState, type FormEvent } from "react";
import type { FolderImportView } from "../../../shared/api-types.ts";
import { api, asApiFailure, type ApiFailure } from "../api.ts";
import { ErrorMessage } from "../components/ErrorMessage.tsx";
import { Button } from "../controls/Button.tsx";
import { TextField } from "../controls/TextField.tsx";
import { formatBytes } from "../format.ts";
import { t } from "../i18n/translate.ts";

const pageSize = 50;
type SourceState = FolderImportView["state"];

type ContentProps = { view: FolderImportView; path: string; working: boolean; offset: number; onPath(value: string): void; onSubmit(): void; onPage(offset: number): void };
export function FolderImportViewContent({ view, path, working, offset, onPath, onSubmit, onPage }: ContentProps) {
  function submit(event: FormEvent) { event.preventDefault(); onSubmit(); }
  return <section aria-labelledby="import-title">
    <h2 id="import-title">{t("folder.title")}</h2>
    {view.state !== "none" && <>
      <p role="status">{t(`folder.state_${view.state}`)}</p>
      <p>{t("folder.accepted", { count: view.acceptedCount })}</p>
      <p>{t("folder.skipped", { count: view.skippedCount })}</p>
      {view.groundControlCount > 0 && <p>{t("folder.ground_control", { count: view.groundControlCount })}</p>}
      <ul style={{ overflowWrap: "anywhere" }}>{view.files.map((file, index) => <li key={`${offset}-${index}`}>{t("folder.file", { name: file.name, size: formatBytes(file.size), kind: t(`folder.kind_${file.kind}`) })}</li>)}</ul>
      {offset > 0 && <Button className="secondary" disabled={working} onClick={() => onPage(Math.max(0, offset - pageSize))}>{t("upload.previous")}</Button>}{" "}
      {view.nextOffset !== null && <Button className="secondary" disabled={working} onClick={() => onPage(view.nextOffset!)}>{t("upload.next")}</Button>}
    </>}
    {view.available && <form onSubmit={submit}>
      <p id="import-help">{t("folder.help")}</p>
      <TextField id="import-path" label={t("folder.path")} value={path} onChange={event => onPath(event.target.value)} aria-describedby="import-help" required disabled={working} />
      <Button type="submit" disabled={working}>{t(view.state === "none" ? "folder.action" : "folder.relink")}</Button>
    </form>}
    {working && <p role="status">{t("folder.working")}</p>}
  </section>;
}

export function FolderImportPanel({ projectId, onSource, onChange, onAuthRequired }: { projectId: number; onSource(state: SourceState | null): void; onChange(): void; onAuthRequired(): void }) {
  const [view, setView] = useState<FolderImportView | null>(null);
  const [path, setPath] = useState("");
  const [offset, setOffset] = useState(0);
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const generation = useRef(0);
  const request = useRef(0);
  const pathEdited = useRef(false);
  const callbacks = useRef({ onSource, onChange, onAuthRequired });
  callbacks.current = { onSource, onChange, onAuthRequired };
  useEffect(() => {
    const current = ++generation.current;
    pathEdited.current = false;
    setView(null); setPath(""); setOffset(0); setWorking(false); setFailure(null);
    callbacks.current.onSource(null);
    return () => { if (generation.current === current) generation.current++; request.current++; };
  }, [projectId]);
  useEffect(() => {
    const current = generation.current;
    const latest = ++request.current;
    let active = true;
    api<FolderImportView>("GET", `/api/projects/${projectId}/import?offset=${offset}&limit=${pageSize}`).then(value => {
      if (!active || generation.current !== current || request.current !== latest) return;
      setView(value); callbacks.current.onSource(value.state);
      if (!pathEdited.current) setPath(value.path ?? "");
    }, error => {
      if (!active || generation.current !== current || request.current !== latest) return;
      const problem = asApiFailure(error);
      if (problem.code === "auth.passphrase_required") callbacks.current.onAuthRequired(); else setFailure(problem);
    });
    return () => { active = false; };
  }, [projectId, offset]);
  async function submit() {
    if (working) return;
    const current = generation.current;
    request.current++;
    setWorking(true); setFailure(null);
    try {
      const value = await api<FolderImportView>("PUT", `/api/projects/${projectId}/import`, { path });
      if (generation.current !== current) return;
      setOffset(0); setView(value); callbacks.current.onSource(value.state); callbacks.current.onChange();
    } catch (error) {
      if (generation.current !== current) return;
      const problem = asApiFailure(error);
      if (problem.code === "auth.passphrase_required") callbacks.current.onAuthRequired(); else setFailure(problem);
    } finally { if (generation.current === current) setWorking(false); }
  }
  return <>{failure && <ErrorMessage failure={failure} />}{view ? <FolderImportViewContent view={view} path={path} working={working} offset={offset} onPath={value => { pathEdited.current = true; setPath(value); }} onSubmit={() => void submit()} onPage={setOffset} /> : !failure && <p role="status">{t("folder.loading")}</p>}</>;
}
