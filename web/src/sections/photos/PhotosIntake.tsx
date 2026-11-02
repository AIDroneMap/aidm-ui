import { useEffect, useRef, useState, type FormEvent, type ChangeEvent } from "react";
import type { FolderImportView } from "../../../../shared/api-types.ts";
import type { LinkSourceView } from "../../../../shared/link-source.ts";
import { api, asApiFailure } from "../../api.ts";
import { Button } from "../../controls/Button.tsx";
import { Card } from "../../controls/Card.tsx";
import { Disclosure } from "../../controls/Disclosure.tsx";
import { DropZone } from "../../controls/DropZone.tsx";
import { KeyValueList } from "../../controls/KeyValueList.tsx";
import { Notice } from "../../controls/Notice.tsx";
import { Progress } from "../../controls/Progress.tsx";
import { TextField } from "../../controls/TextField.tsx";
import { formatBytes } from "../../format.ts";
import { t } from "../../i18n/translate.ts";
import { messageParams } from "../../machine.ts";
import { UploadController, type PendingUpload, type UploadResult } from "../../upload/controller.ts";
import { UploadQueue, type SkippedUpload, type UploadSelection } from "../../upload/queue.ts";
import "./photos-intake.css";

const pageSize = 20;
type Failure = { code: string; data: Record<string, unknown> };
type Batch = { abort: AbortController; done: Promise<UploadResult[]>; sessions: Map<string, PendingUpload>; failed: Set<string> };
type Props = {
  projectId: number;
  photoCount: number;
  localImportAllowed: boolean;
  importView: FolderImportView;
  linkView: LinkSourceView;
  /** The parent reads the project and its way in again after a change. */
  onChange(): void;
  onAuthRequired(): void;
};

/**
 * The ways photos get into a project: the empty state with its three ways in, the bar while files arrive, the
 * one-line summary when they have, and the state of a folder or ZIP address that is already the source.
 */
export function PhotosIntake({ projectId, photoCount, localImportAllowed, importView, linkView, onChange, onAuthRequired }: Props) {
  const controller = useRef<UploadController | null>(null);
  const active = useRef<Batch | null>(null);
  const generation = useRef(0);
  const selected = useRef(new Map<string, File>());
  const gate = useRef({ paused: false, waiters: [] as Array<() => void> });
  const callbacks = useRef({ onChange, onAuthRequired });
  callbacks.current = { onChange, onAuthRequired };
  const folderInput = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const [pendingPage, setPendingPage] = useState(0);
  const [skipped, setSkipped] = useState<SkippedUpload[]>([]);
  const [skipPage, setSkipPage] = useState(0);
  const [adding, setAdding] = useState(false);
  const [working, setWorking] = useState(false);
  const [paused, setPaused] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [total, setTotal] = useState(0);
  const [finished, setFinished] = useState(0);
  const [arrived, setArrived] = useState(0);
  const [speed, setSpeed] = useState<number | null>(null);
  const [error, setError] = useState<Failure | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [linkOverride, setLinkOverride] = useState<LinkSourceView | undefined>();
  const [checkedLink, setCheckedLink] = useState<{ url: string; size: number | null } | null>(null);
  const [sourceBusy, setSourceBusy] = useState(false);
  const [sourceError, setSourceError] = useState<Failure | null>(null);

  const live = (own: number) => generation.current === own;
  function openGate() { for (const resume of gate.current.waiters.splice(0)) resume(); }

  // A new project, or none: stop what is running and forget it. Uploads that were left unfinished stay in the browser's storage for the next visit.
  useEffect(() => {
    generation.current++;
    controller.current = new UploadController();
    selected.current = new Map();
    setPending(controller.current.pending(projectId));
    setPendingPage(0); setSkipped([]); setSkipPage(0); setAdding(false); setWorking(false); setPaused(false); setCancelling(false);
    setLinkOverride(undefined); setCheckedLink(null);
    setTotal(0); setFinished(0); setArrived(0); setSpeed(null); setError(null); setPath(null); setUrl(null); setSourceBusy(false); setSourceError(null);
    return () => {
      generation.current++;
      active.current?.abort.abort();
      active.current = null;
      gate.current.paused = false;
      openGate();
    };
  }, [projectId]);

  function fail(failure: Failure, setter: (value: Failure) => void) {
    if (failure.code === "auth.passphrase_required") callbacks.current.onAuthRequired(); else setter(failure);
  }
  function report(result: UploadResult, own: number) {
    if (result.status === "error" && live(own)) fail({ code: result.code, data: result.data ?? {} }, setError);
  }
  function refreshPending(own: number) {
    if (live(own) && controller.current) setPending(controller.current.pending(projectId));
  }
  // Files that have not begun wait here while the operator has paused; the ones already sending are not touched.
  async function holdWhilePaused(signal: AbortSignal) {
    while (gate.current.paused && !signal.aborted) await new Promise<void>(resume => gate.current.waiters.push(resume));
  }

  function start(selections: UploadSelection[], resume?: PendingUpload) {
    const client = controller.current;
    if (!client || active.current || selections.length === 0) return;
    const own = generation.current;
    setError(null);
    const abort = new AbortController();
    const sessions = new Map<string, PendingUpload>();
    const failed = new Set<string>();
    if (resume) sessions.set(resume.id, resume);
    const queue = new UploadQueue(async (id, file, name, signal) => {
      await holdWhilePaused(signal);
      if (signal.aborted) return { status: "cancelled" };
      let session = resume;
      const result = await client.upload(id, file, name, signal, value => {
        if (live(own) && value.bytesPerSecond !== null) setSpeed(value.bytesPerSecond);
      }, resume, entry => {
        session = entry;
        sessions.set(entry.id, entry);
        selected.current.set(entry.id, file);
      });
      if (result.status === "error" && session) failed.add(session.id);
      if (live(own)) {
        setFinished(value => value + 1);
        report(result, own);
        refreshPending(own);
        if (result.status === "complete") {
          setArrived(value => value + 1);
          for (const entry of sessions.values()) if (selected.current.get(entry.id) === file) selected.current.delete(entry.id);
          callbacks.current.onChange();
        }
      }
      return result;
    });
    const batch = queue.enqueue(projectId, selections, abort.signal);
    const count = selections.length - batch.skipped.length;
    setSkipped(value => [...value, ...batch.skipped]);
    if (batch.skipped.some(item => item.code === "upload.ground_control_unsupported")) setError({ code: "upload.ground_control_unsupported", data: {} });
    if (count === 0) return;
    setTotal(count); setFinished(0); setArrived(0); setSpeed(null); setPaused(false); setAdding(false); setWorking(true);
    gate.current.paused = false;
    const operation: Batch = { abort, done: batch.done, sessions, failed };
    active.current = operation;
    void batch.done.then(() => {
      if (active.current !== operation || abort.signal.aborted) return;
      active.current = null;
      if (live(own)) { setWorking(false); setPaused(false); refreshPending(own); }
    });
  }

  function togglePause() {
    const next = !gate.current.paused;
    gate.current.paused = next;
    setPaused(next);
    if (!next) openGate();
  }
  // Everything stops, the files waiting included. The uploads begun for this batch are deleted, except the ones that failed: those stay for a retry.
  async function cancelActive() {
    const operation = active.current;
    const client = controller.current;
    if (!operation || !client || operation.abort.signal.aborted) return;
    const own = generation.current;
    setCancelling(true);
    operation.abort.abort();
    gate.current.paused = false;
    openGate();
    await operation.done;
    for (const entry of operation.sessions.values()) {
      if (operation.failed.has(entry.id) || !client.pending(entry.projectId).some(item => item.id === entry.id)) continue;
      const result = await client.cancel(entry);
      report(result, own);
      if (result.status === "cancelled") selected.current.delete(entry.id);
    }
    if (active.current === operation) active.current = null;
    if (live(own)) { setWorking(false); setPaused(false); setCancelling(false); setSpeed(null); refreshPending(own); }
  }
  async function cancelPending(entry: PendingUpload) {
    const own = generation.current;
    const result = await controller.current?.cancel(entry);
    if (!result) return;
    report(result, own);
    if (result.status === "cancelled") selected.current.delete(entry.id);
    refreshPending(own);
  }

  function choose(files: File[]) { start(files.map(file => ({ file, name: file.webkitRelativePath || file.name }))); }
  function chooseFolder(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    choose(files);
  }
  function reselect(event: ChangeEvent<HTMLInputElement>, entry: PendingUpload) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file) start([{ file, name: entry.name }], entry);
  }
  async function drop(data: DataTransfer) {
    if (active.current) return;
    const own = generation.current;
    setError(null);
    try {
      const selections = await droppedFiles(data);
      if (live(own)) start(selections);
    } catch { if (live(own)) setError({ code: "api.request_failed", data: {} }); }
  }

  async function changeSource(request: () => Promise<unknown>, done: (value: unknown) => void) {
    if (sourceBusy) return;
    const own = generation.current;
    setSourceBusy(true); setSourceError(null);
    try { const value = await request(); if (live(own)) { done(value); callbacks.current.onChange(); } }
    catch (problem) { if (live(own)) fail(asApiFailure(problem), setSourceError); }
    finally { if (live(own)) setSourceBusy(false); }
  }
  const folderPath = path ?? importView.path ?? "";
  const currentLink = linkOverride ?? linkView;
  const zipAddress = url ?? currentLink.url ?? "";
  const checkedSize = checkedLink?.url === zipAddress ? checkedLink.size : url === null ? currentLink.size : null;
  useEffect(() => { if (linkOverride?.url === linkView.url) setLinkOverride(undefined); }, [linkView, linkOverride]);
  function importFolder(event: FormEvent) {
    event.preventDefault();
    void changeSource(() => api("PUT", `/api/projects/${projectId}/import`, { path: folderPath }), () => setPath(null));
  }
  function saveLink(event: FormEvent) {
    event.preventDefault();
    void changeSource(() => api<LinkSourceView>("PUT", `/api/projects/${projectId}/link`, { url: zipAddress }), value => {
      const checked = value as LinkSourceView;
      setLinkOverride(checked); setCheckedLink({ url: zipAddress, size: checked.size }); setUrl(null);
    });
  }
  function removeLink() { void changeSource(() => api<LinkSourceView>("DELETE", `/api/projects/${projectId}/link`), value => { setLinkOverride(value as LinkSourceView); setCheckedLink(null); setUrl(null); }); }

  const folderForm = localImportAllowed && importView.available;
  const alert = (failure: Failure | null) => failure && <Notice tone="danger" role="alert">{t(failure.code, messageParams(failure))}</Notice>;
  const prevent = (event: { preventDefault(): void }) => event.preventDefault();
  const noPending = pending.length === 0;

  let body;
  if (currentLink.url !== null) {
    body = <Card title={t("photos.visual.source_zip")}>
      <p className="photos-intake-wrap">{t("link.current", { url: currentLink.url })}</p>
      {checkedSize !== null && <p>{t("link.size", { size: formatBytes(checkedSize) })}</p>}
      <p>{t("link.engine_download")}</p>
      {currentLink.facts === null ? <p>{t("link.facts_unavailable")}</p> : <>
        <h3>{t("link.facts")}</h3>
        <p>{t("link.count", { count: currentLink.facts.photoCount })}</p><p>{t("link.without_gps", { count: currentLink.facts.withoutGps })}</p>
        <KeyValueList items={[
          { id: "cameras", key: t("link.cameras"), value: currentLink.facts.cameras.map((item,index) => <p key={index}>{t("link.camera_count", { camera: [item.make,item.model].filter(Boolean).join(" ") || t("photos.visual.unknown_camera"), count: item.photoCount })}</p>) },
          { id: "dimensions", key: t("link.dimensions"), value: currentLink.facts.dimensions.map((item,index) => <p key={index}>{t("link.dimension_count", { width: item.width, height: item.height, count: item.photoCount })}</p>) },
        ]} />
      </>}
      <form onSubmit={saveLink}>
        <TextField id="photos-intake-url" label={t("link.url")} value={zipAddress} onChange={event => { setUrl(event.target.value); setCheckedLink(null); }} required disabled={sourceBusy} />
        <Button type="submit" variant="secondary" disabled={sourceBusy}>{t("link.check")}</Button>
      </form>
      {alert(sourceError)}
      <Button variant="secondary" disabled={sourceBusy} onClick={removeLink}>{t("link.remove")}</Button>
    </Card>;
  } else if (importView.state !== "none") {
    body = <Card title={t("photos.visual.source_folder")}>
      <p role="status">{t(`folder.state_${importView.state}`)}</p>
      {importView.path !== null && <p className="photos-intake-wrap">{t("photos.visual.folder_at", { path: importView.path })}</p>}
      <p>{t("folder.accepted", { count: importView.acceptedCount })}</p>
      <p>{t("folder.skipped", { count: importView.skippedCount })}</p>
      {importView.groundControlCount > 0 && <p>{t("folder.ground_control", { count: importView.groundControlCount })}</p>}
      {folderForm && <form onSubmit={importFolder}>
        <TextField id="photos-intake-path" label={t("folder.path")} value={folderPath} onChange={event => setPath(event.target.value)} required disabled={sourceBusy} />
        <Button type="submit" variant="secondary" disabled={sourceBusy}>{t("folder.relink")}</Button>
      </form>}
      {sourceBusy && <p role="status">{t("folder.working")}</p>}
      {alert(sourceError)}
    </Card>;
  } else if (working) {
    body = <Card className="photos-intake-bar">
      <Progress id="photos-intake-progress" label={t("photos.visual.arriving")} hideLabel value={arrived} max={total} />
      <p role="status" className="photos-intake-counts">
        <span>{t("photos.visual.arrived", { count: arrived })}</span>{" "}
        <span>{t("upload.remaining", { count: Math.max(0, total - finished) })}</span>
        {speed !== null && <>{" "}<span>{t("upload.speed", { speed: formatBytes(speed) })}</span></>}
      </p>
      {paused && <p>{t("photos.visual.paused_hint")}</p>}
      {cancelling && <p role="status">{t("photos.visual.cancelling")}</p>}
      <div className="photos-intake-actions">
        <Button variant="secondary" disabled={cancelling} onClick={togglePause}>{t(paused ? "photos.visual.resume" : "photos.visual.pause")}</Button>
        <Button variant="secondary" disabled={cancelling} onClick={() => { void cancelActive(); }}>{t("photos.visual.cancel")}</Button>
      </div>
    </Card>;
  } else if (photoCount === 0) {
    body = <DropZone title={t("photos.visual.add_title")} chooseLabel={t("photos.visual.choose_files")} onChoose={choose} onDrop={data => { void drop(data); }}>
      <div className="photos-intake-cards">
        <Card level={3} title={t("photos.visual.card_files_title")}>
          <p>{t("photos.visual.card_files_text")}</p>
          <Button variant="secondary" onClick={() => folderInput.current?.click()}>{t("photos.visual.choose_folder")}</Button>
        </Card>
        {noPending && folderForm && <Card level={3} title={t("photos.visual.card_folder_title")}>
          <p>{t("photos.visual.card_folder_text")}</p>
          <form onSubmit={importFolder}>
            <TextField id="photos-intake-path" label={t("folder.path")} value={folderPath} onChange={event => setPath(event.target.value)} required disabled={sourceBusy} />
            <Button type="submit" variant="secondary" disabled={sourceBusy}>{t("folder.action")}</Button>
          </form>
          {sourceBusy && <p role="status">{t("folder.working")}</p>}
        </Card>}
        {noPending && <Card level={3} title={t("photos.visual.card_zip_title")}>
          <p>{t("photos.visual.card_zip_text")}</p>
          <form onSubmit={saveLink}>
            <TextField id="photos-intake-url" label={t("link.url")} value={zipAddress} onChange={event => setUrl(event.target.value)} required disabled={sourceBusy} />
            <Button type="submit" variant="secondary" disabled={sourceBusy}>{t("link.check")}</Button>
          </form>
        </Card>}
      </div>
      {alert(sourceError)}
    </DropZone>;
  } else {
    body = <>
      <div className="photos-intake-summary">
        <p role="status">{t("upload.arrived", { count: photoCount })}</p>
        <Button variant="secondary" aria-expanded={adding} onClick={() => setAdding(value => !value)}>{t("photos.visual.add_more")}</Button>
      </div>
      {adding && <DropZone title={t("photos.visual.drop_more")} chooseLabel={t("photos.visual.choose_files")} onChoose={choose} onDrop={data => { void drop(data); }}>
        <Button variant="secondary" onClick={() => folderInput.current?.click()}>{t("photos.visual.choose_folder")}</Button>
      </DropZone>}
    </>;
  }

  const pendingOffset = Math.min(pendingPage, Math.max(0, Math.ceil(pending.length / pageSize) - 1)) * pageSize;
  const skippedOffset = skipPage * pageSize;
  const uploading = currentLink.url === null && importView.state === "none";
  return <div className="photos-intake" onDragOver={prevent} onDrop={prevent}>
    {uploading && alert(error)}
    {body}
    {uploading && <input ref={folderInput} type="file" multiple className="visually-hidden" tabIndex={-1} aria-hidden="true" disabled={working} onChange={chooseFolder} {...{ webkitdirectory: "" }} />}
    {uploading && skipped.length > 0 && <Disclosure label={t("upload.skipped", { count: skipped.length })}>
      <ul>{skipped.slice(skippedOffset, skippedOffset + pageSize).map((item, index) => <li key={skippedOffset + index}>{t("upload.skipped_file", { name: item.name, reason: t(item.code) })}</li>)}</ul>
      <Pages previous={skipPage > 0} next={skippedOffset + pageSize < skipped.length} onPrevious={() => setSkipPage(value => value - 1)} onNext={() => setSkipPage(value => value + 1)} />
    </Disclosure>}
    {uploading && !working && pending.length > 0 && <Card level={3} title={t("upload.pending")}>
      {pending.slice(pendingOffset, pendingOffset + pageSize).map(entry => <div key={entry.id}>
        <p>{t("upload.file_summary", { name: entry.name, size: formatBytes(entry.size) })}</p>
        <p>{t("upload.awaiting")}</p>
        <div className="field"><label htmlFor={`photos-intake-reselect-${entry.id}`}>{t("upload.reselect", { name: entry.name })}</label><input id={`photos-intake-reselect-${entry.id}`} type="file" disabled={working} onChange={event => reselect(event, entry)} /></div>
        <div className="photos-intake-actions">
          {selected.current.has(entry.id) && <Button disabled={working} onClick={() => { const file = selected.current.get(entry.id); if (file) start([{ file, name: entry.name }], entry); }}>{t("upload.retry", { name: entry.name })}</Button>}
          <Button variant="secondary" disabled={working} onClick={() => { void cancelPending(entry); }}>{t("upload.cancel", { name: entry.name })}</Button>
        </div>
      </div>)}
      <Pages previous={pendingOffset > 0} next={pendingOffset + pageSize < pending.length} onPrevious={() => setPendingPage(pendingOffset / pageSize - 1)} onNext={() => setPendingPage(pendingOffset / pageSize + 1)} />
    </Card>}
  </div>;
}

function Pages({ previous, next, onPrevious, onNext }: { previous: boolean; next: boolean; onPrevious(): void; onNext(): void }) {
  return <>{previous && <Button variant="secondary" onClick={onPrevious}>{t("upload.previous")}</Button>}{" "}{next && <Button variant="secondary" onClick={onNext}>{t("upload.next")}</Button>}</>;
}

/** What a drop holds. Folders are read entry by entry, since a file list cannot carry them. */
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
