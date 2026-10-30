import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserPath } from "../controls/browser-path.ts";
import { startBrowser } from "../controls/browser-start.ts";
import { findBrowserPage } from "../controls/browser-target.ts";

test("keyboard checks and removes a link without changing its URL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aidm-link-"));
  const fixture = await Bun.build({ entrypoints: [new URL("./browser-fixture.tsx", import.meta.url).pathname], target: "browser" });
  let stored: string | null = null;
  let puts = 0;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/") return new Response('<div id="root"></div><script type="module" src="/fixture.js"></script>', { headers: { "content-type": "text/html" } });
    if (path === "/fixture.js") return new Response(await fixture.outputs[0]!.text(), { headers: { "content-type": "text/javascript" } });
    if (path === "/api/projects/1/link") {
      if (request.method === "PUT") { stored = (await request.json() as { url: string }).url; puts++; }
      if (request.method === "DELETE") stored = null;
      return Response.json({ url: stored, size: request.method === "PUT" ? 1024 : null, facts: null, factsRunId: null });
    }
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
    await wait("document.querySelector('#link-url')");
    expect(puts).toBe(0);
    await evaluate("document.querySelector('#link-url').focus()");
    await send("Input.insertText", { text: "https://example.test/Photos.ZIP?token=A%2Fb" });
    await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
    await wait("document.body.textContent.includes('Remove link')");
    expect(stored as string | null).toBe("https://example.test/Photos.ZIP?token=A%2Fb");
    expect(await evaluate("document.body.textContent.includes('1 KiB')")).toBe(true);
    await evaluate("[...document.querySelectorAll('button')].find(button => button.textContent === 'Remove link').focus()");
    await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
    await wait("!document.body.textContent.includes('Remove link')");
    expect(stored).toBeNull();
  } finally { socket?.close(); await browser?.stop(); server.stop(true); await rm(directory, { recursive: true, force: true }); }
}, 30000);
