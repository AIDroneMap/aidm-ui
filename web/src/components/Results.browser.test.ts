import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserPath } from "../controls/browser-path.ts";
import { startBrowser } from "../controls/browser-start.ts";
import { findBrowserPage } from "../controls/browser-target.ts";

test("retry follows results to readiness and deletion requires confirmation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aidm-results-page-"));
  const requests: string[] = [];
  const run = { id: 7, projectId: 1, engineId: 1, createdAt: "2026-10-26T10:00:00Z", name: null, preset: null, wayIn: null, sample: false, engineName: null, engineLocal: false, state: "completed", step: null as string | null, download: null, upload: null, progress: null, engineMessage: null, problem: null, restarted: false, restartedAtLine: null, resultsAvailable: false, results: { state: "failed", archiveSize: null as number | null, outputs: [] as { name: string; size: number }[] } };
  const build = await Bun.build({ entrypoints: [new URL("./results-browser-fixture.tsx", import.meta.url).pathname], target: "browser" });
  expect(build.success).toBe(true);
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const path = new URL(request.url).pathname;
    requests.push(`${request.method} ${path}`);
    if (path === "/") return new Response('<div id="root"></div><script src="/fixture.js"></script>', { headers: { "content-type": "text/html" } });
    if (path === "/fixture.js") return new Response(await build.outputs[0]!.text(), { headers: { "content-type": "text/javascript" } });
    if (path === "/api/runs/7/results" && request.method === "POST") { run.step = "results"; run.results.state = "fetching"; return Response.json({}); }
    if (path === "/api/runs/7/results" && request.method === "DELETE") { run.results = { state: "deleted", archiveSize: null, outputs: [] }; run.resultsAvailable = false; return Response.json({}); }
    if (path === "/api/runs/7/events") {
      run.step = null; run.results = { state: "ready", archiveSize: 2048, outputs: [{ name: "glb", size: 512 }] }; run.resultsAvailable = true;
      return new Response(`event: run\ndata: ${JSON.stringify(run)}\n\n`, { headers: { "content-type": "text/event-stream" } });
    }
    if (path === "/api/runs/7") return Response.json(run);
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
    const wait = async (expression: string) => evaluate(`new Promise((resolve, reject) => { const end = Date.now() + 10000; const check = () => ${expression} ? resolve(true) : Date.now() > end ? reject(new Error('condition timed out')) : setTimeout(check, 20); check(); })`);
    await send("Page.navigate", { url: `http://127.0.0.1:${server.port}/` });
    await wait("document.body.textContent.includes('Try fetching results again')");
    await evaluate("Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Try fetching results again').click()");
    await wait("document.body.textContent.includes('3D model (GLB)')");
    expect(requests).toContain("POST /api/runs/7/results");
    await evaluate("Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Delete results').click()");
    await wait("document.querySelector('dialog')?.open");
    expect(requests).not.toContain("DELETE /api/runs/7/results");
    await evaluate("document.querySelector('dialog button:last-child').click()");
    await wait("document.body.textContent.includes('Results deleted')");
    expect(requests).toContain("DELETE /api/runs/7/results");
    expect(requests.filter(value => value === "GET /api/runs/7").length).toBe(2);
  } finally {
    socket?.close(); await browser?.stop(); server.stop(true); await rm(directory, { recursive: true, force: true });
  }
}, 30000);
