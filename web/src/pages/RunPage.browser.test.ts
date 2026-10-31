import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserPath } from "../controls/browser-path.ts";
import { startBrowser } from "../controls/browser-start.ts";
import { findBrowserPage } from "../controls/browser-target.ts";

test("project archive links open the requested run, including after a reload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aidm-run-page-"));
  const requests: string[] = [];
  const build = await Bun.build({ entrypoints: [new URL("./run-browser-fixture.tsx", import.meta.url).pathname], target: "browser", plugins: [{ name: "viewer-assets", setup(builder) {
    builder.onResolve({ filter: /draco_(wasm_wrapper\.js|decoder\.wasm)\?url$/ }, args => ({ path: args.path, namespace: "decoder-assets" }));
    builder.onLoad({ filter: /.*/, namespace: "decoder-assets" }, args => ({ contents: `export default ${JSON.stringify(`/decoder/${args.path.includes("wrapper") ? "draco_wasm_wrapper.js" : "draco_decoder.wasm"}`)}`, loader: "js" }));
    builder.onResolve({ filter: /maplibre-gl-worker\.mjs\?url$/ }, () => ({ path: "worker-url", namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: 'export default "/map-worker.mjs"', loader: "js" }));
  } }] });
  expect(build.success).toBe(true);
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const path = new URL(request.url).pathname;
    requests.push(path);
    if (path === "/") return new Response('<div id="root"></div><script type="module" src="/fixture.js"></script>', { headers: { "content-type": "text/html" } });
    if (path === "/fixture.js") return new Response(await build.outputs[0]!.text(), { headers: { "content-type": "text/javascript" } });
    if (path === "/api/auth/session") return Response.json({ passphraseRequired: false });
    if (path === "/api/wizard") return Response.json({ completed: true });
    if (path === "/api/projects/1/runs") return Response.json({ runs: [], nextOffset: null });
    if (path === "/api/projects/1") return Response.json({ id: 1, name: "Sample", notes: "", builtin: "sample", photoCount: 0, runCount: 2, latestState: "completed", lastChange: "2026-10-26T10:00:00Z", resultsBytes: 3072, resultArchives: [{ runId: 7, size: 1024 }, { runId: 8, size: 2048 }] });
    if (path === "/api/runs/9") return Response.json({ error: { code: "run.not_found", data: {} } }, { status: 404 });
    if (/^\/api\/runs\/[78]$/.test(path)) {
      const id = Number(path.split("/").at(-1));
      return Response.json({ id, projectId: 1, engineId: 1, createdAt: "2026-10-26T10:00:00Z", name: `Flight ${id}`, preset: null, wayIn: null, sample: false, engineName: null, engineLocal: false, state: "completed", step: null, download: null, upload: null, progress: null, engineMessage: null, problem: null, restarted: false, restartedAtLine: null, resultsAvailable: true, results: { state: "ready", archiveSize: id === 7 ? 1024 : 2048, outputs: id === 7 ? [{ name: "glb", size: 512 }] : [{ name: "orthophoto", size: 512 }] } });
    }
    if (path.endsWith("/log")) return Response.json({ lines: [], next: 0, restartedAtLine: null });
    if (path.endsWith("/events")) return new Response("", { headers: { "content-type": "text/event-stream" } });
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
    const evaluate = async (expression: string) => { const answer = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (answer.result.exceptionDetails) throw new Error(JSON.stringify(answer.result.exceptionDetails)); return answer.result.result.value; };
    const wait = async (expression: string) => {
      try { return await evaluate(`new Promise((resolve, reject) => { const end = Date.now() + 3000; const check = () => ${expression} ? resolve(true) : Date.now() > end ? reject(new Error('condition timed out')) : setTimeout(check, 20); check(); })`); }
      catch (error) { throw new Error(`Waiting for ${expression}: ${JSON.stringify(requests)} ${await evaluate("document.body.innerText")}`, { cause: error }); }
    };
    await send("Page.navigate", { url: `http://127.0.0.1:${server.port}/#/projects/1` });
    await wait("document.querySelector('a[href=\"#/runs/7\"]')");
    await evaluate("document.querySelector('a[href=\"#/runs/7\"]').click()");
    await wait("document.body.textContent.includes('Flight 7')");
    expect(await evaluate("document.querySelector('a[href=\"/api/runs/7/outputs/glb\"]') !== null")).toBe(true);
    expect(await evaluate("document.querySelector('a[href=\"#/projects/1\"]')?.textContent")).toBe("Back to project");
    expect(await evaluate("!document.body.textContent.includes('Start again')")).toBe(true);
    expect(requests).toContain("/api/runs/7");
    expect(await evaluate("Array.from(document.querySelectorAll('button')).some(button => button.textContent === 'Open the 3D model')")).toBe(true);
    await evaluate("location.hash = '#/runs/8'");
    await wait("document.body.textContent.includes('Flight 8')");
    expect(await evaluate("!document.body.textContent.includes('Flight 7')")).toBe(true);
    expect(await evaluate("!Array.from(document.querySelectorAll('button')).some(button => button.textContent === 'Open the 3D model')")).toBe(true);
    await send("Page.reload");
    await wait("document.body.textContent.includes('Flight 8')");
    expect(requests.filter(path => path === "/api/runs/8").length).toBeGreaterThanOrEqual(2);
    await evaluate("location.hash = '#/runs/9'");
    await wait("document.querySelector('[role=alert]')?.textContent.includes('could not find that run')");
    expect(await evaluate("!document.body.textContent.includes('Flight 8')")).toBe(true);
  } finally {
    socket?.close(); await browser?.stop(); server.stop(true); await rm(directory, { recursive: true, force: true });
  }
}, 30000);
