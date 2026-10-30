import { useEffect, useRef, useState, type FormEvent } from "react";
import type { LinkSourceView } from "../../../shared/link-source.ts";
import { api, asApiFailure, type ApiFailure } from "../api.ts";
import { ErrorMessage } from "../components/ErrorMessage.tsx";
import { Button } from "../controls/Button.tsx";
import { TextField } from "../controls/TextField.tsx";
import { formatBytes } from "../format.ts";
import { t } from "../i18n/translate.ts";

export function LinkSourceContent({ view, url, working, onUrl, onCheck, onRemove }: { view: LinkSourceView; url: string; working: boolean; onUrl(value: string): void; onCheck(): void; onRemove(): void }) {
  function submit(event: FormEvent) { event.preventDefault(); onCheck(); }
  return <section aria-labelledby="link-title">
    <h2 id="link-title">{t("link.title")}</h2>
    <p>{t("link.help")}</p>
    <form onSubmit={submit}><TextField id="link-url" label={t("link.url")} value={url} onChange={event => onUrl(event.target.value)} required />
      <Button type="submit" disabled={working}>{t("link.check")}</Button></form>
    {view.url !== null && <>
      <p>{t("link.current", { url: view.url })}</p>
      {view.size !== null && <p>{t("link.size", { size: formatBytes(view.size) })}</p>}
      <p>{t("link.engine_download")}</p>
      {view.facts === null ? <p>{t("link.facts_unavailable")}</p> : <>
        <h3>{t("link.facts")}</h3>
        <p>{t("link.count", { count: view.facts.photoCount })}</p>
        <p>{t("link.without_gps", { count: view.facts.withoutGps })}</p>
        <h4>{t("link.cameras")}</h4><ul>{view.facts.cameras.map((camera, index) => <li key={index}>{t("link.camera_count", { camera: [camera.make, camera.model].filter(Boolean).join(" ") || t("photos.unknown_camera"), count: camera.photoCount })}</li>)}</ul>
        <h4>{t("link.dimensions")}</h4><ul>{view.facts.dimensions.map((item, index) => <li key={index}>{t("link.dimension_count", { width: item.width, height: item.height, count: item.photoCount })}</li>)}</ul>
      </>}
      <Button className="secondary" disabled={working} onClick={onRemove}>{t("link.remove")}</Button>
    </>}
  </section>;
}

export function LinkSource({ projectId, onSource, onAuthRequired }: { projectId: number; onSource(url: string | null): void; onAuthRequired(): void }) {
  const [view, setView] = useState<LinkSourceView | null>(null);
  const [url, setUrl] = useState("");
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [working, setWorking] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const callbacks = useRef({ onSource, onAuthRequired });
  callbacks.current = { onSource, onAuthRequired };
  const generation = useRef(0);
  const request = useRef(0);
  const edited = useRef(false);
  const busy = useRef(false);
  useEffect(() => {
    const current = ++generation.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function load() {
      if (busy.current) { timer = setTimeout(load, 3000); return; }
      const sequence = ++request.current;
      void api<LinkSourceView>("GET", `/api/projects/${projectId}/link`).then(value => {
        if (generation.current !== current || request.current !== sequence) return;
        setView(previous => previous?.url === value.url ? { ...value, size: previous.size } : value);
        if (!edited.current) setUrl(value.url ?? "");
        callbacks.current.onSource(value.url);
        if (value.url !== null) timer = setTimeout(load, 3000);
      }, error => {
        if (generation.current !== current || request.current !== sequence) return;
        const problem = asApiFailure(error);
        if (problem.code === "auth.passphrase_required") callbacks.current.onAuthRequired(); else setFailure(problem);
      });
    }
    load();
    return () => { generation.current++; if (timer !== undefined) clearTimeout(timer); };
  }, [projectId, refresh]);
  async function change(method: "PUT" | "DELETE") {
    if (working) return;
    const current = generation.current;
    ++request.current;
    busy.current = true; setWorking(true); setFailure(null);
    if (method === "PUT") setView(previous => previous ? { ...previous, size: null } : previous);
    try {
      const value = await api<LinkSourceView>(method, `/api/projects/${projectId}/link`, method === "PUT" ? { url } : undefined);
      if (generation.current !== current) return;
      edited.current = false; setUrl(value.url ?? ""); setView(value); callbacks.current.onSource(value.url);
    } catch (error) {
      if (generation.current !== current) return;
      const problem = asApiFailure(error);
      if (problem.code === "auth.passphrase_required") callbacks.current.onAuthRequired(); else setFailure(problem);
    } finally { if (generation.current === current) { busy.current = false; setWorking(false); setRefresh(value => value + 1); } }
  }
  return <>{failure && <ErrorMessage failure={failure} />}{view && <LinkSourceContent view={view} url={url} working={working} onUrl={value => { edited.current = true; setUrl(value); setView(previous => previous ? { ...previous, size: null } : previous); }} onCheck={() => void change("PUT")} onRemove={() => void change("DELETE")} />}</>;
}
