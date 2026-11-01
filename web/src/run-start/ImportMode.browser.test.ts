import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserPath } from "../controls/browser-path.ts";
import { startBrowser } from "../controls/browser-start.ts";
import { findBrowserPage } from "../controls/browser-target.ts";
import { PRESET_IDS } from "../../../shared/option-catalogue.ts";

test("keyboard import choices survive review and reset on an engine change", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aidm-import-browser-"));
  const build = await Bun.build({ entrypoints: [new URL("./browser-fixture.tsx", import.meta.url).pathname], target: "browser" });
  expect(build.success).toBe(true);
  let posted: any;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/") return new Response('<div id="root"></div><script type="module" src="/fixture.js"></script>', { headers: { "content-type": "text/html" } });
    if (url.pathname === "/fixture.js") return new Response(await build.outputs[0]!.text(), { headers: { "content-type": "text/javascript" } });
    if (url.pathname === "/api/presets") return Response.json({ presets: [], nextOffset: null });
    if (url.pathname === "/api/engines") return Response.json([{ id: 1, name: "Same machine", enabled: true }, { id: 2, name: "Other engine", enabled: true }]);
    if (url.pathname.endsWith("/run-review")) {
      const body = request.method === "POST" ? await request.json() as any : Object.fromEntries(url.searchParams);
      const engine = Number(body.engineId), available = engine === 1, selected = body.importMode ?? (available ? "in-place" : "copy");
      return Response.json({ project: { id: 1, name: "Project" }, engine: { id: engine, name: engine === 1 ? "Same machine" : "Other engine", kind: "remote", info: { version: "2.7.0" }, gpu: null, imageLimit: null, imageLimitReported: true }, preset: body.preset, presets: PRESET_IDS.map(id => ({ id, departures: [] })), wayIn: "import", importMode: { available, selected, restartRequired: available, selectionRequiresCopy: false }, photos: { included: 2, excluded: 0, total: 2, bytes: 10 }, facts: null, options: [], outputs: ["orthophoto"], alwaysProduced: [], revision: `revision-${engine}-${selected}`, blocked: null });
    }
    if (url.pathname.endsWith("/runs")) { posted = await request.json(); return Response.json({ id: 9 }, { status: 202 }); }
    return new Response(null, { status: 404 });
  } });
  let browser: Awaited<ReturnType<typeof startBrowser>> | undefined;
  let socket: WebSocket | undefined;
  try {
    browser = await startBrowser(await browserPath(), directory, "about:blank");
    socket = new WebSocket((await findBrowserPage(Number(browser.port))).webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => { socket!.onopen = () => resolve(); socket!.onerror = () => reject(new Error("Browser connection failed")); });
    let id = 0;
    const pending = new Map<number, (value: any) => void>();
    socket.onmessage = event => { const message = JSON.parse(String(event.data)); if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id); } };
    const send = (method: string, params: object = {}) => new Promise<any>(resolve => { const next = ++id; pending.set(next, resolve); socket!.send(JSON.stringify({ id: next, method, params })); });
    const evaluate = async (expression: string) => { const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (result.result.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails)); return result.result.result.value; };
    const wait = (expression: string) => evaluate(`new Promise((resolve, reject) => { const end = Date.now() + 4000; const check = () => ${expression} ? resolve(true) : Date.now() > end ? reject(Error('timeout')) : setTimeout(check, 20); check(); })`);
    const key = async (key: string, code: string, windowsVirtualKeyCode: number) => { await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, windowsVirtualKeyCode }); await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode }); };
    await send("Page.navigate", { url: `http://127.0.0.1:${server.port}/` });
    await wait("document.querySelector('button')");
    await evaluate("document.querySelector('button').focus()"); await key(" ", "Space", 32);
    await wait("[...document.querySelectorAll('button')].some(b => b.textContent === 'Review run' && !b.disabled)");
    await evaluate("[...document.querySelectorAll('button')].find(b => b.textContent === 'Review run').focus()"); await key(" ", "Space", 32);
    await wait("document.querySelector('input[value=\"in-place\"]:checked')");
    expect(await evaluate("document.body.textContent.includes('Starting this run will restart it')")).toBe(true);
    await evaluate("document.querySelector('input[value=\"in-place\"]').focus()"); await key("ArrowDown", "ArrowDown", 40);
    await wait("document.querySelector('input[value=copy]:checked') && [...document.querySelectorAll('button')].some(b => b.textContent === 'Start run' && !b.disabled)");
    expect(await evaluate("document.body.textContent.includes('Starting this run will restart it')")).toBe(false);
    await wait("document.activeElement?.matches('input[value=copy]')");
    expect(await evaluate("document.activeElement?.matches('input[value=copy]')")).toBe(true);
    await evaluate("document.querySelector('#run-engine').value='2'; document.querySelector('#run-engine').dispatchEvent(new Event('change',{bubbles:true}))");
    await wait("document.body.textContent.includes('Engine: Other engine')");
    expect(await evaluate("document.querySelectorAll('input[name=import-mode]').length")).toBe(0);
    expect(await evaluate("document.body.textContent.includes('where they are')")).toBe(false);
    await evaluate("document.querySelector('#run-engine').value='1'; document.querySelector('#run-engine').dispatchEvent(new Event('change',{bubbles:true}))");
    await wait("document.querySelector('input[value=\"in-place\"]:checked')");
    await evaluate("document.querySelector('input[value=\"in-place\"]').focus()"); await key("ArrowDown", "ArrowDown", 40);
    await wait("document.querySelector('input[value=copy]:checked') && [...document.querySelectorAll('button')].some(b => b.textContent === 'Start run' && !b.disabled)");
    await send("Emulation.setDeviceMetricsOverride", { width: 820, height: 1024, deviceScaleFactor: 1, mobile: false });
    expect(await evaluate("document.documentElement.scrollWidth<=innerWidth")).toBe(true);
    await evaluate("[...document.querySelectorAll('button')].find(b => b.textContent === 'Start run').focus()"); await key(" ", "Space", 32);
    await wait("location.hash==='#/runs/9'");
    expect(posted).toMatchObject({ engineId: 1, importMode: "copy", revision: "revision-1-copy" });
  } finally { socket?.close(); await browser?.stop(); server.stop(true); await rm(directory, { recursive: true, force: true }); }
}, 30000);
