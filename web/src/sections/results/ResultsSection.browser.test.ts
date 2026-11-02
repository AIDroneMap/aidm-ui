import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserPath } from "../../controls/browser-path.ts";
import { startBrowser } from "../../controls/browser-start.ts";
import { findBrowserPage } from "../../controls/browser-target.ts";

// The results are deleted from the Results section, or from the run's own page before the operator goes back to Results.
for (const start of ["the Results section", "the run page"] as const) test(`deleting a run's results from ${start} takes it off the Results list, the sidebar count and the Details storage`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "aidm-results-section-"));
  const build = await Bun.build({ entrypoints: [new URL("../../pages/run-browser-fixture.tsx", import.meta.url).pathname], target: "browser", plugins: [{ name: "viewer-assets", setup(builder) {
    builder.onResolve({ filter: /\?url$/ }, (args) => ({ path: args.path, namespace: "asset-url" }));
    builder.onLoad({ filter: /.*/, namespace: "asset-url" }, () => ({ contents: 'export default "/asset"', loader: "js" }));
  } }] });
  expect(build.success).toBe(true);
  let deleted = false;
  const project = () => ({ id: 1, name: "Vineyard north", notes: "", builtin: null, photoCount: 3, runCount: 1, latestState: "completed", lastChange: "2026-11-01T10:00:00Z", resultsBytes: deleted ? 0 : 1024, resultArchives: deleted ? [] : [{ runId: 7, size: 1024 }] });
  const run = () => ({ id: 7, projectId: 1, engineId: 1, createdAt: "2026-11-01T10:00:00Z", name: "Flight 7", preset: null, wayIn: null, sample: false, engineName: null, engineLocal: false, state: "completed", step: null, download: null, upload: null, progress: null, engineMessage: null, problem: null, restarted: false, restartedAtLine: null, resultsAvailable: !deleted, results: deleted ? { state: "deleted", archiveSize: null, outputs: [] } : { state: "ready", archiveSize: 1024, outputs: [{ name: "orthophoto", size: 512 }] } });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/") return new Response('<div id="root"></div><script type="module" src="/fixture.js"></script>', { headers: { "content-type": "text/html" } });
    if (path === "/fixture.js") return new Response(await build.outputs[0]!.text(), { headers: { "content-type": "text/javascript" } });
    if (path === "/api/auth/session") return Response.json({ passphraseRequired: false });
    if (path === "/api/wizard") return Response.json({ completed: true });
    if (path === "/api/projects/1") return Response.json(project());
    if (path === "/api/runs/7/results" && request.method === "DELETE") { deleted = true; return new Response(null, { status: 204 }); }
    if (path === "/api/runs/7") return Response.json(run());
    if (path.endsWith("/events")) return new Response("", { headers: { "content-type": "text/event-stream" } });
    return new Response(null, { status: 404 });
  } });
  let browser: Awaited<ReturnType<typeof startBrowser>> | undefined;
  let socket: WebSocket | undefined;
  try {
    browser = await startBrowser(await browserPath(), directory, "about:blank");
    socket = new WebSocket((await findBrowserPage(Number(browser.port))).webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => { socket!.onopen = () => resolve(); socket!.onerror = () => reject(new Error("Browser connection failed")); });
    let id = 0; const pending = new Map<number, (value: any) => void>();
    socket.onmessage = (event) => { const message = JSON.parse(String(event.data)); if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id); } };
    const send = (method: string, params: object = {}) => new Promise<any>((resolve) => { const next = ++id; pending.set(next, resolve); socket!.send(JSON.stringify({ id: next, method, params })); });
    const evaluate = async (expression: string) => { const answer = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (answer.result.exceptionDetails) throw new Error(JSON.stringify(answer.result.exceptionDetails)); return answer.result.result.value; };
    const wait = async (expression: string) => {
      try { return await evaluate(`new Promise((resolve, reject) => { const end = Date.now() + 5000; const check = () => ${expression} ? resolve(true) : Date.now() > end ? reject(new Error('timeout')) : setTimeout(check, 20); check(); })`); }
      catch { throw new Error(`Waiting for ${expression}: ${await evaluate("document.body.innerText")}`); }
    };
    const deleteButton = "[...document.querySelectorAll('main button')].find(element => element.textContent === 'Delete results')";
    const sidebarResults = "document.querySelector('nav.sidebar a[href=\"#/projects/1/results\"]')?.textContent ?? ''";

    await send("Page.navigate", { url: `http://127.0.0.1:${server.port}/#/projects/1/results` });
    await wait("document.querySelector('main a[href=\"#/projects/1/results/7\"]')");
    expect(await evaluate(sidebarResults)).toContain("Runs with results: 1");
    if (start === "the Results section") await evaluate("document.querySelector('main a[href=\"#/projects/1/results/7\"]').click(); true");
    else await evaluate("location.hash = '#/runs/7'; true");
    await wait(deleteButton);
    await evaluate(`${deleteButton}.click(); true`);
    await wait("document.querySelector('dialog[open]')");
    await evaluate("[...document.querySelectorAll('dialog[open] button')].find(element => element.textContent === 'Delete results and 1 KiB').click(); true");
    await wait("document.body.textContent.includes('Results deleted.')");
    expect(deleted).toBe(true);
    if (start === "the Results section") {
      await wait(`!(${sidebarResults}).includes('Runs with results')`);
      await evaluate("document.querySelector('main a[href=\"#/projects/1/results\"]').click(); true");
    } else {
      await evaluate("document.querySelector('nav.sidebar a[href=\"#/projects/1/results\"]').click(); true");
      await wait(`!(${sidebarResults}).includes('Runs with results')`);
    }
    await wait("document.querySelector('main .empty-state')");
    expect(await evaluate("document.querySelector('main a[href=\"#/projects/1/results/7\"]')")).toBeNull();
    await evaluate("location.hash = '#/projects/1/details'; true");
    await wait("document.querySelector('main h1')?.textContent === 'Details'");
    expect(await evaluate("document.querySelector('main a[href=\"#/runs/7\"]')")).toBeNull();
  } finally {
    socket?.close(); await browser?.stop(); server.stop(true); await rm(directory, { recursive: true, force: true });
  }
}, 30000);
