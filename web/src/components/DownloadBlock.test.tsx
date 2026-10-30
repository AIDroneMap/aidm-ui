import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { RunProgress } from "../pages/SampleJobPage.tsx";
import type { LocalEngineView, RunView } from "../../../shared/api-types.ts";
import { engineInstall, fresh, macInstall } from "../localEngine.fixtures.ts";
import { DownloadBlock } from "./DownloadBlock.tsx";
import { LocalInstallStatus } from "./LocalInstall.tsx";

const MIB = 1024 ** 2;

const BLOCK = '<div class="download-block" data-download-block="">';

test("the block says what is downloading, then the bar, then the bytes and the speed, then the last interruption", () => {
  const html = renderToStaticMarkup(
    <DownloadBlock
      title="Downloading the thing"
      received={200 * MIB}
      size={683 * MIB}
      speed={3 * MIB}
      interruption="It broke. Interruptions so far: 1."
      progressId="thing-progress"
      extra={<p>3 of 9 parts</p>}
    />,
  );
  expect(html.startsWith(BLOCK)).toBe(true);
  const order = [
    '<label for="thing-progress">Downloading the thing</label>',
    `<progress id="thing-progress" max="${683 * MIB}" value="${200 * MIB}">`,
    "200 MiB of 683 MiB, 3 MiB per second",
    "3 of 9 parts",
    "It broke. Interruptions so far: 1.",
  ].map((part) => html.indexOf(part));
  expect(order.every((at) => at >= 0)).toBe(true);
  expect(order).toEqual([...order].sort((a, b) => a - b));
});

test("only the title line is in a status region, so the counts do not interrupt a screen reader", () => {
  const html = renderToStaticMarkup(
    <DownloadBlock title="Downloading the thing" received={1} size={2} speed={1} interruption="It broke." progressId="p" />,
  );
  expect(html.match(/role="status"/g)).toHaveLength(1);
  expect(/<p role="status">(.*?)<\/p>/.exec(html)?.[1]).toContain("Downloading the thing");
});

test("without bytes or without a size the bar has no value, and no speed or interruption is invented", () => {
  const unknown = renderToStaticMarkup(<DownloadBlock title="T" received={null} size={null} speed={null} interruption={null} progressId="p" />);
  expect(unknown).toContain('<progress id="p"></progress>');
  expect(unknown).not.toContain("MiB");
  const noSize = renderToStaticMarkup(<DownloadBlock title="T" received={5 * MIB} size={null} speed={null} interruption={null} progressId="p" />);
  expect(noSize).toContain('<progress id="p"></progress>');
  expect(noSize).toContain("<p>5 MiB</p>");
  const noSpeed = renderToStaticMarkup(<DownloadBlock title="T" received={5 * MIB} size={10 * MIB} speed={null} interruption={null} progressId="p" />);
  expect(noSpeed).toContain("<p>5 MiB of 10 MiB</p>");
  expect(noSpeed).not.toContain("per second");
});

// A screen cannot show a download without the shared block.

const SRC = join(import.meta.dir, "..");

function sourceFiles(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx"))
    .map((entry) => join(entry.parentPath, entry.name));
}

/** The bars of the sample job that are not downloads: the images sent to the engine, and the engine's own processing. */
const NOT_DOWNLOADS = new Set(["run-upload", "run-processing"]);

test("no screen has a progress bar of its own for a download: only the shared block draws one", () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(SRC)) {
    if (file.endsWith("DownloadBlock.tsx") || file.endsWith("controls/Progress.tsx")) continue;
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/<progress\b\s*(?:id="([^"]*)")?/g)) {
      if (match[1] === undefined || !NOT_DOWNLOADS.has(match[1])) offenders.push(`${file.slice(SRC.length + 1)}: ${match[0].trim()}`);
    }
  }
  expect(offenders).toEqual([]);
});

/** The number of progress bars that are not inside a download block. */
function barsOutsideBlocks(html: string): number {
  const outside = html.replaceAll(new RegExp(`${BLOCK}.*?</div>`, "gs"), "");
  return (outside.match(/<progress\b/g) ?? []).length;
}

const mac = (step: Parameters<typeof macInstall>[0], stepReceived: number | null): LocalEngineView => ({
  ...fresh,
  state: "installing",
  install: macInstall(step, { stepReceived }),
});

const engine: LocalEngineView = {
  ...fresh,
  state: "installing",
  install: engineInstall({ stepReceived: 100 * MIB, speed: MIB, layersDone: 1, layersTotal: 4 }),
};

const run: RunView = {
  name: null, preset: null, wayIn: null, sample: false,
  id: 7,
  projectId: 1,
  engineId: 1,
  engineName: "Barn engine",
  engineLocal: false,
  state: "created",
  step: "download",
  download: { received: 100 * MIB, total: 848 * MIB, speed: MIB, retries: 0, lastRetry: null },
  upload: null,
  progress: null,
  engineMessage: null,
  problem: null,
  restarted: false,
  restartedAtLine: null,
  resultsAvailable: false,
  createdAt: "2026-10-26T10:00:00Z",
};

test("every download state of the engine, the Mac steps and the sample photos draws its bar inside the shared block", () => {
  const screens: Record<string, string> = {
    engine: renderToStaticMarkup(<LocalInstallStatus view={engine} />),
    "engine, size of the parts only": renderToStaticMarkup(
      <LocalInstallStatus view={{ ...engine, install: { ...engine.install!, stepReceived: null } }} />,
    ),
    installer: renderToStaticMarkup(<LocalInstallStatus view={mac("installer", 50 * MIB)} />),
    kernel: renderToStaticMarkup(<LocalInstallStatus view={mac("kernel", 50 * MIB)} />),
    "kernel before the first byte": renderToStaticMarkup(<LocalInstallStatus view={mac("kernel", null)} />),
    init: renderToStaticMarkup(<LocalInstallStatus view={mac("init", 10 * MIB)} />),
    "sample photos": renderToStaticMarkup(
      <RunProgress stage={null} run={run} lines={[]} connectionLost={false} cancelling={false} failure={null} onCancel={() => {}} onAgain={() => {}} />,
    ),
  };
  for (const [name, html] of Object.entries(screens)) {
    expect(html.match(/<progress\b/g)?.length, name).toBe(1);
    expect(html.match(/data-download-block/g)?.length, name).toBe(1);
    expect(barsOutsideBlocks(html), name).toBe(0);
  }
});

test("a download of the Mac steps that lost its connection says so last in its block, like the engine's", () => {
  const view: LocalEngineView = {
    ...fresh,
    state: "installing",
    install: macInstall("kernel", { stepReceived: 1000, retries: 2, lastRetry: { code: "download.connection_interrupted", data: {} } }),
  };
  const html = renderToStaticMarkup(<LocalInstallStatus view={view} />);
  const block = html.slice(html.indexOf("data-download-block"));
  expect(block).toContain("The connection was interrupted. The download continues from where it stopped.");
  expect(block.indexOf("The connection was interrupted")).toBeGreaterThan(block.indexOf("<progress"));
});
