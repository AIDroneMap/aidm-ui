import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetsFromFolder } from "../../../server/http/static-assets.ts";
import { eventually, openHarness } from "../../../server/testing/harness.ts";
import type { RunView } from "../../../shared/api-types.ts";
import type { RunReviewView } from "../../../shared/run-review.ts";
import { FAILURE_LINES } from "../../../shared/run-stages.ts";
import { FakeTaskApi } from "../../../test-support/fake-task-api.ts";
import { geoTiffFixture } from "../../../test-support/geotiff-fixture.ts";
import { texturedGlb } from "../../../test-support/textured-glb.ts";
import { writeStoredZip } from "../../../test-support/stored-zip-writer.ts";
import { browserPath } from "../controls/browser-path.ts";
import { startBrowser } from "../controls/browser-start.ts";
import { findBrowserPage } from "../controls/browser-target.ts";

test("the run screen follows a run from queued through its stages to its results, and a failed run to its failing lines", async () => {
  const folder = await mkdtemp(join(tmpdir(), "aidm-run-screen-"));
  const publicFiles = join(folder, "public"), dataFolder = join(folder, "data");
  await mkdir(publicFiles); await mkdir(dataFolder);
  const build = await Bun.build({ entrypoints: [new URL("../pages/run-browser-fixture.tsx", import.meta.url).pathname], target: "browser", plugins: [{ name: "worker-url", setup(builder) {
    builder.onResolve({ filter: /draco_(wasm_wrapper\.js|decoder\.wasm)\?url$/ }, args => ({ path: args.path, namespace: "decoder-assets" }));
    builder.onLoad({ filter: /.*/, namespace: "decoder-assets" }, args => ({ contents: `export default ${JSON.stringify(`/decoder/${args.path.includes("wrapper") ? "draco_wasm_wrapper.js" : "draco_decoder.wasm"}`)}`, loader: "js" }));
    builder.onResolve({ filter: /maplibre-gl-worker\.mjs\?url$/ }, () => ({ path: "worker-url", namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: 'export default "/map-worker.mjs"', loader: "js" }));
  } }] });
  expect(build.success).toBe(true);
  for (const output of build.outputs) await Bun.write(join(publicFiles, output.path.endsWith(".css") ? "fixture.css" : "fixture.js"), output);
  await Bun.write(join(publicFiles, "index.html"), '<!doctype html><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script>');
  const engine = new FakeTaskApi(); await engine.start();
  const h = openHarness({ dataFolder, assets: await assetsFromFolder(publicFiles), runPollMs: 10 });
  h.settings.set("wizard.completed", true);
  const project = h.ctx.projects.create("Field", "").id;
  const engineId = h.engineStore.addRemote({ name: "Barn engine", address: engine.address, token: engine.token }).id;
  const request = (method: string, path: string, body?: unknown) => fetch(h.base + path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  const bytes = Buffer.from("synthetic photo"), sha256 = createHash("sha256").update(bytes).digest("hex");
  const upload = await (await request("POST", `/api/projects/${project}/uploads`, { name: "photo.jpg", size: bytes.length, sha256 })).json() as { id: string };
  await fetch(h.base + `/api/projects/${project}/uploads/${upload.id}/chunks/0`, { method: "PUT", headers: { "x-chunk-sha256": sha256 }, body: bytes });
  await request("POST", `/api/projects/${project}/uploads/${upload.id}/complete`);
  const start = async (name: string) => {
    const review = await (await request("GET", `/api/projects/${project}/run-review?engineId=${engineId}&preset=quick-map`)).json() as RunReviewView;
    const run = await (await request("POST", `/api/projects/${project}/runs`, { engineId, preset: "quick-map", name, revision: review.revision })).json() as RunView;
    await eventually(async () => h.runs.get(run.id)?.state === "queued");
    return { id: run.id, uuid: h.runs.get(run.id)!.taskUuid! };
  };
  const archive = join(folder, "all.zip");
  writeStoredZip(archive, [
    { name: "odm_orthophoto/odm_orthophoto.tif", data: geoTiffFixture({}) },
    { name: "odm_texturing/odm_textured_model_geo.glb", data: texturedGlb() },
    { name: "odm_report/report.pdf", data: Buffer.from("report") },
  ]);

  let browser: Awaited<ReturnType<typeof startBrowser>> | undefined, socket: WebSocket | undefined;
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: Timer }>();
  try {
    browser = await startBrowser(await browserPath(), join(folder, "profile"), "about:blank");
    socket = new WebSocket((await findBrowserPage(Number(browser.port))).webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => { socket!.onopen = () => resolve(); socket!.onerror = () => reject(new Error("browser connection")); });
    let next = 0;
    socket.onmessage = event => { const m = JSON.parse(String(event.data)), item = pending.get(m.id); if (!item) return; pending.delete(m.id); clearTimeout(item.timer); m.error ? item.reject(new Error(JSON.stringify(m.error))) : item.resolve(m.result); };
    const send = (method: string, params: object = {}) => new Promise<any>((resolve, reject) => { const id = ++next; const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + " timeout")); }, 10000); pending.set(id, { resolve, reject, timer }); socket!.send(JSON.stringify({ id, method, params })); });
    const evaluate = async (expression: string) => { const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value; };
    const wait = async (condition: string) => {
      try { return await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+5000;const tick=()=>(${condition})?resolve(true):Date.now()>end?reject(Error('timed out')):setTimeout(tick,20);tick()})`); }
      catch (error) { throw new Error(`Waiting for ${condition}: ${await evaluate("document.querySelector('main')?.innerText ?? document.body.innerText")}`, { cause: error }); }
    };
    const stage = (name: string) => `[...document.querySelectorAll('.stage')].find(el=>el.querySelector('.stage-name')?.textContent===${JSON.stringify(name)})`;
    const press = async (key: " " | "Tab" | "Enter", shift = false) => {
      const code = key === " " ? "Space" : key, keyCode = key === " " ? 32 : key === "Tab" ? 9 : 13;
      await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: keyCode, modifiers: shift ? 8 : 0, ...(key === "Enter" ? { text: "\r" } : {}) });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode, modifiers: shift ? 8 : 0 });
    };
    const text = "document.querySelector('main').textContent";

    // Queued: every stage waits and the clock counts from the run's creation.
    const field = await start("Field run");
    await send("Page.navigate", { url: h.base + `/#/runs/${field.id}` });
    await wait(`document.querySelector('main h1')?.textContent==='Field run'`);
    await wait(`document.querySelector('.run-state')?.textContent==='Waiting for the engine to start'`);
    expect(await evaluate(`/Started \\d+ s ago/.test(document.querySelector('.run-elapsed').textContent)`)).toBe(true);
    expect(await evaluate(`document.querySelectorAll('.stage').length`)).toBe(11);
    expect(await evaluate(`document.querySelectorAll('.stage-waiting').length`)).toBe(11);
    expect(await evaluate(`${text}.includes('Running on "Barn engine"')`)).toBe(true);

    // Processing: the announced stages are done or running, with the engine's progress and its time.
    engine.setTask(field.uuid, { statusCode: 20, processingTime: 5000, progress: 30, output: ["[INFO]    Running dataset stage", "reading", "[INFO]    Running opensfm stage"] });
    await wait(`${stage("Match photos and locate cameras")}?.classList.contains('stage-running')`);
    await wait(`document.querySelector('.run-elapsed').textContent==='Processing for 5 s'`);
    expect(await evaluate(`${stage("Prepare photos")}.querySelector('.stage-state').textContent`)).toBe("Done");
    expect(await evaluate(`${stage("Prepare photos")}.querySelector('time')!==null`)).toBe(true);
    expect(await evaluate(`${stage("Match photos and locate cameras")}.textContent.includes('Processing: 30%')`)).toBe(true);
    expect(await evaluate(`${stage("Match photos and locate cameras")}.getAttribute('aria-current')`)).toBe("step");
    expect(await evaluate(`${stage("Build a dense model")}.querySelector('.stage-state').textContent`)).toBe("Waiting");
    engine.setTask(field.uuid, { processingTime: 7000 });
    await wait(`document.querySelector('.run-elapsed').textContent==='Processing for 7 s'`);

    // Completed: the Results section's viewer tiles and downloads come first, and every stage the engine never announced is skipped.
    engine.setTask(field.uuid, { output: ["[INFO]    Running dataset stage", "reading", "[INFO]    Running opensfm stage", "[INFO]    Running odm_report stage"], results: new Uint8Array(await readFile(archive)) });
    await wait(`${stage("Write the processing report")}?.classList.contains('stage-running')`);
    engine.setTask(field.uuid, { statusCode: 40, processingTime: 9000, progress: 100 });
    await wait(`document.querySelector('a[href="/api/runs/${field.id}/outputs/report"]')`);
    expect(await evaluate(`document.querySelector('.run-results').compareDocumentPosition(document.querySelector('.run-stages')) & Node.DOCUMENT_POSITION_FOLLOWING`)).toBeTruthy();
    const mapTile = `#/projects/${project}/results/${field.id}/map`, modelTile = `#/projects/${project}/results/${field.id}/model`;
    expect(await evaluate(`[...document.querySelectorAll('.run-results a.viewer-tile')].map(el=>el.getAttribute('href'))`)).toEqual([mapTile, modelTile]);
    expect(await evaluate(`[...document.querySelectorAll('.run-results .downloads a')].map(el=>el.getAttribute('href'))`)).toEqual([`/api/runs/${field.id}/results`, `/api/runs/${field.id}/outputs/orthophoto`, `/api/runs/${field.id}/outputs/glb`, `/api/runs/${field.id}/outputs/report`]);
    expect(await evaluate(`document.querySelector('.run-results .viewer-tiles').compareDocumentPosition(document.querySelector('.run-stages')) & Node.DOCUMENT_POSITION_FOLLOWING`)).toBeTruthy();
    expect(await evaluate(`[...document.querySelectorAll('.run-results button')].map(el=>el.textContent)`)).toContain("Delete the results of this run");
    expect(await evaluate(`document.querySelector('.run-state').textContent`)).toBe("Finished");
    expect(await evaluate(`document.querySelector('.run-elapsed').textContent`)).toBe("Processed in 9 s");
    expect(await evaluate(`${stage("Build a dense model")}.querySelector('.stage-state').textContent`)).toBe("Skipped");
    expect(await evaluate(`${stage("Write the processing report")}.querySelector('.stage-state').textContent`)).toBe("Done");
    expect(await evaluate(`[...document.querySelectorAll('button')].some(el=>el.textContent==='Cancel the run')`)).toBe(false);

    // From the keyboard, each viewer tile opens its route, and going back returns to the run screen.
    for (const [href, heading] of [[mapTile, "Map of Field run"], [modelTile, "3D model of Field run"]]) {
      await evaluate(`document.querySelector('.run-results a.viewer-tile[href="${href}"]').focus();true`);
      await press("Enter");
      await wait(`location.hash===${JSON.stringify(href)}&&document.querySelector('main h1')?.textContent===${JSON.stringify(heading)}`);
      await evaluate("history.back();true");
      await wait(`location.hash==='#/runs/${field.id}'&&document.querySelector('main h1')?.textContent==='Field run'&&document.querySelector('.run-results a.viewer-tile')`);
    }

    // Failed: the failing stage, the engine's message and the last lines with the first error, the log folded.
    const broken = await start("Broken run");
    const lines = ["[INFO]    Running dataset stage", ...Array.from({ length: 60 }, (_, index) => `[INFO]    reading photo ${index}`), "[INFO]    Running opensfm stage", "[INFO]    matching", "[ERROR]   Not enough memory to match the photos", "Traceback (most recent call last):", "[INFO]    stopping"];
    engine.setTask(broken.uuid, { statusCode: 20, processingTime: 3000, output: lines });
    await eventually(async () => h.tracker.log(broken.id, 0).next === lines.length);
    engine.setTask(broken.uuid, { statusCode: 30, errorMessage: "Process exited with code 1" });
    await eventually(async () => h.runs.get(broken.id)?.state === "failed");
    await evaluate(`location.hash='#/runs/${broken.id}';true`);
    await wait(`document.querySelector('#run-failure-title')?.textContent==='The run failed at this stage: Match photos and locate cameras'`);
    expect(await evaluate(`document.querySelector('.run-failure .notice').textContent.includes('The engine said: Process exited with code 1')`)).toBe(true);
    await wait(`document.querySelectorAll('.run-failure-lines .run-log-line').length===${FAILURE_LINES}`);
    expect(await evaluate(`document.querySelector('.run-failure-lines mark').textContent`)).toBe("First error:[ERROR]   Not enough memory to match the photos");
    expect(await evaluate(`document.querySelectorAll('.run-failure-lines mark').length`)).toBe(1);
    expect(await evaluate(`document.querySelector('.run-failure-lines .run-log-line:last-child').textContent`)).toBe("[INFO]    stopping");
    expect(await evaluate(`${stage("Match photos and locate cameras")}.querySelector('.stage-state').textContent`)).toBe("Failed");
    expect(await evaluate(`document.querySelector('.run-failure').compareDocumentPosition(document.querySelector('.run-stages')) & Node.DOCUMENT_POSITION_FOLLOWING`)).toBeTruthy();
    expect(await evaluate(`[...document.querySelectorAll('.run-failure button')].map(el=>el.textContent)`)).toEqual(expect.arrayContaining(["Retry", "Run again with other settings", "Show the whole log"]));
    expect(await evaluate(`document.querySelector('#run-log').open`)).toBe(false);
    expect(await evaluate(`document.querySelector('#run-log summary').textContent`)).toBe(`Engine log (${lines.length} lines)`);
    expect(await evaluate(`document.querySelector('#run-log pre')`)).toBeNull();

    // From the keyboard, "Show the whole log" opens the log and puts the focus in it.
    await evaluate(`[...document.querySelectorAll('button')].find(el=>el.textContent==='Show the whole log').focus();true`);
    await press(" ");
    await wait(`document.activeElement?.matches('#run-log pre.run-log')`);
    expect(await evaluate(`document.activeElement.getAttribute('aria-label')`)).toBe("Engine log");
    expect(await evaluate(`document.activeElement.textContent.split('\\n').length`)).toBe(lines.length);
    expect(await evaluate(`[...document.querySelectorAll('#run-log button')].map(el=>el.textContent)`)).toEqual(["Copy", "Save as file"]);
    await press("Tab", true);
    expect(await evaluate(`document.activeElement.textContent`)).toBe("Save as file");
    await press("Tab", true); await press(" ");
    await wait(`document.querySelector('#run-log [role=status]').textContent!==''`);
    expect(await evaluate(`document.querySelector('#run-log [role=status]').textContent`)).toBe("The whole log is on the clipboard.");

    // The error line is drawn in the danger tokens of both themes.
    for (const theme of ["light", "dark"]) {
      await evaluate(`document.documentElement.dataset.theme='${theme}';true`);
      expect(await evaluate(`(()=>{const probe=document.createElement('span');probe.style.color='var(--danger)';probe.style.backgroundColor='var(--danger-soft)';document.body.append(probe);const want=getComputedStyle(probe);const mark=getComputedStyle(document.querySelector('.run-failure-lines mark'));const same=mark.color===want.color&&mark.backgroundColor===want.backgroundColor;probe.remove();return same})()`), theme).toBe(true);
    }
  } finally {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("test finished")); }
    socket?.close(); await browser?.stop(); await h.stop(); await engine.stop(); await rm(folder, { recursive: true, force: true });
  }
}, 60000);
