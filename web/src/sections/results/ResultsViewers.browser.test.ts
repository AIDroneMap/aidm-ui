import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetsFromFolder } from "../../../../server/http/static-assets.ts";
import { eventually, openHarness, type Harness } from "../../../../server/testing/harness.ts";
import { TaskClient } from "../../../../server/task-api/task-client.ts";
import { FakeTaskApi } from "../../../../test-support/fake-task-api.ts";
import { COMPRESSION, geoTiffFixture } from "../../../../test-support/geotiff-fixture.ts";
import { writeStoredZip } from "../../../../test-support/stored-zip-writer.ts";
import { texturedGlb } from "../../../../test-support/textured-glb.ts";
import { browserPath } from "../../controls/browser-path.ts";
import { installAudits } from "../../controls/page-audits.ts";
import { THEME_KEY } from "../../preferences/theme.ts";
import { startBrowser } from "../../controls/browser-start.ts";
import { findBrowserPage } from "../../controls/browser-target.ts";

/** The four quarters of the fixture orthophoto, as test-support/geotiff-fixture.ts colours them. */
const QUARTERS = { topLeft: [220, 30, 30], topRight: [30, 160, 40], bottomLeft: [30, 60, 220], bottomRight: [230, 200, 20] };

test("Results opens a tile-less orthophoto on the map through range requests and a 3D model that fills its view, on the production routes", async () => {
  const folder = await mkdtemp(join(tmpdir(), "aidm-results-viewers-"));
  const publicFiles = join(folder, "public"), dataFolder = join(folder, "data");
  await mkdir(publicFiles); await mkdir(dataFolder);
  const build = await Bun.build({ entrypoints: [new URL("../../main.tsx", import.meta.url).pathname], target: "browser", plugins: [{ name: "viewer-assets", setup(builder) {
    builder.onResolve({ filter: /draco_(wasm_wrapper\.js|decoder\.wasm)\?url$/ }, args => ({ path: args.path, namespace: "decoder-assets" }));
    builder.onLoad({ filter: /.*/, namespace: "decoder-assets" }, args => ({ contents: `export default ${JSON.stringify(`/${args.path.includes("wrapper") ? "draco_wasm_wrapper.js" : "draco_decoder.wasm"}`)}`, loader: "js" }));
    builder.onResolve({ filter: /maplibre-gl-worker\.mjs\?url$/ }, () => ({ path: "worker-url", namespace: "map-worker" }));
    builder.onLoad({ filter: /.*/, namespace: "map-worker" }, () => ({ contents: 'export default "/map-worker.mjs"', loader: "js" }));
  } }] });
  expect(build.success).toBe(true);
  for (const output of build.outputs) await Bun.write(join(publicFiles, output.path.endsWith(".css") ? "fixture.css" : "fixture.js"), output);
  await copyFile("node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs", join(publicFiles, "map-worker.mjs"));
  await Bun.write(join(publicFiles, "index.html"), '<!doctype html><html lang="en"><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script></html>');

  // The production entry, with its styles, so the viewers are measured as they are laid out.
  // An archive as the engine leaves it when no tiles were asked for: the orthophoto as a tiled GeoTIFF with an overview, and the model.
  const orthophoto = geoTiffFixture({ width: 2048, height: 1536, tile: 256, compression: COMPRESSION.deflate });
  const archive = join(folder, "results.zip");
  writeStoredZip(archive, [
    { name: "odm_orthophoto/odm_orthophoto.tif", data: orthophoto },
    { name: "odm_texturing/odm_textured_model_geo.glb", data: texturedGlb() },
  ]);
  const engine = new FakeTaskApi(); await engine.start();
  const h: Harness = openHarness({ dataFolder, assets: await assetsFromFolder(publicFiles), runPollMs: 10 });
  h.settings.set("wizard.completed", true);
  const project = h.ctx.projects.create("Vineyard north", "");
  const engineId = h.engineStore.addRemote({ name: "Field engine", address: engine.address, token: engine.token }).id;
  const task = await new TaskClient({ address: engine.address, token: engine.token }).createTask("Field", []);
  if (!task.ok) throw new Error("fixture task creation");
  engine.setTask(task.value.uuid, { statusCode: 40, processingTime: 1000, output: ["Finished"], results: new Uint8Array(await Bun.file(archive).arrayBuffer()) });
  const run = h.runs.create({ projectId: project.id, engineId, options: [], name: "North block" });
  h.runs.update(run.id, { taskUuid: task.value.uuid, state: "queued" });
  h.tracker.follow(run.id);
  await eventually(async () => h.tracker.view(run.id)?.resultsAvailable === true);
  await engine.stop();

  let browser: Awaited<ReturnType<typeof startBrowser>> | undefined, socket: WebSocket | undefined;
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: Timer }>();
  const requests: Array<{ url: string; range: string | null }> = [];
  try {
    browser = await startBrowser(await browserPath(), join(folder, "profile"), "about:blank");
    socket = new WebSocket((await findBrowserPage(Number(browser.port))).webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => { socket!.onopen = () => resolve(); socket!.onerror = () => reject(new Error("browser connection")); });
    let next = 0;
    socket.onmessage = event => {
      const message = JSON.parse(String(event.data));
      if (message.method === "Network.requestWillBeSent") requests.push({ url: message.params.request.url, range: message.params.request.headers.Range ?? message.params.request.headers.range ?? null });
      const item = pending.get(message.id); if (!item) return;
      pending.delete(message.id); clearTimeout(item.timer);
      if (message.error) item.reject(new Error(JSON.stringify(message.error))); else item.resolve(message.result);
    };
    const send = (method: string, params: object = {}) => new Promise<any>((resolve, reject) => { const id = ++next; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timeout`)); }, 15000); pending.set(id, { resolve, reject, timer }); socket!.send(JSON.stringify({ id, method, params })); });
    const evaluate = async <T = any>(expression: string): Promise<T> => { const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails)); return result.result.value as T; };
    const wait = async (condition: string, ms = 10000) => {
      try { await evaluate(`new Promise((resolve, reject) => { const end = Date.now() + ${ms}; const tick = () => (${condition}) ? resolve(true) : Date.now() > end ? reject(Error("timeout")) : setTimeout(tick, 25); tick(); })`); }
      catch { throw new Error(`Waiting for ${condition} at ${await evaluate("location.hash")}: ${await evaluate("document.body.innerText")}`); }
    };
    const press = async (key: string, code: string, keyCode: number) => {
      await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: keyCode, ...(key === "Enter" ? { text: "\r" } : {}) });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode });
    };
    /** The pixels of a part of the page, as the screen shows it, read back in the page. */
    const pixelsOf = async (selector: string) => {
      const rect = await evaluate<{ x: number; y: number; width: number; height: number }>(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
      const shot = await send("Page.captureScreenshot", { format: "png", clip: { ...rect, scale: 1 } });
      return evaluate<{ width: number; height: number; colours: Record<string, { count: number; x: number; y: number }> }>(`(async () => {
        const image = new Image(); image.src = "data:image/png;base64,${shot.data}"; await image.decode();
        const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
        const context = canvas.getContext("2d"); context.drawImage(image, 0, 0);
        const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
        const quarters = ${JSON.stringify(QUARTERS)};
        const colours = Object.fromEntries(Object.keys(quarters).map(name => [name, { count: 0, x: 0, y: 0 }]));
        for (let i = 0; i < data.length; i += 4) for (const [name, [r, g, b]] of Object.entries(quarters)) {
          if (Math.abs(data[i] - r) < 12 && Math.abs(data[i + 1] - g) < 12 && Math.abs(data[i + 2] - b) < 12) { const c = colours[name]; c.count++; c.x += (i / 4) % canvas.width; c.y += Math.floor(i / 4 / canvas.width); }
        }
        for (const c of Object.values(colours)) if (c.count) { c.x /= c.count; c.y /= c.count; }
        return { width: canvas.width, height: canvas.height, colours };
      })()`);
    };

    await send("Network.enable");
    await send("Page.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: `${h.base}/#/projects/${project.id}/results` });

    // Results opens on the run, with both viewer tiles, their sizes, and the downloads with the archive first.
    await wait(`document.querySelector('main a.viewer-tile[href="#/projects/${project.id}/results/${run.id}/map"]') && document.querySelector('main a.viewer-tile[href="#/projects/${project.id}/results/${run.id}/model"]')`);
    expect(await evaluate("[...document.querySelectorAll('main .downloads li a')].map(a => a.textContent.trim())")).toEqual(["All results (archive)", "Orthophoto", "3D model (GLB)"]);
    expect(await evaluate("document.querySelector('main a.viewer-tile').textContent")).toContain("Orthophoto: ");
    // Without tiles the map tile keeps its neutral strip.
    expect(await evaluate("document.querySelector('main a.viewer-tile img')")).toBeNull();

    // The map opens from the keyboard and draws the orthophoto over the whole content area.
    await evaluate(`document.querySelector('main a.viewer-tile[href$="/map"]').focus(); true`);
    await press("Enter", "Enter", 13);
    await wait(`location.hash === "#/projects/${project.id}/results/${run.id}/map" && document.querySelector('.result-map-full[data-orthophoto="drawn"] .maplibregl-canvas')`);
    expect(await evaluate("document.querySelectorAll('main [role=toolbar]').length")).toBe(1);
    expect(await evaluate("document.querySelector('main h1').textContent")).toBe("Map of North block");
    const mapSize = await evaluate<{ width: number; height: number }>("(() => { const r = document.querySelector('.result-map-full').getBoundingClientRect(); return { width: r.width, height: r.height }; })()");
    expect(mapSize.height).toBeGreaterThan(600);
    let drawn = { width: 0, height: 0, colours: {} as Record<string, { count: number; x: number; y: number }> };
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      drawn = await pixelsOf(".result-map-full");
      if (Object.values(drawn.colours).every(colour => colour.count > 500)) break;
      await Bun.sleep(100);
    }
    const { topLeft, topRight, bottomLeft, bottomRight } = drawn.colours as Record<keyof typeof QUARTERS, { count: number; x: number; y: number }>;
    for (const quarter of [topLeft, topRight, bottomLeft, bottomRight]) expect(quarter.count).toBeGreaterThan(500);
    // North is up and east is right: the quarters sit where the raster has them.
    expect(topLeft.x).toBeLessThan(topRight.x); expect(bottomLeft.x).toBeLessThan(bottomRight.x);
    expect(topLeft.y).toBeLessThan(bottomLeft.y); expect(topRight.y).toBeLessThan(bottomRight.y);

    // Zooming in reads the part in view from the full image, again through range requests only.
    const before = requests.filter(request => request.url.includes("/outputs/orthophoto")).length;
    await evaluate("document.querySelector('.result-map-full .maplibregl-canvas').focus(); true");
    for (let step = 0; step < 3; step++) await press("+", "Equal", 187);
    await wait(`performance.getEntriesByType('resource').filter(entry => entry.name.includes('/outputs/orthophoto')).length > ${before}`);
    const orthophotoRequests = requests.filter(request => request.url.includes("/outputs/orthophoto"));
    expect(orthophotoRequests.length).toBeGreaterThan(before);
    expect(orthophotoRequests.every(request => request.range !== null && /^bytes=\d+-\d+$/.test(request.range))).toBe(true);
    // With no basemap set, nothing leaves the interface's origin while the map is open.
    expect(requests.filter(request => !request.url.startsWith(`${h.base}/`) && !request.url.startsWith("data:") && !request.url.startsWith("blob:"))).toEqual([]);

    // The toolbar leads back to the results, and the model opens framed to fill its view.
    await evaluate(`[...document.querySelectorAll('main [role=toolbar] a')].find(a => a.textContent.includes('Back to the results')).click(); true`);
    await wait(`location.hash === "#/projects/${project.id}/results/${run.id}" && document.querySelector('main a.viewer-tile[href$="/model"]')`);
    await evaluate(`document.querySelector('main a.viewer-tile[href$="/model"]').click(); true`);
    await wait(`document.querySelector('.model-viewer-canvas canvas') && !document.querySelector('.model-viewer [role=status]')`);
    const modelExtent = () => evaluate<{ width: number; height: number; left: number; right: number; top: number; bottom: number }>(`(async () => {
      const source = document.querySelector('.model-viewer-canvas canvas');
      const image = new Image(); image.src = source.toDataURL(); await image.decode();
      const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext("2d"); context.drawImage(image, 0, 0);
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let left = canvas.width, right = -1, top = canvas.height, bottom = -1;
      for (let i = 0; i < data.length; i += 4) {
        if (Math.abs(data[i] - 221) + Math.abs(data[i + 1] - 221) + Math.abs(data[i + 2] - 221) < 30) continue;
        const x = (i / 4) % canvas.width, y = Math.floor(i / 4 / canvas.width);
        left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
      }
      return { width: canvas.width, height: canvas.height, left, right, top, bottom };
    })()`);
    let extent = await modelExtent();
    const modelDeadline = Date.now() + 5000;
    // A resize clears the canvas until the next frame, so wait for a frame with the model and the background in it.
    while ((extent.right < 0 || (extent.left === 0 && extent.top === 0)) && Date.now() < modelDeadline) { await Bun.sleep(100); extent = await modelExtent(); }
    // The canvas takes the content area, and the model is large in it without being cut off.
    expect(extent.height).toBeGreaterThan(600);
    const shorter = Math.min(extent.width, extent.height);
    expect(extent.right - extent.left).toBeGreaterThan(shorter * 0.45);
    expect(extent.left).toBeGreaterThan(0); expect(extent.top).toBeGreaterThan(0);
    expect(extent.right).toBeLessThan(extent.width - 1); expect(extent.bottom).toBeLessThan(extent.height - 1);
    // Reset view returns to the same first view after the operator turns the model.
    const first = await evaluate<string>("document.querySelector('.model-viewer-canvas canvas').toDataURL()");
    await evaluate("document.querySelector('.model-viewer-canvas canvas').focus(); true");
    await press("ArrowLeft", "ArrowLeft", 37);
    await wait(`document.querySelector('.model-viewer-canvas canvas').toDataURL() !== ${JSON.stringify(first)}`);
    await evaluate("[...document.querySelectorAll('main [role=toolbar] button')].find(b => b.textContent.includes('Reset view')).click(); true");
    await wait(`document.querySelector('.model-viewer-canvas canvas').toDataURL() === ${JSON.stringify(first)}`);
    expect(requests.filter(request => !request.url.startsWith(`${h.base}/`) && !request.url.startsWith("data:") && !request.url.startsWith("blob:"))).toEqual([]);

    // In both themes the Results screen and the map's toolbar keep their text and controls readable, with no browser default look.
    for (const theme of ["light", "dark"] as const) {
      await evaluate(`localStorage.setItem(${JSON.stringify(THEME_KEY)}, ${JSON.stringify(theme)}); location.hash = "#/projects/${project.id}/results"; location.reload(); true`);
      await wait(`document.documentElement.dataset.theme === ${JSON.stringify(theme)} && document.querySelector('main a.viewer-tile') && document.querySelector('main .results-danger')`);
      await evaluate(`(${installAudits.toString()})(); true`);
      expect(await evaluate("[...audits.textContrast(document.querySelector('main')), ...audits.edgeContrast(document.querySelector('main')), ...audits.nativeLooks(document.querySelector('main'))]")).toEqual([]);
      await evaluate(`location.hash = "#/projects/${project.id}/results/${run.id}/map"; true`);
      await wait(`document.querySelector('.result-map-full[data-orthophoto="drawn"]')`);
      expect(await evaluate("[...audits.textContrast(document.querySelector('main [role=toolbar]')), ...audits.edgeContrast(document.querySelector('main [role=toolbar]')), ...audits.nativeLooks(document.querySelector('main [role=toolbar]'))]")).toEqual([]);
    }
  } finally {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("test finished")); }
    socket?.close(); await browser?.stop(); await h.stop(); await engine.stop(); await rm(folder, { recursive: true, force: true });
  }
}, 60000);
