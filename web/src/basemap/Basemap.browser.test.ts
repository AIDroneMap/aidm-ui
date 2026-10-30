import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_BASEMAP, type BasemapSettings } from "../../../shared/basemap.ts";
import { withSecurityHeaders } from "../../../server/http/security-headers.ts";
import { browserPath } from "../controls/browser-path.ts";
import { startBrowser } from "../controls/browser-start.ts";
import { findBrowserPage } from "../controls/browser-target.ts";

test("basemap is opt-in, uses saved numbering and attribution, and fails without hiding results", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aidm-basemap-"));
  const build = await Bun.build({ entrypoints: [new URL("./browser-fixture.tsx", import.meta.url).pathname], outdir: directory, naming: "fixture.[ext]", target: "browser", plugins: [{ name: "worker-url", setup(builder) {
    builder.onResolve({ filter: /maplibre-gl-worker\.mjs\?url$/ }, () => ({ path: "worker-url", namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: 'export default "/map-worker.mjs"', loader: "js" }));
  } }] });
  expect(build.success).toBe(true);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQI12P4z8DwHwAFAAH/cpxSZwAAAABJRU5ErkJggg==", "base64");
  let stored: BasemapSettings = { ...DEFAULT_BASEMAP };
  let settingsGate: Promise<void> | null = null;
  const blue = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/5ncLrgAAAABJRU5ErkJggg==", "base64");
  let failing = false, failOrtho = false, rejectSave = false, pageLoads = 0;
  const baseRequests: string[] = [], localRequests: string[] = [];
  const tiles = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
    baseRequests.push(new URL(request.url).pathname);
    return new Response(failing ? null : blue, { status: failing ? 503 : 200, headers: { "access-control-allow-origin": "*", "content-type": "image/png", "cache-control": "no-store" } });
  } });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const path = new URL(request.url).pathname; localRequests.push(path);
    if (path === "/") { pageLoads++; return withSecurityHeaders(new Response('<link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script>', { headers: { "content-type": "text/html" } }), stored); }
    if (path === "/fixture.js" || path === "/fixture.css") return new Response(Bun.file(join(directory, path.slice(1))));
    if (path === "/map-worker.mjs") return new Response(Bun.file("node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs"), { headers: { "content-type": "text/javascript" } });
    if (path === "/api/settings/basemap") {
      if (request.method === "PUT") {
        if (rejectSave) return Response.json({ error: { code: "settings.basemap_invalid", data: {} } }, { status: 400 });
        stored = await request.json() as BasemapSettings;
      }
      if (request.method === "GET" && settingsGate) await settingsGate;
      return Response.json(stored);
    }
    if (path === "/api/runs/7/map") return Response.json({ state: "ready", layers: [{ name: "orthophoto", bounds: [-40, -40, 40, 40], minZoom: 0, maxZoom: 8, scheme: "xyz" }] });
    if (path.includes("/tiles/")) return new Response(failOrtho ? null : png, { status: failOrtho ? 503 : 200, headers: { "content-type": "image/png" } });
    return new Response(null, { status: 404 });
  } });
  let browser: Awaited<ReturnType<typeof startBrowser>> | undefined, socket: WebSocket | undefined;
  try {
    browser = await startBrowser(await browserPath(), join(directory, "profile"), "about:blank");
    socket = new WebSocket((await findBrowserPage(Number(browser.port))).webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => { socket!.onopen = () => resolve(); socket!.onerror = () => reject(new Error("Browser connection failed")); });
    let sequence = 0; const pending = new Map<number, (message: any) => void>(), network: string[] = [];
    socket.onmessage = event => { const message = JSON.parse(String(event.data)); if (message.method === "Network.requestWillBeSent") network.push(message.params.request.url); if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id); } };
    const send = (method: string, params: object = {}) => new Promise<any>(resolve => { const id = ++sequence; pending.set(id, resolve); socket!.send(JSON.stringify({ id, method, params })); });
    const evaluate = async (expression: string) => { const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (result.error) throw new Error(result.error.message); if (result.result.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails)); return result.result.result.value; };
    const wait = async (expression: string) => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        try { if (await evaluate(`Boolean(${expression})`)) return; }
        catch (error) { if (!String(error).includes("Execution context was destroyed")) throw error; }
        await Bun.sleep(20);
      }
      throw new Error(`Waiting for ${expression}`);
    };
    const click = (text: string) => evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent===${JSON.stringify(text)}).click()`);
    const type = async (selector: string, text: string) => { await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus();document.querySelector(${JSON.stringify(selector)}).select()`); await send("Input.insertText", { text }); };
    const openMap = async () => { await click("Open the map"); await wait("document.querySelector('.maplibregl-canvas') && !document.querySelector('section[aria-label=Map] [role=status]')"); };
    await send("Network.enable");
    await send("Page.navigate", { url: `http://127.0.0.1:${server.port}/` });
    await wait("document.querySelector('#basemap-url')");
    expect(await evaluate("document.querySelector('#basemap-url').value")).toBe("");
    expect(await evaluate("document.querySelector('#basemap-enabled').checked")).toBe(false);
    await openMap();
    await wait("performance.getEntriesByType('resource').some(item=>item.name.includes('/tiles/'))");
    expect(baseRequests).toEqual([]);
    expect(network.filter(url => !url.startsWith("data:") && !url.startsWith("blob:")).every(url => url.startsWith(`http://127.0.0.1:${server.port}/`))).toBe(true);
    expect(await evaluate(`fetch(${JSON.stringify(`http://127.0.0.1:${tiles.port}/blocked`)}).then(()=>false,()=>true)`)).toBe(true);
    expect(baseRequests).toEqual([]);
    const template = `http://127.0.0.1:${tiles.port}/base/{z}/{x}/{y}.png`;
    await type("#basemap-url", template);
    await type("#basemap-attribution", '<img src="/unwanted"> Map author');
    await evaluate("document.querySelector('#basemap-enabled').click()");
    rejectSave = true; await click("Save basemap");
    await wait("document.querySelector('[aria-labelledby=basemap-title] [role=alert]')");
    expect(await evaluate("document.querySelector('#basemap-url').value")).toBe(template);
    rejectSave = false; await click("Save basemap").catch(error => { if (!String(error).includes("Execution context was destroyed")) throw error; });
    await wait("document.querySelector('#basemap-enabled')?.checked && Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Open the map')");
    expect(pageLoads).toBe(2);
    expect(baseRequests).toEqual([]);
    for (const scheme of ["xyz", "tms"] as const) {
      stored = { ...stored, scheme };
      const previousDocument = await evaluate("performance.timeOrigin");
      await send("Page.reload");
      await wait(`performance.timeOrigin !== ${previousDocument} && document.querySelector('#basemap-url') && Array.from(document.querySelectorAll('button')).some(button => button.textContent === 'Open the map')`);
      expect(await evaluate(`performance.getEntriesByType('resource').some(item => item.name.startsWith(${JSON.stringify(`http://127.0.0.1:${tiles.port}/`)}))`)).toBe(false);
      const baseStart = baseRequests.length, localStart = localRequests.length;
      const delayed = scheme === "xyz" ? Promise.withResolvers<void>() : null;
      settingsGate = delayed?.promise ?? null;
      await openMap();
      let chosenCenter: string | null = null;
      if (delayed) {
        await wait("!document.querySelector('section[aria-label=Map] fieldset').disabled");
        const initialCenter = await evaluate("document.querySelector('p[aria-live]').textContent");
        await evaluate("document.querySelector('.maplibregl-canvas').focus()");
        await send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 });
        await send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 });
        await wait(`document.querySelector('p[aria-live]').textContent !== ${JSON.stringify(initialCenter)}`);
        await Bun.sleep(350);
        chosenCenter = await evaluate("document.querySelector('p[aria-live]').textContent");
        settingsGate = null; delayed.resolve();
      }
      await wait(`performance.getEntriesByType('resource').some(item=>item.name.startsWith(${JSON.stringify(`http://127.0.0.1:${tiles.port}/base/`)}))`);
      if (chosenCenter) expect(await evaluate("document.querySelector('p[aria-live]').textContent")).toBe(chosenCenter);
      expect(await evaluate("document.body.textContent.includes('<img src=\"/unwanted\"> Map author') && !document.querySelector('img[src=\"/unwanted\"]')")).toBe(true);
      const coordinates = localRequests.slice(localStart).filter(path => path.includes("/tiles/orthophoto/")).map(path => path.split("/").slice(-3).map(value => Number(value.replace(".png", ""))));
      expect(baseRequests.slice(baseStart).some(path => {
        const [z, x, y] = path.split("/").slice(-3).map(value => Number(value.replace(".png", "")));
        return coordinates.some(([lz, lx, ly]) => z === lz && x === lx && y === (scheme === "xyz" ? ly : 2 ** lz! - 1 - ly!));
      })).toBe(true);
    }
    failing = true;
    const localBeforeFailure = localRequests.filter(path => path.includes("/tiles/")).length;
    await evaluate("document.querySelector('.maplibregl-canvas').scrollIntoView();document.querySelector('.maplibregl-canvas').focus()");
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "+", code: "Equal", windowsVirtualKeyCode: 187, modifiers: 8 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "+", code: "Equal", windowsVirtualKeyCode: 187, modifiers: 8 });
    await wait(`Array.from(document.querySelectorAll('[role=alert]')).some(element=>element.textContent.includes(${JSON.stringify(template)}))`);
    expect(localRequests.filter(path => path.includes("/tiles/")).length).toBeGreaterThan(localBeforeFailure);
    expect(await evaluate("document.querySelector('.maplibregl-canvas') !== null")).toBe(true);
    expect(await evaluate("!document.body.textContent.includes('Some map tiles could not be loaded')")).toBe(true);
    await Bun.sleep(350);
    const clip = await evaluate("(() => { const r=document.querySelector('.maplibregl-canvas').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1}; })()");
    const screenshot = (await send("Page.captureScreenshot", { format: "png", clip })).result.data;
    expect(await evaluate(`(async()=>{const image=new Image();image.src='data:image/png;base64,'+${JSON.stringify(screenshot)};await image.decode();const c=document.createElement('canvas');c.width=image.width;c.height=image.height;const ctx=c.getContext('2d');ctx.drawImage(image,0,0);const d=ctx.getImageData(0,0,c.width,c.height).data;let red=0;for(let i=0;i<d.length;i+=4)if(d[i]>180&&d[i+1]<80&&d[i+2]<80)red++;return red>100;})()`)).toBe(true);
    stored = { ...stored, enabled: false }; failOrtho = true;
    const previousDocument = await evaluate("performance.timeOrigin");
    await send("Page.reload");
    await wait(`performance.timeOrigin !== ${previousDocument} && document.querySelector('#basemap-url')`);
    await openMap();
    await wait("document.body.textContent.includes('Some map tiles could not be loaded')");
    expect(await evaluate(`performance.getEntriesByType('resource').some(item => item.name.startsWith(${JSON.stringify(`http://127.0.0.1:${tiles.port}/`)}))`)).toBe(false);
    expect(await evaluate(`!Array.from(document.querySelectorAll('section[aria-label=Map] [role=alert]')).some(element=>element.textContent.includes(${JSON.stringify(template)}))`)).toBe(true);
  } finally { socket?.close(); await browser?.stop(); server.stop(true); tiles.stop(true); await rm(directory, { recursive: true, force: true }); }
}, 45000);
