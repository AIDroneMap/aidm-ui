import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserPath } from "../controls/browser-path.ts";
import { startBrowser } from "../controls/browser-start.ts";
import { findBrowserPage } from "../controls/browser-target.ts";
import { PRESET_IDS } from "../../../shared/option-catalogue.ts";

test("review ignores stale engines, blocks above the limit and starts at the limit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aidm-start-"));
  const build = await Bun.build({ entrypoints: [new URL("./browser-fixture.tsx", import.meta.url).pathname], target: "browser" });
  let release: (() => void) | undefined;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  let posted: any;
  let readyReviews = 0;
  let starts = 0;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/") return new Response('<div id="root"></div><script type="module" src="/fixture.js"></script>', { headers: { "content-type": "text/html" } });
    if (url.pathname === "/fixture.js") return new Response(await build.outputs[0]!.text(), { headers: { "content-type": "text/javascript" } });
    if (url.pathname === "/api/presets") return Response.json({ presets: [], nextOffset: null });
    if (url.pathname === "/api/engines") return Response.json([{ id: 1, name: "Slow", enabled: true }, { id: 2, name: "Ready", enabled: true }]);
    if (url.pathname.endsWith("/run-review")) {
      const id = Number(url.searchParams.get("engineId"));
      if (id === 1) await delayed;
      const preset = url.searchParams.get("preset");
      const pendingMetadata = id === 2 && ++readyReviews === 1 ? 1 : 0;
      return Response.json({ project: { id: 1, name: "Project" }, engine: { id, name: id === 1 ? "Slow" : "Ready", kind: "remote", info: { version: id === 2 && !pendingMetadata ? "2" : "1", engineVersion: null, cpuCores: 4, totalMemory: null, availableMemory: null, queueCount: 0, maxParallelTasks: null }, gpu: null, imageLimit: id === 1 ? 1 : 2, imageLimitReported: true }, preset, presets: PRESET_IDS.map(id => ({ id, departures: [] })), wayIn: "upload", photos: { included: 2, excluded: 0, total: 2, bytes: 10 }, facts: { flights: [], nextOffset: null, pendingMetadata }, options: [], outputs: ["orthophoto"], alwaysProduced: [], revision: `revision-${id}`, blocked: id === 1 ? { code: "project_run.image_limit", data: { count: 2, limit: 1 } } : pendingMetadata ? { code: "project_run.metadata_pending", data: {} } : null });
    }
    if (url.pathname.endsWith("/runs")) { posted = await request.json(); if (++starts === 1) return Response.json({ error: { code: "project_run.review_changed", data: {} } }, { status: 409 }); return Response.json({ id: 9 }, { status: 202 }); }
    return new Response(null, { status: 404 });
  } });
  let browser: Awaited<ReturnType<typeof startBrowser>> | undefined;
  let socket: WebSocket | undefined;
  try {
    browser = await startBrowser(await browserPath(), directory, "about:blank");
    socket = new WebSocket((await findBrowserPage(Number(browser.port))).webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => { socket!.onopen = () => resolve(); socket!.onerror = () => reject(new Error("Browser connection failed")); });
    let id = 0; const pending = new Map<number, (value: any) => void>();
    socket.onmessage = event => { const message = JSON.parse(String(event.data)); if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id); } };
    const send = (method: string, params: object = {}) => new Promise<any>(resolve => { const next = ++id; pending.set(next, resolve); socket!.send(JSON.stringify({ id: next, method, params })); });
    const evaluate = async (expression: string) => { const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (result.result.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails)); return result.result.result.value; };
    const wait = (expression: string) => evaluate(`new Promise((resolve, reject) => { const end = Date.now() + 4000; const check = () => ${expression} ? resolve(true) : Date.now() > end ? reject(Error('timeout')) : setTimeout(check, 20); check(); })`);
    await send("Page.navigate", { url: `http://127.0.0.1:${server.port}/` });
    await wait("document.querySelector('button')");
    await evaluate("document.querySelector('button').focus()");
    await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
    await wait("document.querySelectorAll('#run-engine option').length === 2");
    await evaluate("document.querySelector('#run-engine').value = '2'; document.querySelector('#run-engine').dispatchEvent(new Event('change', { bubbles: true }))");
    await wait("[...document.querySelectorAll('button')].some(b => b.textContent === 'Review run' && !b.disabled)");
    release!();
    await evaluate("new Promise(resolve => setTimeout(resolve, 100))");
    await evaluate("[...document.querySelectorAll('button')].find(b => b.textContent === 'Review run').click()");
    await wait("document.body.textContent.includes('Engine: Ready')");
    await wait("document.body.textContent.includes('Task API version: 2')");
    expect(await evaluate("document.body.textContent.includes('Photo limit: 2')")).toBe(true);
    expect(await evaluate("document.body.textContent.includes('GPU: Not reported')")).toBe(true);
    await evaluate("document.querySelector('#run-engine').value = '1'; document.querySelector('#run-engine').dispatchEvent(new Event('change', { bubbles: true }))");
    await wait("document.body.textContent.includes('Engine: Slow')");
    expect(await evaluate("[...document.querySelectorAll('button')].find(b => b.textContent === 'Start run').disabled")).toBe(true);
    expect(await evaluate("document.body.textContent.includes('Photo limit: 1')")).toBe(true);
    await evaluate("document.querySelector('#run-engine').value = '2'; document.querySelector('#run-engine').dispatchEvent(new Event('change', { bubbles: true }))");
    await wait("document.body.textContent.includes('Engine: Ready')");
    await evaluate("[...document.querySelectorAll('button')].find(b => b.textContent === 'Start run').click()");
    await wait("document.body.textContent.includes('Reload the review before starting.')");
    await evaluate("[...document.querySelectorAll('button')].find(b => b.textContent === 'Reload review').click()");
    await wait("[...document.querySelectorAll('button')].some(b => b.textContent === 'Start run' && !b.disabled)");
    await evaluate("[...document.querySelectorAll('button')].find(b => b.textContent === 'Start run').click()");
    await wait("location.hash === '#/runs/9'");
    expect(posted).toMatchObject({ engineId: 2, preset: "quick-map", revision: "revision-2" });
  } finally { release?.(); socket?.close(); await browser?.stop(); server.stop(true); await rm(directory, { recursive: true, force: true }); }
}, 30000);
