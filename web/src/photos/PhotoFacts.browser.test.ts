import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserPath } from "../controls/browser-path.ts";
import { startBrowser } from "../controls/browser-start.ts";
import { findBrowserPage } from "../controls/browser-target.ts";

test("paginates flights, selects with the keyboard, and ignores stale responses", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aidm-facts-"));
  let requests = 0;
  let putBody = "";
  let releasePut: (() => void) | undefined;
  let release: (() => void) | undefined;
  let releaseDocument: (() => void) | undefined;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/") { response.writeHead(200, { "content-type": "text/html" }); response.write("<!doctype html><html><head>"); await new Promise<void>(resolve => { releaseDocument = resolve; }); response.end('</head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>'); return; }
    if (url.pathname === "/fixture.js") { response.setHeader("content-type", "text/javascript"); response.end(await readFile(join(directory, "fixture.js"))); return; }
    if (request.method === "PUT") { for await (const part of request) putBody += part; await new Promise<void>(resolve => { releasePut = resolve; }); response.writeHead(204); response.end(); return; }
    requests++;
    const id = url.pathname.split("/")[3];
    if (id === "2") await new Promise<void>(resolve => { release = resolve; });
    const second = url.searchParams.get("offset") === "50";
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ photoCount: id === "2" ? 999 : 3, photoBytes: 123, duplicates: 1, videoCount: 0, withoutGps: 3, cameras: [], bands: [], dateSpans: [], flights: second ? [{ id: "flight", make: "Camera", model: null, clock: "camera", first: "2024-01-01T10:00:00", last: "2024-01-01T10:01:00", photoCount: 3, excludedPhotoCount: 1 }] : [], flightCount: 51, unassignedCount: 3, pendingMetadata: id === "3" ? 1 : 0, nextOffset: second ? null : 50 }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test server address");
  let browser: Awaited<ReturnType<typeof startBrowser>> | undefined;
  let socket: WebSocket | undefined;
  try {
    const build = await Bun.build({ entrypoints: [new URL("./browser-fixture.tsx", import.meta.url).pathname], outdir: directory, naming: "fixture.js", target: "browser" });
    expect(build.success).toBe(true);
    browser = await startBrowser(await browserPath(), join(directory, "profile"), "about:blank");
    socket = new WebSocket((await findBrowserPage(Number(browser.port))).webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => { socket!.onopen = () => resolve(); socket!.onerror = () => reject(new Error("Browser connection failed")); });
    let id = 0;
    const pending = new Map<number, (message: any) => void>();
    socket.onmessage = event => { const message = JSON.parse(String(event.data)); if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id); } };
    const send = (method: string, params: object = {}) => new Promise<any>((resolve, reject) => { const requestId = ++id; const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 10000); pending.set(requestId, message => { clearTimeout(timer); if (message.error) reject(new Error(JSON.stringify(message.error))); else resolve(message.result); }); socket!.send(JSON.stringify({ id: requestId, method, params })); });
    const evaluate = async (expression: string) => { const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value; };
    const wait = (expression: string) => evaluate(`new Promise((resolve, reject) => { const end = Date.now() + 5000; const check = () => { if (${expression}) resolve(true); else if (Date.now() > end) reject(new Error('condition timed out')); else setTimeout(check, 20); }; check(); })`);
    await send("Page.navigate", { url: `http://127.0.0.1:${address.port}/` });
    expect(await evaluate("document.body === null")).toBe(true);
    const readiness = wait("document.body && document.body.textContent.includes('No capture dates found.')").then(() => null, error => error);
    await evaluate("true");
    expect(releaseDocument).toBeDefined();
    releaseDocument!();
    const readinessError = await readiness;
    if (readinessError) throw readinessError;
    await evaluate("Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Next').click()");
    await wait("document.body.textContent.includes('1 of 3 photos left out')");
    await evaluate("Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Leave all out').focus()");
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await send("Input.dispatchKeyEvent", { type: "char", text: "\r", unmodifiedText: "\r", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await new Promise<void>((resolve, reject) => { const end = Date.now() + 5000; const check = () => { if (putBody) resolve(); else if (Date.now() > end) reject(new Error("Selection request missing")); else setTimeout(check, 20); }; check(); });
    expect(putBody).toBe('{"excluded":true}');
    const beforeRefresh = requests;
    await evaluate("window.refreshFacts()");
    await new Promise<void>((resolve, reject) => { const end = Date.now() + 5000; const check = () => { if (requests > beforeRefresh) resolve(); else if (Date.now() > end) reject(new Error("Refresh request missing")); else setTimeout(check, 20); }; check(); });
    expect(releasePut).toBeDefined();
    releasePut!();
    await wait("Array.from(document.querySelectorAll('button')).some(button => button.textContent === 'Leave all out' && !button.disabled)");
    await evaluate("window.showFacts(2)");
    await new Promise<void>((resolve, reject) => { const end = Date.now() + 5000; const check = () => { if (release) resolve(); else if (Date.now() > end) reject(new Error("Delayed request missing")); else setTimeout(check, 20); }; check(); });
    await evaluate("window.showFacts(3)");
    await wait("document.body.textContent.includes('Reading metadata')");
    release!();
    await Bun.sleep(100);
    expect(await evaluate("document.body.textContent.includes('Photos: 999')")).toBe(false);
    await evaluate("window.hideFacts()");
    const before = requests;
    await Bun.sleep(1200);
    expect(requests).toBe(before);
  } finally {
    releasePut?.();
    release?.();
    releaseDocument?.();
    socket?.close();
    await browser?.stop();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
