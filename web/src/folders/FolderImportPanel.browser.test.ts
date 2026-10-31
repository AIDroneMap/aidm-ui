import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserPath } from "../controls/browser-path.ts";
import { startBrowser } from "../controls/browser-start.ts";
import { findBrowserPage } from "../controls/browser-target.ts";

test("folder availability, relinking and stale page responses", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aidm-folder-page-"));
  let available = true;
  let state = "none";
  let held: (() => void) | undefined;
  let submitted = "";
  const source = (offset = 0) => ({ available, state, path: available && state !== "none" ? submitted || "/old" : null, acceptedCount: 51, skippedCount: 2, groundControlCount: 1, files: [{ name: offset ? "second.jpg" : "p".repeat(240) + ".jpg", size: 12, kind: "photo" }], nextOffset: offset ? null : 50 });
  const styles = (await Promise.all(["styles.css", "tokens.css", "controls/Button.css", "controls/TextField.css"].map(path => readFile(new URL(`../${path}`, import.meta.url), "utf8")))).join("\n").replace(/@import[^;]+;/g, "");
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const json = (value: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (url.pathname === "/") { res.writeHead(200, { "content-type": "text/html" }); res.end('<link rel="stylesheet" href="/fixture.css"><main id="root"></main><script type="module" src="/fixture.js"></script>'); return; }
    if (url.pathname === "/fixture.css") { res.setHeader("content-type", "text/css"); res.end(styles); return; }
    if (url.pathname === "/fixture.js") { res.writeHead(200, { "content-type": "text/javascript" }); res.end(await readFile(join(dir, "fixture.js"))); return; }
    if (/^\/api\/projects\/\d+$/.test(url.pathname)) { json({ id: Number(url.pathname.split("/").pop()), name: "Survey", notes: "Saved", builtin: null, photoCount: state === "none" ? 0 : 51, runCount: 0, latestState: null, lastChange: "2024-01-01T00:00:00Z" }); return; }
    if (url.pathname.endsWith("/link")) { json({ url: null, size: null, facts: null, factsRunId: null }); return; }
    if (url.pathname.endsWith("/runs")) { json({ runs: [], nextOffset: null }); return; }
    if (url.pathname.endsWith("/import")) {
      if (req.method === "PUT") { const parts: Buffer[] = []; for await (const part of req) parts.push(Buffer.from(part)); submitted = JSON.parse(Buffer.concat(parts).toString()).path; state = "ready"; json(source()); return; }
      if (url.searchParams.get("offset") === "50") { const old = source(50); held = () => json(old); return; }
      json(source()); return;
    }
    if (url.pathname.endsWith("/photos")) { json({ files: [], nextOffset: null }); return; }
    if (url.pathname.endsWith("/photo-facts")) { json({ photoCount: 0, photoBytes: 0, duplicates: 0, videoCount: 0, withoutGps: 0, cameras: [], bands: [], dateSpans: [], flights: [], flightCount: 0, unassignedCount: 0, pendingMetadata: 0, nextOffset: null }); return; }
    res.writeHead(404); res.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No server address");
  let browser: Awaited<ReturnType<typeof startBrowser>> | undefined; let socket: WebSocket | undefined;
  try {
    expect((await Bun.build({ entrypoints: [new URL("./browser-fixture.tsx", import.meta.url).pathname], outdir: dir, naming: "fixture.[ext]", target: "browser" })).success).toBe(true);
    browser = await startBrowser(await browserPath(), join(dir, "profile"), "about:blank");
    socket = new WebSocket((await findBrowserPage(Number(browser.port))).webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => { socket!.onopen = () => resolve(); socket!.onerror = () => reject(new Error("Browser connection failed")); });
    let id = 0; const pending = new Map<number, (value: any) => void>();
    socket.onmessage = event => { const message = JSON.parse(String(event.data)); if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id); } };
    const send = (method: string, params: object = {}) => new Promise<any>((resolve, reject) => { const n = ++id; const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 15000); pending.set(n, value => { clearTimeout(timer); value.error ? reject(new Error(JSON.stringify(value.error))) : resolve(value.result); }); socket!.send(JSON.stringify({ id: n, method, params })); });
    const evalJs = async (expression: string) => { const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value; };
    const wait = async (condition: string) => { await evalJs(`new Promise((resolve, reject) => { const end = Date.now() + 10000; const check = () => { if (${condition}) resolve(true); else if (Date.now() > end) reject(Error('condition timed out')); else setTimeout(check, 20); }; check(); })`); };
    await send("Emulation.setDeviceMetricsOverride", { width: 768, height: 1024, deviceScaleFactor: 1, mobile: false });
    await send("Page.enable"); await send("Page.navigate", { url: `http://127.0.0.1:${address.port}/#/projects/1` });
    await wait("document.querySelector('#import-path')");
    for (let index = 0; index < 20; index++) {
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
      if (await evalJs("document.activeElement.id === 'import-path'")) break;
    }
    expect(await evalJs("document.activeElement.id === 'import-path' && document.activeElement.labels.length === 1 && getComputedStyle(document.activeElement).outlineWidth === '3px'")).toBe(true);
    await evalJs("document.querySelector('#project-name').focus(); document.querySelector('#project-name').select()"); await send("Input.insertText", { text: "Unsaved name" });
    await evalJs("document.querySelector('#project-notes').focus(); document.querySelector('#project-notes').select()"); await send("Input.insertText", { text: "Unsaved notes" });
    await evalJs("document.querySelector('#import-path').focus()"); await send("Input.insertText", { text: "/new" });
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await send("Input.dispatchKeyEvent", { type: "char", text: "\r", unmodifiedText: "\r", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await wait("document.body.textContent.includes('Folder imported.')");
    expect(submitted).toBe("/new");
    expect(await evalJs("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
    expect(await evalJs("document.querySelector('#project-name').value + '|' + document.querySelector('#project-notes').value")).toBe("Unsaved name|Unsaved notes");
    await evalJs("Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Next').click()");
    await wait("document.querySelector('#import-path').value === '/new'");
    await new Promise<void>((resolve, reject) => { const end = Date.now() + 5000; const check = () => held ? resolve() : Date.now() > end ? reject(Error("page request missing")) : setTimeout(check, 20); check(); });
    available = false; state = "missing";
    await evalJs("location.hash = '#/projects/2'"); await wait("document.body.textContent.includes('folder is missing')");
    expect(await evalJs("!!document.querySelector('#import-path')")).toBe(false);
    held!(); await wait("document.body.textContent.includes('folder is missing')");
    expect(await evalJs("document.body.textContent.includes('second.jpg')")).toBe(false);
    available = true; state = "changed";
    await evalJs("location.hash = '#/projects/1'"); await wait("document.body.textContent.includes('folder has changed')");
    expect(await evalJs("!!document.querySelector('#import-path') && document.body.textContent.includes('Relink folder')")).toBe(true);
    expect(await evalJs("document.querySelector('#import-path').value")).toBe("/new");
  } finally { socket?.close(); await browser?.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
}, 60000);
