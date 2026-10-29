import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import type { UploadedFilesView } from "../../../shared/api-types.ts";
import { api, asApiFailure } from "../api.ts";
import { Button } from "../controls/Button.tsx";
import { Disclosure } from "../controls/Disclosure.tsx";
import { Table } from "../controls/Table.tsx";
import { formatBytes } from "../format.ts";
import { t } from "../i18n/translate.ts";
import { messageParams } from "../machine.ts";
import { UploadController, type PendingUpload, type UploadResult } from "./controller.ts";
import { UploadQueue, type SkippedUpload, type UploadSelection } from "./queue.ts";

const pageSize = 20;
type Props = { projectId: number; onChange(): void; onAuthRequired(): void };
type Active = { abort: AbortController; done: Promise<UploadResult[]>; sessions: Map<string, PendingUpload> };

export function UploadPanel({ projectId, onChange, onAuthRequired }: Props) {
  const controller = useRef<UploadController | null>(null);
  const active = useRef<Active | null>(null);
  const alive = useRef(false);
  const selected = useRef(new Map<string, File>());
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const [pendingPage, setPendingPage] = useState(0);
  const [skipped, setSkipped] = useState<SkippedUpload[]>([]);
  const [skipPage, setSkipPage] = useState(0);
  const [files, setFiles] = useState<UploadedFilesView>({ files: [], nextOffset: null });
  const [offset, setOffset] = useState(0);
  const [version, setVersion] = useState(0);
  const [working, setWorking] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [remaining, setRemaining] = useState(0);
  const [speed, setSpeed] = useState<number | null>(null);
  const [error, setError] = useState<{ code: string; data: Record<string, unknown> } | null>(null);

  useEffect(() => {
    alive.current = true;
    controller.current = new UploadController();
    setPending(controller.current.pending(projectId));
    return () => { alive.current = false; active.current?.abort.abort(); };
  }, [projectId]);

  useEffect(() => {
    let current = true;
    api<UploadedFilesView>("GET", `/api/projects/${projectId}/photos?offset=${offset}&limit=${pageSize}`).then(value => {
      if (current) setFiles(value);
    }, problem => {
      if (!current) return;
      const failure = asApiFailure(problem);
      if (failure.code === "auth.passphrase_required") onAuthRequired(); else setError(failure);
    });
    return () => { current = false; };
  }, [projectId, offset, version]);

  function report(result: UploadResult) {
    if (result.status !== "error" || !alive.current) return;
    if (result.code === "auth.passphrase_required") onAuthRequired(); else setError({ code: result.code, data: result.data ?? {} });
  }
  function refreshPending() {
    if (alive.current && controller.current) setPending(controller.current.pending(projectId));
  }
  function start(selections: UploadSelection[], resume?: PendingUpload) {
    const client = controller.current;
    if (!alive.current || !client || active.current || selections.length === 0) return;
    setError(null);
    const abort = new AbortController();
    const sessions = new Map<string, PendingUpload>();
    if (resume) sessions.set(resume.id, resume);
    const queue = new UploadQueue(async (id, file, name, signal) => {
      const result = await client.upload(id, file, name, signal, value => {
        if (alive.current && value.bytesPerSecond !== null) setSpeed(value.bytesPerSecond);
      }, resume, entry => {
        sessions.set(entry.id, entry);
        selected.current.set(entry.id, file);
      });
      if (alive.current) {
        setRemaining(value => Math.max(0, value - 1));
        report(result);
        refreshPending();
        if (result.status === "complete") {
          for (const entry of sessions.values()) if (selected.current.get(entry.id) === file) selected.current.delete(entry.id);
          setVersion(value => value + 1);
          onChange();
        }
      }
      return result;
    });
    const batch = queue.enqueue(projectId, selections, abort.signal);
    const count = selections.length - batch.skipped.length;
    setSkipped(value => [...value, ...batch.skipped]);
    if (batch.skipped.some(item => item.code === "upload.ground_control_unsupported")) setError({ code: "upload.ground_control_unsupported", data: {} });
    if (count === 0) return;
    setRemaining(count); setWorking(true); setSpeed(null);
    const operation: Active = { abort, done: batch.done, sessions };
    active.current = operation;
    void batch.done.then(() => {
      if (active.current !== operation) return;
      if (!abort.signal.aborted) active.current = null;
      if (alive.current && !abort.signal.aborted) { setWorking(false); setRemaining(0); refreshPending(); }
    });
  }
  async function cancelActive() {
    const operation = active.current;
    const client = controller.current;
    if (!operation || !client || operation.abort.signal.aborted) return;
    setCancelling(true);
    operation.abort.abort();
    await operation.done;
    for (const entry of operation.sessions.values()) {
      if (!client.pending(projectId).some(item => item.id === entry.id)) continue;
      const result = await client.cancel(entry);
      report(result);
      if (result.status === "cancelled") selected.current.delete(entry.id);
    }
    if (active.current === operation) active.current = null;
    if (alive.current) { setWorking(false); setCancelling(false); setRemaining(0); setSpeed(null); refreshPending(); }
  }
  async function cancelPending(entry: PendingUpload) {
    const result = await controller.current?.cancel(entry);
    if (!result) return;
    report(result);
    if (result.status === "cancelled") selected.current.delete(entry.id);
    refreshPending();
  }
  function choose(event: ChangeEvent<HTMLInputElement>, entry?: PendingUpload) {
    const list = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (entry) {
      const file = list[0];
      if (file) start([{ file, name: entry.name }], entry);
    } else start(list.map(file => ({ file, name: file.webkitRelativePath || file.name })));
  }
  async function drop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    if (active.current) return;
    setError(null);
    try { start(await droppedFiles(event.dataTransfer)); }
    catch { if (alive.current) setError({ code: "api.request_failed", data: {} }); }
  }
  const pendingOffset = pendingPage * pageSize;
  const skippedOffset = skipPage * pageSize;
  return <section onDragOver={event => event.preventDefault()} onDrop={event => { void drop(event); }}>
    <h2>{t("upload.title")}</h2>
    <div className="field"><label htmlFor="upload-files">{t("upload.files_label")}</label><input id="upload-files" type="file" multiple disabled={working} onChange={event => choose(event)} /></div>
    <div className="field"><label htmlFor="upload-folder">{t("upload.folder_label")}</label><input id="upload-folder" type="file" multiple {...{ webkitdirectory: "" }} disabled={working} onChange={event => choose(event)} /></div>
    <p>{t("upload.drop")}</p>
    {error && <p role="alert">{t(error.code, messageParams(error))}</p>}
    {working && <div role="status"><p>{t("upload.working")}</p><p>{t("upload.remaining", { count: remaining })}</p>{speed !== null && <p>{t("upload.speed", { speed: formatBytes(speed) })}</p>}<Button disabled={cancelling} onClick={() => { void cancelActive(); }}>{t("upload.cancel_all")}</Button></div>}
    {skipped.length > 0 && <Disclosure label={t("upload.skipped", { count: skipped.length })}><ul>{skipped.slice(skippedOffset, skippedOffset + pageSize).map((item, index) => <li key={skippedOffset + index}>{t("upload.skipped_file", { name: item.name, reason: t(item.code) })}</li>)}</ul><Pages previous={skipPage > 0} next={skippedOffset + pageSize < skipped.length} onPrevious={() => setSkipPage(value => value - 1)} onNext={() => setSkipPage(value => value + 1)} /></Disclosure>}
    {pending.length > 0 && <div><h3>{t("upload.pending")}</h3>{pending.slice(pendingOffset, pendingOffset + pageSize).map(entry => <div key={entry.id}>
      <p>{t("upload.file_summary", { name: entry.name, size: formatBytes(entry.size) })}</p><p>{t("upload.awaiting")}</p>
      <div className="field"><label htmlFor={`upload-reselect-${entry.id}`}>{t("upload.reselect", { name: entry.name })}</label><input id={`upload-reselect-${entry.id}`} type="file" disabled={working} onChange={event => choose(event, entry)} /></div>
      {selected.current.has(entry.id) && <Button disabled={working} onClick={() => { const file = selected.current.get(entry.id); if (file) start([{ file, name: entry.name }], entry); }}>{t("upload.retry", { name: entry.name })}</Button>}{" "}
      <Button className="secondary" disabled={working} onClick={() => { void cancelPending(entry); }}>{t("upload.cancel", { name: entry.name })}</Button>
    </div>)}<Pages previous={pendingPage > 0} next={pendingOffset + pageSize < pending.length} onPrevious={() => setPendingPage(value => value - 1)} onNext={() => setPendingPage(value => value + 1)} /></div>}
    <h3>{t("upload.completed")}</h3>
    {files.files.length === 0 ? <p>{t("upload.empty")}</p> : <Table label={t("upload.completed")}><thead><tr><th scope="col">{t("upload.name")}</th><th scope="col">{t("upload.size")}</th><th scope="col">{t("upload.kind")}</th></tr></thead><tbody>{files.files.map(file => <tr key={`${file.name}:${file.sha256}`}><td>{file.name}</td><td>{formatBytes(file.size)}</td><td>{t(`upload.${file.kind}`)}</td></tr>)}</tbody></Table>}
    <Pages previous={offset > 0} next={files.nextOffset !== null} onPrevious={() => setOffset(value => Math.max(0, value - pageSize))} onNext={() => { if (files.nextOffset !== null) setOffset(files.nextOffset); }} />
  </section>;
}

function Pages({ previous, next, onPrevious, onNext }: { previous: boolean; next: boolean; onPrevious(): void; onNext(): void }) {
  return <>{previous && <Button className="secondary" onClick={onPrevious}>{t("upload.previous")}</Button>}{" "}{next && <Button className="secondary" onClick={onNext}>{t("upload.next")}</Button>}</>;
}

async function droppedFiles(data: DataTransfer): Promise<UploadSelection[]> {
  const items = Array.from(data.items);
  const entries = items.map(item => item.webkitGetAsEntry?.()).filter((entry): entry is FileSystemEntry => entry !== null && entry !== undefined);
  if (!entries.length) return Array.from(data.files, file => ({ file, name: file.webkitRelativePath || file.name }));
  const files: UploadSelection[] = [];
  async function visit(entry: FileSystemEntry, prefix: string): Promise<void> {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      files.push({ file, name });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      while (true) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const child of batch) await visit(child, name);
      }
    }
  }
  for (const entry of entries) await visit(entry, "");
  return files;
}
