import { useEffect, useRef, useState } from "react";
import type { PhotoFlightView, ProjectPhotoFactsView } from "../../../shared/api-types.ts";
import { api, asApiFailure, type ApiFailure } from "../api.ts";
import { ErrorMessage } from "../components/ErrorMessage.tsx";
import { Button } from "../controls/Button.tsx";
import { formatBytes } from "../format.ts";
import { t } from "../i18n/translate.ts";

const pageSize = 50;

function camera(make: string | null, model: string | null): string {
  return [make, model].filter(Boolean).join(" ") || t("photos.unknown_camera");
}

function span(clock: "camera" | "offset", first: string, last: string): string {
  return t(clock === "camera" ? "photos.camera_span" : "photos.offset_span", { first, last });
}

export function PhotoFactsView({ facts, offset, busy, onPage, onSelect }: { facts: ProjectPhotoFactsView; offset: number; busy: boolean; onPage(offset: number): void; onSelect(flight: PhotoFlightView, excluded: boolean): void }) {
  return <section aria-labelledby="photo-facts-title">
    <h2 id="photo-facts-title">{t("photos.title")}</h2>
    <p>{t("photos.unique_explain")}</p>
    <ul>
      <li>{t("photos.count", { count: facts.photoCount })}</li>
      <li>{t("photos.size", { size: formatBytes(facts.photoBytes), bytes: new Intl.NumberFormat("en").format(facts.photoBytes) })}</li>
      <li>{t("photos.duplicates", { count: facts.duplicates })}</li>
      <li>{t("photos.videos", { count: facts.videoCount })}</li>
      <li>{t("photos.without_gps", { count: facts.withoutGps })}</li>
      <li>{t("photos.unassigned", { count: facts.unassignedCount })}</li>
    </ul>
    {facts.pendingMetadata > 0 && <p role="status">{t("photos.pending", { count: facts.pendingMetadata })}</p>}
    <h3>{t("photos.cameras")}</h3>
    {facts.cameras.length ? <ul>{facts.cameras.map((item, index) => <li key={index}>{t("photos.group_count", { name: camera(item.make, item.model), count: item.photoCount })}</li>)}</ul> : <p>{t("photos.no_cameras")}</p>}
    <h3>{t("photos.dates")}</h3>
    {facts.dateSpans.length ? <ul>{facts.dateSpans.map(item => <li key={item.clock}>{span(item.clock, item.first, item.last)}</li>)}</ul> : <p>{t("photos.no_dates")}</p>}
    <h3>{t("photos.bands")}</h3>
    {facts.bands.length ? <ul>{facts.bands.map(item => <li key={item.name}>{t("photos.group_count", { name: item.name, count: item.photoCount })}</li>)}</ul> : <p>{t("photos.no_bands")}</p>}
    <h3>{t("photos.flights", { count: facts.flightCount })}</h3>
    {facts.flights.length ? <ul>{facts.flights.map(flight => <li key={flight.id}>
      <p>{t("photos.group_count", { name: camera(flight.make, flight.model), count: flight.photoCount })}<br />{span(flight.clock, flight.first, flight.last)}<br />{t("photos.excluded", { excluded: flight.excludedPhotoCount, count: flight.photoCount })}</p>
      {flight.excludedPhotoCount > 0 && <Button className="secondary" disabled={busy} onClick={() => onSelect(flight, false)}>{t("photos.include_all")}</Button>}{" "}
      {flight.excludedPhotoCount < flight.photoCount && <Button className="secondary" disabled={busy} onClick={() => onSelect(flight, true)}>{t("photos.exclude_all")}</Button>}
    </li>)}</ul> : <p>{t("photos.no_flights")}</p>}
    {offset > 0 && <Button className="secondary" disabled={busy} onClick={() => onPage(Math.max(0, offset - pageSize))}>{t("upload.previous")}</Button>}{" "}
    {facts.nextOffset !== null && <Button className="secondary" disabled={busy} onClick={() => onPage(facts.nextOffset!)}>{t("upload.next")}</Button>}
  </section>;
}

export function PhotoFacts({ projectId, refresh, onAuthRequired }: { projectId: number; refresh: number; onAuthRequired(): void }) {
  const [facts, setFacts] = useState<ProjectPhotoFactsView | null>(null);
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const selectionGeneration = useRef(0);
  useEffect(() => {
    selectionGeneration.current++;
    setBusy(false);
    return () => { selectionGeneration.current++; };
  }, [projectId]);
  const auth = useRef(onAuthRequired);
  auth.current = onAuthRequired;
  useEffect(() => {
    const current = ++generation.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function load() {
      void api<ProjectPhotoFactsView>("GET", `/api/projects/${projectId}/photo-facts?offset=${offset}&limit=${pageSize}`).then(value => {
        if (generation.current !== current) return;
        setFacts(value);
        if (value.pendingMetadata > 0) timer = setTimeout(load, 1000);
      }, error => {
        if (generation.current !== current) return;
        const problem = asApiFailure(error);
        if (problem.code === "auth.passphrase_required") auth.current(); else setFailure(problem);
      });
    }
    load();
    return () => { generation.current++; if (timer !== undefined) clearTimeout(timer); };
  }, [projectId, offset, refresh, revision]);
  async function select(flight: PhotoFlightView, excluded: boolean) {
    if (busy) return;
    const current = selectionGeneration.current;
    setBusy(true); setFailure(null);
    try {
      await api<void>("PUT", `/api/projects/${projectId}/flights/${encodeURIComponent(flight.id)}`, { excluded });
      if (selectionGeneration.current === current) setRevision(value => value + 1);
    } catch (error) {
      if (selectionGeneration.current !== current) return;
      const problem = asApiFailure(error);
      if (problem.code === "auth.passphrase_required") auth.current(); else setFailure(problem);
      if (problem.status === 404) setRevision(value => value + 1);
    } finally { if (selectionGeneration.current === current) setBusy(false); }
  }
  return <>{failure && <ErrorMessage failure={failure} />}{facts && <PhotoFactsView facts={facts} offset={offset} busy={busy} onPage={setOffset} onSelect={(flight, excluded) => void select(flight, excluded)} />}</>;
}
