import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserPath } from "../controls/browser-path.ts";
import { startBrowser } from "../controls/browser-start.ts";
import { findBrowserPage } from "../controls/browser-target.ts";

test("module worker hashes in a browser", async () => {
  const executable = await browserPath();
  const dir = await mkdtemp(join(tmpdir(), "aidm-upload-worker-"));
  let browser: Awaited<ReturnType<typeof startBrowser>> | undefined;
  let socket: WebSocket | undefined;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/") return new Response('<script type="module" src="/fixture.js"></script>', { headers: { "content-type": "text/html", "content-security-policy": "default-src 'none'; script-src 'self'; worker-src 'self'" } });
    if (path === "/fixture.js" || path === "/hash-worker.ts") return new Response(Bun.file(join(dir, path.slice(1))), { headers: { "content-type": "text/javascript" } });
    return new Response(null, { status: 404 });
  } });
  try {
    const fixture = join(dir, "fixture.ts");
    await writeFile(fixture, `import { hashInWorker } from ${JSON.stringify(new URL("./worker.ts", import.meta.url).pathname)};\nwindow.hashTest = () => hashInWorker(new Blob(["abc"]), new AbortController().signal);`);
    const first = await Bun.build({ entrypoints: [fixture], outdir: dir, naming: "fixture.js", target: "browser" });
    const second = await Bun.build({ entrypoints: [new URL("./hash-worker.ts", import.meta.url).pathname], outdir: dir, naming: "hash-worker.ts", target: "browser" });
    expect(first.success && second.success).toBe(true);
    browser = await startBrowser(executable, dir, "about:blank");
    const target = await findBrowserPage(Number(browser.port));
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("DevTools connection timed out")), 5000);
      socket!.onopen = () => { clearTimeout(timer); resolve(); };
      socket!.onerror = () => { clearTimeout(timer); reject(new Error("DevTools connection failed")); };
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Browser navigation timed out")), 10000);
      socket!.onmessage = event => {
        const message = JSON.parse(String(event.data));
        if (message.id === 2) socket!.send(JSON.stringify({ id: 3, method: "Page.navigate", params: { url: `http://127.0.0.1:${server.port}/` } }));
        if (message.method === "Page.loadEventFired") { clearTimeout(timer); resolve(); }
      };
      socket!.send(JSON.stringify({ id: 2, method: "Page.enable" }));
    });
    const result = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Browser worker test timed out")), 10000);
      socket!.onmessage = event => { const message = JSON.parse(String(event.data)); if (message.id === 1) { clearTimeout(timer); resolve(message); } };
      socket!.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "(async () => { while (!window.hashTest) await new Promise(r => setTimeout(r, 10)); return window.hashTest(); })()", awaitPromise: true, returnByValue: true } }));
    });
    expect(result.error).toBeUndefined();
    expect(result.result?.result?.value).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  } finally {
    socket?.close();
    await browser?.stop();
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);
