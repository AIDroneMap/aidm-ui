import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { PhotoPosition, ProjectPhotoFactsView, ProjectPhotoPositionsView } from "../../../../shared/api-types.ts";
import { api, asApiFailure, type ApiFailure } from "../../api.ts";
import { ErrorMessage } from "../../components/ErrorMessage.tsx";
import { Button } from "../../controls/Button.tsx";
import { Disclosure } from "../../controls/Disclosure.tsx";
import { KeyValueList } from "../../controls/KeyValueList.tsx";
import { ThumbnailGrid } from "../../controls/ThumbnailGrid.tsx";
import { Timeline } from "../../controls/Timeline.tsx";
import { Toggle } from "../../controls/Toggle.tsx";
import { formatBytes } from "../../format.ts";
import { t } from "../../i18n/translate.ts";

const PositionsMap = lazy(() => import("./PositionsMap.tsx"));
const pageSize = 50;
const emptyPositions: PhotoPosition[] = [];
function camera(make: string | null, model: string | null) { return [make, model].filter(Boolean).join(" ") || t("photos.visual.unknown_camera"); }
function timestamp(value: string) { return Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : value + "Z"); }

export function PhotosVisuals({ projectId, imported, refresh, onChange, onAuthRequired }: { projectId: number; imported: boolean; refresh: number; onChange(): void; onAuthRequired(): void }) {
  const [facts, setFacts] = useState<ProjectPhotoFactsView | null>(null);
  const [page, setPage] = useState<ProjectPhotoPositionsView | null>(null);
  const [positions, setPositions] = useState<PhotoPosition[] | null>(null);
  const knownPositions = positions ?? emptyPositions;
  const [offset, setOffset] = useState(0);
  const [flightOffset, setFlightOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const [missing, setMissing] = useState<Set<string>>(() => new Set());
  const callbacks = useRef({ onAuthRequired, onChange }); callbacks.current = { onAuthRequired, onChange };
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    let timer: Timer | undefined;
    const load = async () => {
      try {
        const [summary, photos] = await Promise.all([
          api<ProjectPhotoFactsView>("GET", `/api/projects/${projectId}/photo-facts?offset=${flightOffset}&limit=${pageSize}`),
          api<ProjectPhotoPositionsView>("GET", `/api/projects/${projectId}/photo-positions?offset=${offset}&limit=${pageSize}`),
        ]);
        if (generation.current !== current) return;
        setFacts(summary); setPage(photos); setFailure(null);
        if (summary.pendingMetadata > 0 || photos.pendingMetadata > 0) timer = setTimeout(() => { void load(); }, 1000);
      } catch (error) {
        if (generation.current !== current) return;
        const problem = asApiFailure(error);
        if (problem.code === "auth.passphrase_required") callbacks.current.onAuthRequired(); else setFailure(problem);
      }
    };
    void load();
    return () => { generation.current++; if (timer) clearTimeout(timer); };
  }, [projectId, refresh, revision, offset, flightOffset]);

  // Map and minute strips read small pages. The thumbnail page remains independent.
  useEffect(() => {
    let current = true;
    void (async () => {
      const all: PhotoPosition[] = [];
      let next: number | null = 0;
      try {
        while (next !== null && current) {
          const value: ProjectPhotoPositionsView = await api("GET", `/api/projects/${projectId}/photo-positions?offset=${next}&limit=100`);
          all.push(...value.photos); next = value.nextOffset;
        }
        if (current) setPositions(all);
      } catch (error) {
        if (!current) return;
        const problem = asApiFailure(error);
        if (problem.code === "auth.passphrase_required") callbacks.current.onAuthRequired(); else setFailure(problem);
      }
    })();
    return () => { current = false; };
  }, [projectId, refresh, revision, facts?.pendingMetadata]);

  async function select(id: string, excluded: boolean) {
    if (busy) return;
    const current = generation.current;
    setBusy(true);
    try {
      await api("PUT", `/api/projects/${projectId}/flights/${id}`, { excluded });
      if (generation.current === current) { setRevision(value => value + 1); callbacks.current.onChange(); }
    } catch (error) {
      if (generation.current !== current) return;
      const problem = asApiFailure(error);
      if (problem.code === "auth.passphrase_required") callbacks.current.onAuthRequired(); else setFailure(problem);
      if (problem.status === 404) setRevision(value => value + 1);
    } finally { setBusy(false); }
  }
  const flightNumbers = useMemo(() => new Map([...new Set(knownPositions.map(photo => photo.flightId))].sort().map((id,index) => [id,index + 1])), [knownPositions]);
  const primaryNames = useMemo(() => new Set(knownPositions.map(photo => photo.name)), [knownPositions]);
  const flights = facts?.flights ?? [];
  const start = flights.reduce((value, flight) => Math.min(value, timestamp(flight.first)), Infinity);
  const end = flights.reduce((value, flight) => Math.max(value, timestamp(flight.last)), -Infinity);
  if (!failure && (!facts || (facts.photoCount === 0 && facts.videoCount === 0))) return null;
  return <div className="photos-visuals">
    {failure && <><ErrorMessage failure={failure} /><Button variant="secondary" onClick={() => setRevision(value => value + 1)}>{t("photos.visual.retry")}</Button></>}
    {facts?.pendingMetadata ? <p role="status">{t("photos.visual.pending", { count: facts.pendingMetadata })}</p> : null}
    <section aria-labelledby="photos-grid-title">
      <h2 id="photos-grid-title">{t("photos.visual.grid")}</h2>
      <div onErrorCapture={event => { const target = event.target; if (target instanceof HTMLImageElement) { const hash = target.src.split("/").at(-2); if (hash) setMissing(value => new Set([...value, hash])); } }}>
        <ThumbnailGrid label={t("photos.visual.grid")} items={(page?.photos ?? []).map(photo => ({ id: photo.sha256, name: photo.name, src: missing.has(photo.sha256) ? null : `/api/projects/${projectId}/photos/${photo.sha256}/thumbnail`, detail: <>{camera(photo.make, photo.model)}{photo.excluded && <><br />{t("photos.visual.left_out")}</>}</> }))} />
      </div>
      <div className="photos-pages">
        {offset > 0 && <Button variant="secondary" onClick={() => setOffset(value => Math.max(0, value - pageSize))}>{t("photos.visual.previous")}</Button>}
        {page?.nextOffset !== null && page?.nextOffset !== undefined && <Button variant="secondary" onClick={() => setOffset(page.nextOffset!)}>{t("photos.visual.next")}</Button>}
      </div>
    </section>
    <section aria-labelledby="photos-positions-title">
      <h2 id="photos-positions-title">{t("photos.visual.positions")}</h2>
      {facts && <p>{t("photos.visual.without_gps", { count: facts.withoutGps })}</p>}
      {positions === null ? <p role="status">{t("photos.visual.loading")}</p> : knownPositions.some(photo => photo.latitude !== null && photo.longitude !== null) ? <Suspense fallback={<p role="status">{t("photos.visual.loading")}</p>}><PositionsMap photos={knownPositions} /></Suspense> : <p>{t("photos.visual.no_positions")}</p>}
    </section>
    <section aria-labelledby="photos-timeline-title">
      <h2 id="photos-timeline-title">{t("photos.visual.timeline")}</h2>
      {flights.length > 0 ? <Timeline label={t("photos.visual.timeline")} start={start} end={end} rows={flights.map(flight => ({
        id: flight.id, label: <>{camera(flight.make, flight.model)}{flightNumbers.has(flight.id) && <small>{t("photos.visual.flight_number", { count: flightNumbers.get(flight.id)! })}</small>}</>, start: timestamp(flight.first), end: timestamp(flight.last),
        detail: <>{t("photos.visual.flight_detail", { first: flight.first, last: flight.last, count: flight.photoCount })}<br />{t(flight.clock === "camera" ? "photos.visual.camera_time" : "photos.visual.offset_time")}<br />{t("photos.visual.excluded_count", { count: flight.excludedPhotoCount, total: flight.photoCount })}</>,
        muted: flight.excludedPhotoCount === flight.photoCount,
        control: <Toggle id={`photos-flight-${flight.id}`} label={t("photos.visual.include")} checked={flight.excludedPhotoCount < flight.photoCount} disabled={busy || !!facts?.pendingMetadata} onChange={event => { void select(flight.id, !event.target.checked); }} />,
        moreLabel: t("photos.visual.minutes"), more: <MinuteStrip photos={knownPositions} flightId={flight.id} />,
      }))} /> : <p>{t("photos.visual.no_flights")}</p>}
      {facts && facts.unassignedCount > 0 && <p>{t("photos.visual.unassigned", { count: facts.unassignedCount })}</p>}
      <div className="photos-pages">
        {flightOffset > 0 && <Button variant="secondary" disabled={busy} onClick={() => setFlightOffset(value => Math.max(0, value - pageSize))}>{t("photos.visual.previous_flights")}</Button>}
        {facts?.nextOffset !== null && facts?.nextOffset !== undefined && <Button variant="secondary" disabled={busy} onClick={() => setFlightOffset(facts.nextOffset!)}>{t("photos.visual.next_flights")}</Button>}
      </div>
    </section>
    {facts && <section aria-labelledby="photos-facts-title"><h2 id="photos-facts-title">{t("photos.visual.facts")}</h2>
      <KeyValueList items={[
        { id: "size", key: t("photos.visual.storage"), value: formatBytes(facts.photoBytes) },
        { id: "cameras", key: t("photos.visual.cameras"), value: facts.cameras.length ? facts.cameras.map(item => <p key={JSON.stringify([item.make,item.model])}>{t("photos.visual.group_count", { name: camera(item.make,item.model), count: item.photoCount })}</p>) : t("photos.visual.unknown_camera") },
        { id: "bands", key: t("photos.visual.bands"), value: facts.bands.length ? facts.bands.map(item => <p key={item.name}>{t("photos.visual.group_count", { name: item.name, count: item.photoCount })}</p>) : t("photos.visual.no_bands") },
        { id: "videos", key: t("photos.visual.videos"), value: facts.videoCount },
        { id: "duplicates", key: t("photos.visual.duplicates"), value: facts.duplicates > 0 ? <>{facts.duplicates}<DuplicateNames projectId={projectId} imported={imported} primaryNames={primaryNames} /></> : 0 },
      ]} />
    </section>}
  </div>;
}

function MinuteStrip({ photos, flightId }: { photos: PhotoPosition[]; flightId: string }) {
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const details = root.current?.closest("details");
    if (!details) return;
    const changed = () => setOpen(details.open);
    changed(); details.addEventListener("toggle", changed);
    return () => details.removeEventListener("toggle", changed);
  }, []);
  if (!open) return <div ref={root} />;
  const minutes = new Map<string, number>();
  for (const photo of photos) if (photo.flightId === flightId && photo.captureTime) { const minute = photo.captureTime.slice(0,16); minutes.set(minute, (minutes.get(minute) ?? 0) + 1); }
  return <div ref={root}><ul className="capture-minutes" aria-label={t("photos.visual.minutes")}>{[...minutes].sort(([a],[b]) => a.localeCompare(b)).map(([minute,count]) => <li key={minute}><time>{minute}</time><span className="capture-minute-bar" style={{ width: `${Math.min(100, count * 4)}%` }} aria-hidden="true" /><span>{t("photos.visual.minute_count", { count })}</span></li>)}</ul></div>;
}

function DuplicateNames({ projectId, imported, primaryNames }: { projectId: number; imported: boolean; primaryNames: Set<string> }) {
  const [open, setOpen] = useState(false);
  const [names, setNames] = useState<string[]>([]);
  const [offset, setOffset] = useState(0);
  const [next, setNext] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!open) return;
    let current = true;
    void api<{ files: Array<{ name: string; sha256: string; kind: string }>; nextOffset: number | null }>("GET", `/api/projects/${projectId}/${imported ? "import" : "photos"}?offset=${offset}&limit=50`).then(value => {
      if (current) { setNames(value.files.filter(file => file.kind === "photo" && !primaryNames.has(file.name)).map(file => file.name)); setNext(value.nextOffset); setFailed(false); }
    }, () => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [projectId, open, offset, imported, primaryNames]);
  return <Disclosure label={t("photos.visual.show_names")} onToggle={event => setOpen(event.currentTarget.open)}>
    <p>{t("photos.visual.aliases_help")}</p>{failed && <p role="alert">{t("photos.visual.names_failed")}</p>}
    <ul className="photo-duplicate-names">{names.map(name => <li key={name}>{name}</li>)}</ul>
    {offset > 0 && <Button variant="secondary" onClick={() => setOffset(value => Math.max(0, value - 50))}>{t("photos.visual.previous")}</Button>}
    {next !== null && <Button variant="secondary" onClick={() => setOffset(next)}>{t("photos.visual.next")}</Button>}
  </Disclosure>;
}
