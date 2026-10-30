import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRESET_IDS } from "../../../shared/option-catalogue.ts";
import { browserPath } from "../controls/browser-path.ts";
import { startBrowser } from "../controls/browser-start.ts";
import { findBrowserPage } from "../controls/browser-target.ts";

test("project switches sources without losing edits and ignores stale link reads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aidm-project-link-"));
  const fixture = await Bun.build({ entrypoints: [new URL("./project-browser-fixture.tsx", import.meta.url).pathname], target: "browser" });
  let stored: string | null = null;
  const facts = { photoCount: 2, withoutGps: 1, cameras: [{ make: "Camera", model: "One", photoCount: 2 }], dimensions: [{ width: 4000, height: 3000, photoCount: 2 }] };
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/") return new Response('<div id="root"></div><script type="module" src="/fixture.js"></script>', { headers: { "content-type": "text/html" } });
    if (path === "/fixture.js") return new Response(await fixture.outputs[0]!.text(), { headers: { "content-type": "text/javascript" } });
    if (path === "/api/projects/1") return Response.json({ id: 1, name: "Survey", notes: "Saved", builtin: null, photoCount: 0, runCount: 0, latestState: null, lastChange: "2024-01-01T00:00:00Z" });
    if (path.endsWith("/link")) {
      if (request.method === "PUT") { stored = (await request.json() as { url: string }).url; return Response.json({ url: stored, size: 1024, facts: null, factsRunId: null }); }
      if (request.method === "DELETE") stored = null;
      const snapshot = stored;
      return Response.json({ url: snapshot, size: null, facts: snapshot?.includes("second") ? facts : null, factsRunId: snapshot?.includes("second") ? 7 : null });
    }
    if (path.endsWith("/import")) return Response.json({ available: true, state: "none", path: null, acceptedCount: 0, skippedCount: 0, groundControlCount: 0, files: [], nextOffset: null });
    if (path.endsWith("/photos")) { await Bun.sleep(1000); return Response.json({ files: [], nextOffset: null }); }
    if (path.endsWith("/photo-facts")) { await Bun.sleep(1000); return Response.json({ photoCount: 0, photoBytes: 0, duplicates: 0, videoCount: 0, withoutGps: 0, cameras: [], bands: [], dateSpans: [], flights: [], flightCount: 0, unassignedCount: 0, pendingMetadata: 0, nextOffset: null }); }
    if (path === "/api/engines") return Response.json([{ id: 1, name: "Engine", enabled: true }]);
    if (path.endsWith("/run-review")) return Response.json({ project: { id: 1, name: "Survey" }, engine: { id: 1, name: "Engine", kind: "remote", info: {}, gpu: null, imageLimit: null, imageLimitReported: false }, preset: "quick-map", presets: PRESET_IDS.map(id => ({ id, departures: [] })), wayIn: "link", photos: { included: null, excluded: null, total: null, bytes: null }, facts: null, options: [], outputs: [], alwaysProduced: [], revision: "revision", blocked: null });
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
    const wait = (expression: string) => evaluate(`new Promise((resolve, reject) => { const end = Date.now() + 5000; const check = () => ${expression} ? resolve(true) : Date.now() > end ? reject(Error('timeout: ' + ${JSON.stringify(expression)})) : setTimeout(check, 20); check(); })`);
    const type = async (selector: string, text: string) => { await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus(); document.querySelector(${JSON.stringify(selector)}).select()`); await send("Input.insertText", { text }); };
    const pressButton = async (text: string) => { await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent === ${JSON.stringify(text)}).focus()`); await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32 }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32 }); };
    await send("Page.navigate", { url: `http://127.0.0.1:${server.port}/#/projects/1` });
    await wait("document.querySelector('#link-url') && document.querySelector('#import-path') && document.body.textContent.includes('Project files') && document.body.textContent.includes('Photo facts')");
    expect(await evaluate("document.body.textContent.includes('Project files') && document.body.textContent.includes('Photo facts')")).toBe(true);
    await type("#project-name", "Unsaved name"); await type("#project-notes", "Unsaved notes");
    await evaluate("window.holdLinkRead = true");
    await type("#link-url", "https://example.test/first.zip"); await pressButton("Check and save link");
    await wait("document.body.textContent.includes('1 KiB') && document.body.textContent.includes('Remove link')");
    expect(await evaluate("!document.querySelector('#import-path') && !document.body.textContent.includes('Project files') && !document.body.textContent.includes('Photo facts')")).toBe(true);
    await wait("document.querySelector('#link-url').value.includes('first')");
    await type("#link-url", "https://example.test/second.zip?x=A%2Fb");
    expect(await evaluate("document.body.textContent.includes('1 KiB')")).toBe(false);
    await wait("window.linkReadHeld");
    expect(await evaluate("document.querySelector('#link-url').value")).toBe("https://example.test/second.zip?x=A%2Fb");
    expect(await evaluate("[...document.querySelectorAll('button')].find(button => button.textContent === 'Check and save link').disabled")).toBe(false);
    await pressButton("Check and save link");
    await wait("document.body.textContent.includes('second.zip')");
    await evaluate("window.releaseLinkRead()");
    await wait("document.body.textContent.includes('Camera One')");
    await evaluate("new Promise(resolve => setTimeout(resolve, 100))");
    expect(await evaluate("document.body.textContent.includes('4000 x 3000') && document.body.textContent.includes('Photos: 2') && document.body.textContent.includes('Photos without GPS: 1') && !document.body.textContent.includes('first.zip')")).toBe(true);
    expect(await evaluate("document.querySelector('#project-name').value + '|' + document.querySelector('#project-notes').value")).toBe("Unsaved name|Unsaved notes");
    await pressButton("Choose a preset");
    await wait("[...document.querySelectorAll('button')].some(button => button.textContent === 'Review run' && !button.disabled)");
    await pressButton("Review run");
    await wait("document.body.textContent.includes('The photo count and size are unknown.')");
    expect(await evaluate("document.body.textContent.includes('engine checks its photo limit') && !document.body.textContent.includes('NaN') && !document.body.textContent.includes('Previous') && !document.body.textContent.includes('Next')")).toBe(true);
    await send("Page.reload");
    await wait("document.body.textContent.includes('Camera One') && document.body.textContent.includes('Remove link')");
    expect(await evaluate("!document.querySelector('#import-path') && !document.body.textContent.includes('1 KiB')")).toBe(true);
    await type("#project-name", "Other unsaved name"); await type("#project-notes", "Other unsaved notes");
    await pressButton("Remove link");
    await wait("document.querySelector('#import-path') && document.body.textContent.includes('Project files')");
    expect(await evaluate("document.querySelector('#project-name').value + '|' + document.querySelector('#project-notes').value")).toBe("Other unsaved name|Other unsaved notes");
    expect(stored as string | null).toBeNull();
    await send("Page.reload");
    await wait("document.querySelector('#import-path') && document.body.textContent.includes('Photo facts')");
    expect(await evaluate("document.body.textContent.includes('Remove link')")).toBe(false);
  } finally { socket?.close(); await browser?.stop(); server.stop(true); await rm(directory, { recursive: true, force: true }); }
}, 30000);
