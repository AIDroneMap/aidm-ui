import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { openHarness, eventually } from "../../../../server/testing/harness.ts";
import { assetsFromFolder } from "../../../../server/http/static-assets.ts";
import { FakeTaskApi } from "../../../../test-support/fake-task-api.ts";
import { FakeFileServer } from "../../../../test-support/fake-file-server.ts";
import { writeStoredZip } from "../../../../test-support/stored-zip-writer.ts";
import { SAMPLE_DATASET, type SampleDatasetEntry } from "../../../../server/sample/sample-dataset.ts";
import { browserPath } from "../../controls/browser-path.ts";
import { startBrowser } from "../../controls/browser-start.ts";
import { findBrowserPage } from "../../controls/browser-target.ts";

// Minimal valid empty zip: 22 bytes, end-of-central-directory record only
const EMPTY_ZIP = new Uint8Array([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

async function buildFixture(publicFiles: string) {
  const build = await Bun.build({
    entrypoints: [new URL("../../main.tsx", import.meta.url).pathname],
    target: "browser",
    plugins: [{
      name: "worker-url",
      setup(builder) {
        builder.onResolve({ filter: /draco_(wasm_wrapper\.js|decoder\.wasm)\?url$/ }, args => ({ path: args.path, namespace: "decoder-assets" }));
        builder.onLoad({ filter: /.*/, namespace: "decoder-assets" }, args => ({ contents: `export default ${JSON.stringify(`/decoder/${args.path.includes("wrapper") ? "draco_wasm_wrapper.js" : "draco_decoder.wasm"}`)}`, loader: "js" }));
        builder.onResolve({ filter: /maplibre-gl-worker\.mjs\?url$/ }, () => ({ path: "worker-url", namespace: "fixture" }));
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: 'export default "/map-worker.mjs"', loader: "js" }));
      },
    }],
  });
  expect(build.success).toBe(true);
  for (const output of build.outputs) await Bun.write(join(publicFiles, output.path.endsWith(".css") ? "fixture.css" : "fixture.js"), output);
  await Bun.write(join(publicFiles, "index.html"), '<!doctype html><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script>');
  return await assetsFromFolder(publicFiles);
}

async function seedPhoto(h: ReturnType<typeof openHarness>, projectId: number) {
  const bytes = Buffer.from("synthetic photo");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const base = h.base;
  const up = await (await fetch(`${base}/api/projects/${projectId}/uploads`, { method: "POST", body: JSON.stringify({ name: "photo.jpg", size: bytes.length, sha256 }) })).json() as { id: string };
  await fetch(`${base}/api/projects/${projectId}/uploads/${up.id}/chunks/0`, { method: "PUT", headers: { "x-chunk-sha256": sha256 }, body: bytes });
  await fetch(`${base}/api/projects/${projectId}/uploads/${up.id}/complete`, { method: "POST" });
}

test("runs table shows all columns, newest first, with reported progress and duration", async () => {
  const folder = await mkdtemp(join(tmpdir(), "aidm-runs-table-"));
  const publicFiles = join(folder, "public"), dataFolder = join(folder, "data");
  await mkdir(publicFiles); await mkdir(dataFolder);
  const assets = await buildFixture(publicFiles);

  const engine = new FakeTaskApi(); await engine.start();
  const h = openHarness({ dataFolder, assets, runPollMs: 10 });
  h.settings.set("wizard.completed", true);
  const projectId = h.ctx.projects.create("Farm survey", "").id;
  const engineId = h.engineStore.addRemote({ name: "Atlas GPU", address: engine.address, token: engine.token }).id;
  await seedPhoto(h, projectId);

  const post = (path: string, body: unknown) => fetch(h.base + path, { method: "POST", body: JSON.stringify(body) });
  const runBody = { engineId, preset: "custom", presetName: "Orchard survey", options: [] };

  // Oldest run: completed with archive
  const rev1 = await (await post(`/api/projects/${projectId}/run-review`, runBody)).json() as any;
  const run1 = await (await post(`/api/projects/${projectId}/runs`, { ...runBody, name: "Flight 1", revision: rev1.revision })).json() as any;
  await eventually(async () => h.runs.get(run1.id)?.state === "queued");
  engine.setTask(h.runs.get(run1.id)!.taskUuid!, { statusCode: 40, processingTime: 65000, results: EMPTY_ZIP });
  await eventually(async () => h.runs.get(run1.id)?.state === "completed");

  // Middle run: failed
  const rev2 = await (await post(`/api/projects/${projectId}/run-review`, runBody)).json() as any;
  const run2 = await (await post(`/api/projects/${projectId}/runs`, { ...runBody, name: "Flight 2", revision: rev2.revision })).json() as any;
  await eventually(async () => h.runs.get(run2.id)?.state === "queued");
  engine.setTask(h.runs.get(run2.id)!.taskUuid!, { statusCode: 30 });
  await eventually(async () => h.runs.get(run2.id)?.state === "failed");

  // Newest run: processing with progress=25.
  // statusCode 20 only maps to "processing" when processingTime >= 0.
  // onCommit fires asynchronously after the POST returns, so keep it set until confirmed.
  engine.onCommit = (task) => { task.statusCode = 20; task.progress = 25; task.processingTime = 1000; };
  const rev3 = await (await post(`/api/projects/${projectId}/run-review`, runBody)).json() as any;
  const run3 = await (await post(`/api/projects/${projectId}/runs`, { ...runBody, name: "Flight 3", revision: rev3.revision })).json() as any;
  await eventually(async () => h.runs.get(run3.id)?.state === "processing");
  engine.onCommit = undefined;

  let browser: Awaited<ReturnType<typeof startBrowser>> | undefined;
  let socket: WebSocket | undefined;
  const pending = new Map<number, { resolve(v: any): void; reject(e: Error): void; timer: Timer }>();
  try {
    browser = await startBrowser(await browserPath(), join(folder, "profile"), "about:blank");
    socket = new WebSocket((await findBrowserPage(Number(browser.port))).webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => { socket!.onopen = () => resolve(); socket!.onerror = () => reject(new Error("browser connection")); });
    let next = 0;
    socket.onmessage = event => {
      const m = JSON.parse(String(event.data)), item = pending.get(m.id);
      if (!item) return;
      pending.delete(m.id); clearTimeout(item.timer);
      m.error ? item.reject(new Error(JSON.stringify(m.error))) : item.resolve(m.result);
    };
    const send = (method: string, params: object = {}) => new Promise<any>((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + " timeout")); }, 10000);
      pending.set(id, { resolve, reject, timer });
      socket!.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expr: string) => {
      const result = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const wait = (condition: string) =>
      evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+8000;const tick=()=>(${condition})?resolve(true):Date.now()>end?reject(Error(${JSON.stringify("timeout: " + condition)})):setTimeout(tick,20);tick()})`);

    await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: h.base + `/#/projects/${projectId}/runs` });

    // Table is rendered and heading id preserved (wait for data to load)
    await wait(`document.querySelector('a[href="#/runs/${run3.id}"]') !== null`);
    expect(await evaluate("document.querySelectorAll('#run-history-title').length")).toBe(1);

    // Column headings
    for (const heading of ["Run", "Preset", "Engine", "State", "Started", "Duration", "Results", "Actions"]) {
      expect(await evaluate(`document.querySelector('main table caption, main table th, main table td')?.closest('table')?.textContent?.includes(${JSON.stringify(heading)})`)).toBe(true);
    }

    // Newest (Flight 3) is first in the table
    const order = await evaluate(`[...document.querySelectorAll('main table tbody tr td:first-child a, main table tbody tr a')].map(a=>a.textContent)`);
    const flight3idx = (order as string[]).findIndex(n => n.includes("Flight 3"));
    const flight1idx = (order as string[]).findIndex(n => n.includes("Flight 1"));
    expect(flight3idx).toBeLessThan(flight1idx);

    // Open links go to #/runs/:id
    expect(await evaluate(`document.querySelector('a[href="#/runs/${run3.id}"]') !== null`)).toBe(true);
    expect(await evaluate(`document.querySelector('a[href="#/runs/${run1.id}"]') !== null`)).toBe(true);

    // Use engine-reported durations and leave an unreported duration as a dash.
    const durations = await evaluate(`[...document.querySelectorAll('main table tbody tr')].map(tr=>[...tr.querySelectorAll('td')][5]?.textContent?.trim())`);
    expect(durations).toEqual(["1 s", "-", "1 min 5 s"]);

    // Archive size for Flight 1 (22 bytes = "22 B")
    expect(await evaluate(`document.querySelector('main').textContent.includes('22 B')`)).toBe(true);

    // Flight 2 (failed) size is dash
    const rows = await evaluate(`[...document.querySelectorAll('main table tbody tr')].map(tr=>({name:[...tr.querySelectorAll('td')][0]?.querySelector('a')?.textContent,size:[...tr.querySelectorAll('td')][6]?.textContent?.trim()}))`);
    const flight2row = (rows as any[]).find(r => r.name?.includes("Flight 2"));
    expect(flight2row?.size).toBe("-");

    // Flight 3 (processing) has a progress bar with value=25
    await wait(`document.querySelector('main table tbody tr:first-child progress[value="25"]') !== null`);
    expect(await evaluate(`document.querySelector('main table tbody tr:first-child progress') !== null`)).toBe(true);
    expect(await evaluate(`document.querySelector('main table tbody tr:first-child progress')?.value`)).toBe(25);
    expect(await evaluate(`document.querySelector('main table tbody tr:first-child progress')?.max`)).toBe(100);

    expect(await evaluate("document.querySelector('main table tbody tr')?.textContent")).toContain("Orchard survey");
    expect(await evaluate("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
    expect(await evaluate("document.querySelector('main progress')?.getBoundingClientRect().height")).toBeLessThanOrEqual(6);

    // Engine name appears
    expect(await evaluate(`document.querySelector('main').textContent.includes('Atlas GPU')`)).toBe(true);

    // State pills: processing run shows processing label, failed shows Failed
    expect(await evaluate(`document.querySelector('main').textContent.includes('The engine is processing the images') || document.querySelector('main .status-pill')?.textContent?.includes('processing')`)).toBe(true);
    expect(await evaluate(`document.querySelector('main').textContent.includes('Failed')`)).toBe(true);

    // Opening a row reaches the production run route.
    await evaluate(`document.querySelector('a[href="#/runs/${run1.id}"]').click();true`);
    await wait(`location.hash === '#/runs/${run1.id}' && document.querySelector('main h1')?.textContent === 'Flight 1'`);
    await send("Page.navigate", { url: h.base + `/#/projects/${projectId}/runs` });
    await wait("document.querySelector('main table')");

    // Test dark theme via CDP Emulation
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
    await evaluate("new Promise(resolve => requestAnimationFrame(() => resolve(true)))");
    expect(await evaluate("document.querySelector('main table') !== null")).toBe(true);
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });

  } finally {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error("test ended")); }
    socket?.close(); await browser?.stop(); await h.stop(); await engine.stop();
    await rm(folder, { recursive: true, force: true });
  }
}, 90000);

test("runs table empty states link to the right section", async () => {
  const folder = await mkdtemp(join(tmpdir(), "aidm-runs-empty-"));
  const publicFiles = join(folder, "public"), dataFolder = join(folder, "data");
  await mkdir(publicFiles); await mkdir(dataFolder);
  const assets = await buildFixture(publicFiles);

  const engine = new FakeTaskApi(); await engine.start();
  const h = openHarness({ dataFolder, assets, runPollMs: 10 });
  h.settings.set("wizard.completed", true);

  // Project with photos but no runs
  const withPhotos = h.ctx.projects.create("With photos", "").id;
  h.engineStore.addRemote({ name: "Edge node", address: engine.address, token: engine.token });
  await seedPhoto(h, withPhotos);

  // Project with zero photos (link way-in project has null photoCount; no-photos project has 0)
  const noPhotos = h.ctx.projects.create("No photos", "").id;

  let browser: Awaited<ReturnType<typeof startBrowser>> | undefined;
  let socket: WebSocket | undefined;
  const pending = new Map<number, { resolve(v: any): void; reject(e: Error): void; timer: Timer }>();
  try {
    browser = await startBrowser(await browserPath(), join(folder, "profile"), "about:blank");
    socket = new WebSocket((await findBrowserPage(Number(browser.port))).webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => { socket!.onopen = () => resolve(); socket!.onerror = () => reject(new Error("browser connection")); });
    let next = 0;
    socket.onmessage = event => {
      const m = JSON.parse(String(event.data)), item = pending.get(m.id);
      if (!item) return;
      pending.delete(m.id); clearTimeout(item.timer);
      m.error ? item.reject(new Error(JSON.stringify(m.error))) : item.resolve(m.result);
    };
    const send = (method: string, params: object = {}) => new Promise<any>((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + " timeout")); }, 10000);
      pending.set(id, { resolve, reject, timer });
      socket!.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expr: string) => {
      const result = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const wait = (condition: string) =>
      evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+8000;const tick=()=>(${condition})?resolve(true):Date.now()>end?reject(Error(${JSON.stringify("timeout: " + condition)})):setTimeout(tick,20);tick()})`);

    // With photos: empty state points to Settings
    await send("Page.navigate", { url: h.base + `/#/projects/${withPhotos}/runs` });
    await wait("document.querySelectorAll('#run-history-title').length===1");
    await wait(`document.querySelector('main .empty-state a[href="#/projects/${withPhotos}/settings"]') !== null`);
    expect(await evaluate(`document.querySelector('main .empty-state a[href="#/projects/${withPhotos}/settings"]') !== null`)).toBe(true);

    expect(await evaluate("document.querySelector('main .empty-state h2')?.textContent")).toBe("No runs yet");

    // No photos: empty state points to Photos
    await send("Page.navigate", { url: h.base + `/#/projects/${noPhotos}/runs` });
    await wait("document.querySelectorAll('#run-history-title').length===1");
    await wait(`document.querySelector('main .empty-state a[href="#/projects/${noPhotos}/photos"]') !== null`);
    expect(await evaluate(`document.querySelector('main .empty-state a[href="#/projects/${noPhotos}/photos"]') !== null`)).toBe(true);

  } finally {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error("test ended")); }
    socket?.close(); await browser?.stop(); await h.stop(); await engine.stop();
    await rm(folder, { recursive: true, force: true });
  }
}, 90000);

test("runs table actions: popover keyboard, delete confirmation, retry redirect and Run again editor", async () => {
  const folder = await mkdtemp(join(tmpdir(), "aidm-runs-actions-"));
  const publicFiles = join(folder, "public"), dataFolder = join(folder, "data");
  await mkdir(publicFiles); await mkdir(dataFolder);
  const assets = await buildFixture(publicFiles);

  const engine = new FakeTaskApi(); await engine.start();
  const h = openHarness({ dataFolder, assets, runPollMs: 10 });
  h.settings.set("wizard.completed", true);
  const projectId = h.ctx.projects.create("Actions test", "").id;
  const engineId = h.engineStore.addRemote({ name: "Work node", address: engine.address, token: engine.token }).id;
  await seedPhoto(h, projectId);

  const post = (path: string, body: unknown) => fetch(h.base + path, { method: "POST", body: JSON.stringify(body) });
  const runBody = { engineId, preset: "quick-map", options: [] };

  // Completed run for Run again test
  const rev1 = await (await post(`/api/projects/${projectId}/run-review`, runBody)).json() as any;
  const runComp = await (await post(`/api/projects/${projectId}/runs`, { ...runBody, name: "Done run", revision: rev1.revision })).json() as any;
  await eventually(async () => h.runs.get(runComp.id)?.state === "queued");
  engine.setTask(h.runs.get(runComp.id)!.taskUuid!, { statusCode: 40, results: EMPTY_ZIP });
  await eventually(async () => h.runs.get(runComp.id)?.state === "completed");

  // Failed run for retry and delete tests
  const rev2 = await (await post(`/api/projects/${projectId}/run-review`, runBody)).json() as any;
  const runFailed = await (await post(`/api/projects/${projectId}/runs`, { ...runBody, name: "Bad run", revision: rev2.revision })).json() as any;
  await eventually(async () => h.runs.get(runFailed.id)?.state === "queued");
  engine.setTask(h.runs.get(runFailed.id)!.taskUuid!, { statusCode: 30 });
  await eventually(async () => h.runs.get(runFailed.id)?.state === "failed");

  let browser: Awaited<ReturnType<typeof startBrowser>> | undefined;
  let socket: WebSocket | undefined;
  const pending = new Map<number, { resolve(v: any): void; reject(e: Error): void; timer: Timer }>();
  try {
    browser = await startBrowser(await browserPath(), join(folder, "profile"), "about:blank");
    socket = new WebSocket((await findBrowserPage(Number(browser.port))).webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => { socket!.onopen = () => resolve(); socket!.onerror = () => reject(new Error("browser connection")); });
    let next = 0;
    socket.onmessage = event => {
      const m = JSON.parse(String(event.data)), item = pending.get(m.id);
      if (!item) return;
      pending.delete(m.id); clearTimeout(item.timer);
      m.error ? item.reject(new Error(JSON.stringify(m.error))) : item.resolve(m.result);
    };
    const send = (method: string, params: object = {}) => new Promise<any>((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + " timeout")); }, 10000);
      pending.set(id, { resolve, reject, timer });
      socket!.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expr: string) => {
      const result = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const wait = (condition: string) =>
      evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+8000;const tick=()=>(${condition})?resolve(true):Date.now()>end?reject(Error(${JSON.stringify("timeout: " + condition)})):setTimeout(tick,20);tick()})`);
    const btn = (label: string) => `[...document.querySelectorAll('dialog[open] button, [popover]:popover-open button, main .settings-editor button')].find(el=>el.textContent===${JSON.stringify(label)})`;
    const click = (label: string) => clickExpr(btn(label));
    // clickExpr polls until the expression resolves to a non-null element and clicks it atomically.
    const clickExpr = (expr: string) =>
      evaluate(`new Promise((res,rej)=>{const end=Date.now()+8000;const t=()=>{const b=${expr};if(b&&!b.disabled){b.click();res(true);}else if(Date.now()>end)rej(new Error('clickExpr timeout'));else setTimeout(t,20);};t()})`);
    const activate = async (label: string) => {
      await wait(`${btn(label)}&&!${btn(label)}.disabled`);
      await evaluate(`${btn(label)}.focus();true`);
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
    };

    await send("Page.navigate", { url: h.base + `/#/projects/${projectId}/runs` });
    await wait(`document.querySelector('a[href="#/runs/${runFailed.id}"]') !== null`);

    // Completed run does NOT get Retry (only failed runs do).
    // Open Done run's popover first, before Bad run's popover is ever opened.
    const doneRunMoreBtn = `[...document.querySelectorAll('button')].find(el=>el.textContent?.includes('More actions for Done run'))`;
    // clickExpr opens the done run popover atomically (avoids race with 2s poll re-render)
    await clickExpr(doneRunMoreBtn);
    await wait(`[...document.querySelectorAll('[popover]:popover-open button')].length > 0`);
    const retryInDonePopover = await evaluate(`[...document.querySelectorAll('[popover]:popover-open button')].some(el=>el.textContent==='Retry')`);
    expect(retryInDonePopover).toBe(false);
    // "Run again" IS in the completed run's popover
    const againInDonePopover = await evaluate(`[...document.querySelectorAll('[popover]:popover-open button')].some(el=>el.textContent==='Run again with other settings')`);
    expect(againInDonePopover).toBe(true);
    // Close popover
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await wait(`[...document.querySelectorAll('[popover]:popover-open')].length === 0`);

    // Popover opens via keyboard (Space on the trigger button) and Escape closes it
    const badRunMoreBtn = `[...document.querySelectorAll('button')].find(el=>el.textContent?.includes('More actions for Bad run'))`;
    await wait(`${badRunMoreBtn} !== null`);
    await evaluate(`${badRunMoreBtn}.focus();true`);
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
    // Retry is visible in the popover (failed run)
    await wait(`[...document.querySelectorAll('[popover]:popover-open button')].some(el=>el.textContent==='Retry')`);
    expect(await evaluate(`[...document.querySelectorAll('[popover]:popover-open button')].some(el=>el.textContent==='Retry')`)).toBe(true);
    // Escape closes the popover
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await wait(`[...document.querySelectorAll('[popover]:popover-open')].length === 0`);

    // Delete: Keep focus keeps dialog closed
    await clickExpr(badRunMoreBtn);
    await wait(`${btn("Delete run")} !== null`);
    await click("Delete run");
    await wait("document.querySelector('dialog[open]')");
    expect(await evaluate("document.activeElement?.textContent")).toBe("Keep run");
    const deletionText = await evaluate("document.querySelector('dialog[open]')?.textContent");
    expect(deletionText).toContain('Delete run "Bad run"?');
    expect(deletionText).toContain("Local result archive: 0 B");
    expect(deletionText).toContain("This run's settings and log");
    expect(deletionText).toContain("This run on Work node");
    expect(deletionText).toContain("The project, its photos and imported folders stay.");
    await activate("Keep run");
    await evaluate("new Promise(resolve => requestAnimationFrame(() => resolve(true)))");
    expect(await evaluate("document.querySelector('dialog[open]')")).toBeNull();
    // Keeping the run leaves its row available.
    expect(await evaluate(`document.querySelector('a[href="#/runs/${runFailed.id}"]') !== null`)).toBe(true);

    // A rejected delete is visible and leaves the run available.
    const originalToken = engine.token;
    engine.token = "changed-test-token";
    await clickExpr(badRunMoreBtn);
    await click("Delete run");
    await wait("document.querySelector('dialog[open]')");
    await click("Delete run and 0 B");
    await wait("document.querySelector('main [role=alert]')?.textContent.includes('The run could not be deleted')");
    expect(await evaluate(`document.querySelector('a[href="#/runs/${runFailed.id}"]') !== null`)).toBe(true);
    expect(await evaluate("document.querySelector('dialog[open]')")).toBeNull();
    engine.token = originalToken;

    // Delete: confirm sends DELETE and removes run from list
    await clickExpr(badRunMoreBtn);
    await wait(`${btn("Delete run")} !== null`);
    await click("Delete run");
    await wait("document.querySelector('dialog[open]')");
    await click("Delete run and 0 B");
    await wait(`document.querySelector('a[href="#/runs/${runFailed.id}"]') === null && document.querySelector('a[href="#/runs/${runComp.id}"]') !== null && !document.querySelector('dialog[open]')`);
    expect(await evaluate(`document.querySelector('a[href="#/runs/${runFailed.id}"]')`)).toBeNull();

    // Retry: POST to /api/runs/:id/retry then navigate to new run page
    // Re-create a failed run for retry
    const rev3 = await (await post(`/api/projects/${projectId}/run-review`, runBody)).json() as any;
    const runFailed2 = await (await post(`/api/projects/${projectId}/runs`, { ...runBody, name: "Retry me", revision: rev3.revision })).json() as any;
    await eventually(async () => h.runs.get(runFailed2.id)?.state === "queued");
    engine.setTask(h.runs.get(runFailed2.id)!.taskUuid!, { statusCode: 30 });
    await eventually(async () => h.runs.get(runFailed2.id)?.state === "failed");
    await evaluate("new Promise(resolve => requestAnimationFrame(() => resolve(true)))");
    await wait(`document.querySelector('a[href="#/runs/${runFailed2.id}"]') !== null`);
    const retryMoreBtn = `[...document.querySelectorAll('button')].find(el=>el.textContent?.includes('More actions for Retry me'))`;
    await clickExpr(retryMoreBtn);
    await wait(`${btn("Retry")} !== null`);
    h.engineStore.update(engineId, { enabled: false });
    await click("Retry");
    await wait("document.querySelector('main [role=alert]')?.textContent.includes('Choose an enabled engine')");
    h.engineStore.update(engineId, { enabled: true });
    await clickExpr(retryMoreBtn);
    // Set up next run so retry redirect has somewhere to land (queued state is fine)
    engine.setTask(h.runs.get(runFailed2.id)!.taskUuid!, { statusCode: 10, progress: 0 });
    await click("Retry");
    // After retry, navigated away from the failed run
    await wait(`location.hash === '#/runs/${runFailed2.id + 1}'`);
    expect(await evaluate(`location.hash`)).toBe(`#/runs/${runFailed2.id + 1}`);

    // Run again opens settings editor in-section
    const doneMoreBtn = `[...document.querySelectorAll('button')].find(el=>el.textContent?.includes('More actions for Done run'))`;
    await send("Page.navigate", { url: h.base + `/#/projects/${projectId}/runs` });
    await clickExpr(doneMoreBtn);
    await wait(`${btn("Run again with other settings")} !== null`);
    await click("Run again with other settings");
    await wait("document.querySelector('.settings-editor')");
    expect(await evaluate("document.querySelector('.settings-editor') !== null")).toBe(true);
    await click("Cancel");
    await evaluate("new Promise(resolve => requestAnimationFrame(() => resolve(true)))");
    await wait("!document.querySelector('.settings-editor')");
    await clickExpr(doneMoreBtn);
    await click("Run again with other settings");
    await wait("document.querySelector('.settings-editor')");
    expect(await evaluate("document.querySelector('.settings-editor') !== null")).toBe(true);

  } finally {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error("test ended")); }
    socket?.close(); await browser?.stop(); await h.stop(); await engine.stop();
    await rm(folder, { recursive: true, force: true });
  }
}, 120000);

test("the sample project starts from its Runs empty state with the wizard's request in both themes", async () => {
  const folder = await mkdtemp(join(tmpdir(), "aidm-sample-project-"));
  const publicFiles = join(folder, "public");
  await mkdir(publicFiles);
  const assets = await buildFixture(publicFiles);
  const zipPath = join(folder, "dataset.zip");
  writeStoredZip(zipPath, [
    { name: "DJI_0001.JPG", data: new TextEncoder().encode("synthetic image 1") },
    { name: "DJI_0002.JPG", data: new TextEncoder().encode("synthetic image 2") },
    { name: "DJI_0003.JPG", data: new TextEncoder().encode("synthetic image 3") },
  ]);
  const zipBytes = new Uint8Array(readFileSync(zipPath));
  const files = new FakeFileServer({ "/dataset.zip": zipBytes });
  await files.start();
  const dataset: SampleDatasetEntry = {
    ...SAMPLE_DATASET, imageCount: 3, url: files.url("/dataset.zip"), size: zipBytes.length,
    sha256: new Bun.CryptoHasher("sha256").update(zipBytes).digest("hex"), fileName: "test-dataset.zip",
  };
  const engine = new FakeTaskApi(); await engine.start();
  let h: ReturnType<typeof openHarness> | undefined;
  let browser: Awaited<ReturnType<typeof startBrowser>> | undefined;
  let socket: WebSocket | undefined;
  const pending = new Map<number, { resolve(v: any): void; reject(e: Error): void; timer: Timer }>();
  const starts: Array<{ url: string; body: string }> = [];
  try {
    browser = await startBrowser(await browserPath(), join(folder, "profile"), "about:blank");
    socket = new WebSocket((await findBrowserPage(Number(browser.port))).webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => { socket!.onopen = () => resolve(); socket!.onerror = () => reject(new Error("browser connection")); });
    let next = 0;
    socket.onmessage = event => {
      const m = JSON.parse(String(event.data));
      if (m.method === "Network.requestWillBeSent") {
        const request = m.params.request;
        if (request.method === "POST" && new URL(request.url).pathname === "/api/sample/start") {
          starts.push({ url: request.url, body: request.postData });
        }
      }
      const item = pending.get(m.id);
      if (!item) return;
      pending.delete(m.id); clearTimeout(item.timer);
      m.error ? item.reject(new Error(JSON.stringify(m.error))) : item.resolve(m.result);
    };
    const send = (method: string, params: object = {}) => new Promise<any>((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + " timeout")); }, 10000);
      pending.set(id, { resolve, reject, timer }); socket!.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression: string) => {
      const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const wait = async (condition: string) => {
      try {
        await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+8000;const tick=()=>(${condition})?resolve(true):Date.now()>end?reject(Error("timeout")):setTimeout(tick,20);tick()})`);
      } catch {
        throw new Error(`Waiting for ${condition}: ${await evaluate("document.body.innerText")}`);
      }
    };
    const key = async (key: "Tab" | "Enter" | " ") => {
      const code = key === " " ? "Space" : key;
      const windowsVirtualKeyCode = key === "Tab" ? 9 : key === "Enter" ? 13 : 32;
      await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode, ...(key === "Enter" ? { text: "\r" } : key === " " ? { text: " " } : {}) });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode });
    };
    const activate = async (selector: string) => {
      await evaluate("document.activeElement?.blur(); true");
      for (let step = 0; step < 40; step++) {
        await key("Tab");
        if (await evaluate(`document.activeElement?.matches(${JSON.stringify(selector)})`)) {
          expect(await evaluate("getComputedStyle(document.activeElement).outlineStyle")).not.toBe("none");
          await key("Enter"); return;
        }
      }
      throw new Error(`Keyboard did not reach ${selector}`);
    };
    await send("Page.enable"); await send("Network.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

    for (const theme of ["light", "dark"]) {
      await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
      h = openHarness({ assets, runPollMs: 10, sampleDataset: dataset });
      const current = h;
      h.settings.set("wizard.completed", true);
      const sampleId = h.ctx.projects.sampleId()!;
      const requestStart = starts.length;
      await send("Page.navigate", { url: h.base + "/#/" });
      await wait("document.querySelector('main table tbody tr')");
      expect(await evaluate("document.querySelector('main table tbody tr td:first-child a')?.textContent")).toBe("Sample project");
      expect(await evaluate("document.querySelector('main table tbody tr td:nth-child(2)')?.textContent")).toBe("3");
      expect(await evaluate("getComputedStyle(document.documentElement).backgroundColor")).toBe(theme === "light" ? "rgb(255, 255, 255)" : "rgb(20, 22, 20)");
      await activate(`main a[href='#/projects/${sampleId}/photos']`);
      await wait("document.querySelector('main h1')?.textContent === 'Photos'");
      expect(await evaluate("document.querySelector('main input[type=file]')")).toBeNull();
      await activate(`nav.sidebar a[href='#/projects/${sampleId}/runs']`);
      await wait("document.querySelector('main .empty-state')?.textContent.includes('No engine can run the sample job yet.')");
      expect(await evaluate("document.querySelector('main .empty-state button')?.disabled")).toBe(true);
      const engineId = h.engineStore.addRemote({ name: "Field engine", address: engine.address, token: engine.token }).id;
      await eventually(async () => current.sample.view().engines.some(offer => offer.engineId === engineId && offer.offered));
      await send("Page.reload");
      await wait("document.querySelector('main .empty-state button:not(:disabled)')");
      expect(await evaluate("document.querySelectorAll('main .empty-state button, main .empty-state a').length")).toBe(1);
      expect(await evaluate("document.querySelector('main .empty-state button').textContent")).toBe("Run the sample job");
      expect(await evaluate("document.querySelectorAll('main button').length")).toBe(1);
      expect(await evaluate("document.querySelector('main select')?.labels[0]?.textContent")).toBe("Engine");
      expect(await evaluate("document.documentElement.scrollWidth <= innerWidth")).toBe(true);

      await evaluate("location.hash = '#/sample'; true");
      await wait(`location.hash === '#/projects/${sampleId}/runs' && document.querySelector('main .empty-state button:not(:disabled)')`);
      await activate("main .empty-state button");
      await wait("location.hash.startsWith('#/runs/')");
      const runId = Number((await evaluate("location.hash") as string).split("/")[2]);
      await eventually(async () => current.runs.get(runId)?.state === "queued");
      const run = h.runs.get(runId)!;
      expect(run).toMatchObject({ engineId, sample: true, preset: "map-with-heights" });
      const sampleTask = engine.tasks.get(run.taskUuid!)!;
      expect(sampleTask.committed).toBe(true);
      expect(sampleTask.images).toEqual(["DJI_0001.JPG", "DJI_0002.JPG", "DJI_0003.JPG"]);
      expect(starts.slice(requestStart)).toEqual([{ url: h.base + "/api/sample/start", body: JSON.stringify({ engineId }) }]);

      // The unchanged wizard sends the same request and options to the same engine.
      engine.setTask(run.taskUuid!, { statusCode: 30 });
      await eventually(async () => current.runs.get(runId)?.state === "failed");
      await send("Page.navigate", { url: h.base + "/#/wizard/sample" });
      await wait("[...document.querySelectorAll('main button')].some(b => b.textContent === 'Start again')");
      await evaluate("[...document.querySelectorAll('main button')].find(b => b.textContent === 'Start again').focus(); true");
      await key("Enter");
      await wait("document.querySelector('#sample-engine')");
      await activate("main .actions button:not(:disabled)");
      await eventually(async () => current.sample.view().run?.id !== runId && current.sample.view().run?.state === "queued");
      const wizardRun = h.sample.view().run!;
      const wizardTask = engine.tasks.get(h.runs.get(wizardRun.id)!.taskUuid!)!;
      expect(wizardTask.options).toEqual(sampleTask.options);
      expect(wizardRun.preset).toBe(run.preset);
      expect(starts.slice(requestStart)).toEqual([
        { url: h.base + "/api/sample/start", body: JSON.stringify({ engineId }) },
        { url: h.base + "/api/sample/start", body: JSON.stringify({ engineId }) },
      ]);
      expect(await evaluate("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
      await send("Page.navigate", { url: "about:blank" });
      await h.stop(); h = undefined;
    }
  } finally {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error("test ended")); }
    socket?.close(); await browser?.stop(); await h?.stop(); await engine.stop(); await files.stop();
    await rm(folder, { recursive: true, force: true });
  }
}, 120000);
