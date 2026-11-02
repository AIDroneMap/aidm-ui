import { useEffect, useState, type ReactNode } from "react";
import type { RunView } from "../../../../shared/api-types.ts";
import type { RunMapView } from "../../../../shared/map.ts";
import { formatBytes } from "../../format.ts";
import { IconBox, IconDownload, IconMap } from "../../icons/icons.tsx";
import { t } from "../../i18n/translate.ts";
import { resultsHash } from "../../router.ts";
import { previewTileUrl } from "./preview.ts";
import "./results.css";

/** The outputs a run's archive can hold, in the order the downloads list them. */
export const OUTPUT_ORDER = ["orthophoto", "surface", "ground", "point-cloud", "textured-model", "glb", "report"] as const;

/** The preview of the map tile: the engine's lowest zoom orthophoto tile, or null when the engine made no tiles. */
function useMapPreview(runId: number, wanted: boolean): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    setUrl(null);
    if (!wanted) return;
    const controller = new AbortController();
    fetch(`/api/runs/${runId}/map`, { credentials: "same-origin", signal: controller.signal })
      .then((response) => (response.ok ? (response.json() as Promise<RunMapView>) : null))
      .then((view) => {
        const layer = view?.layers.find((item) => item.name === "orthophoto");
        if (!controller.signal.aborted && layer?.kind === "tiles") setUrl(previewTileUrl(runId, layer));
      })
      // The preview is a picture only: without it the tile keeps its neutral strip.
      .catch(() => {});
    return () => controller.abort();
  }, [runId, wanted]);
  return url;
}

function ViewerTile({ href, title, icon, preview, sizes }: { href: string; title: string; icon: ReactNode; preview: string | null; sizes: Array<{ name: string; size: number }> }) {
  const [broken, setBroken] = useState(false);
  return (
    <a className="viewer-tile" href={href}>
      <span className="viewer-tile-preview" aria-hidden="true">
        {preview && !broken ? <img src={preview} alt="" onError={() => setBroken(true)} /> : icon}
      </span>
      <span className="viewer-tile-title">{title}</span>
      <span className="viewer-tile-sizes">
        {sizes.map((output) => <span key={output.name}>{t("results.tile_size", { name: t(`results.output.${output.name}`), size: formatBytes(output.size) })}</span>)}
      </span>
    </a>
  );
}

/**
 * What a finished run made, once its archive is on this computer: a tile for
 * the map and one for the 3D model, each only when the run made that output,
 * then the downloads, the whole archive first. The Results section and the
 * run screen both show it. Nothing is shown before the archive is ready.
 */
export function RunOutputs({ run }: { run: RunView }) {
  const results = run.results?.state === "ready" ? run.results : null;
  const outputs = OUTPUT_ORDER.flatMap((name) => {
    const output = results?.outputs.find((item) => item.name === name);
    return output ? [{ name, size: output.size }] : [];
  });
  const sizes = (...names: string[]) => outputs.filter((output) => names.includes(output.name));
  const orthophoto = outputs.some((output) => output.name === "orthophoto");
  const model = outputs.some((output) => output.name === "glb");
  const preview = useMapPreview(run.id, orthophoto);
  if (!results) return null;
  return (
    <div className="run-outputs">
      {(orthophoto || model) && (
        <section className="viewer-tiles" aria-label={t("results.viewers")}>
          {orthophoto && <ViewerTile href={resultsHash(run.projectId, run.id, "map")} title={t("results.open_map")} icon={<IconMap />} preview={preview} sizes={sizes("orthophoto", "surface", "ground")} />}
          {model && <ViewerTile href={resultsHash(run.projectId, run.id, "model")} title={t("results.open_model")} icon={<IconBox />} preview={null} sizes={sizes("glb")} />}
        </section>
      )}
      <section className="downloads" aria-labelledby={`downloads-${run.id}`}>
        <h2 id={`downloads-${run.id}`}>{t("results.downloads")}</h2>
        <ul>
          <li>
            <a href={`/api/runs/${run.id}/results`} download><IconDownload /> {t("results.archive")}</a>
            {results.archiveSize !== null && <span className="download-size">{formatBytes(results.archiveSize)}</span>}
          </li>
          {outputs.map((output) => (
            <li key={output.name}>
              <a href={`/api/runs/${run.id}/outputs/${encodeURIComponent(output.name)}`} download><IconDownload /> {t(`results.output.${output.name}`)}</a>
              <span className="download-size">{formatBytes(output.size)}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
