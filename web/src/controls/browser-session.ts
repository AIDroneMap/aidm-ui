import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserPath } from "./browser-path.ts";
import { startBrowser } from "./browser-start.ts";
import { findBrowserPage } from "./browser-target.ts";

const KEYS: Record<string, { code: string; keyCode: number }> = {
  Tab: { code: "Tab", keyCode: 9 },
  Enter: { code: "Enter", keyCode: 13 },
  Escape: { code: "Escape", keyCode: 27 },
  " ": { code: "Space", keyCode: 32 },
  End: { code: "End", keyCode: 35 },
  Home: { code: "Home", keyCode: 36 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
};

export type BrowserSession = {
  send: (method: string, params?: object) => Promise<any>;
  /** Runs an expression in the page and returns its value. A thrown error fails the call with the page's message. */
  evaluate: <T = unknown>(expression: string) => Promise<T>;
  /** Presses and releases one key, with Shift held when asked. */
  press: (key: keyof typeof KEYS, shift?: boolean) => Promise<void>;
  type: (text: string) => Promise<void>;
  close: () => Promise<void>;
};

/**
 * Builds one entry file for the browser, serves it with its styles on a
 * loopback port, and opens it in headless Chromium over the DevTools
 * protocol.
 */
export async function openBrowserSession(entry: string, viewport = { width: 1280, height: 900 }): Promise<BrowserSession> {
  const build = await Bun.build({ entrypoints: [entry], target: "browser" });
  if (!build.success) throw new Error(build.logs.join("\n"));
  const script = build.outputs.find((file) => file.path.endsWith(".js"));
  const style = build.outputs.find((file) => file.path.endsWith(".css"));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/") return new Response('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/page.css"><div id="root"></div><script type="module" src="/page.js"></script></html>', { headers: { "content-type": "text/html" } });
    const output = path === "/page.js" ? script : path === "/page.css" ? style : undefined;
    return output ? new Response(await output.arrayBuffer(), { headers: { "content-type": output.type } }) : new Response(null, { status: 404 });
  } });
  const directory = await mkdtemp(join(tmpdir(), "aidm-components-"));
  let browser: Awaited<ReturnType<typeof startBrowser>> | undefined;
  let socket: WebSocket | undefined;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const close = async () => {
    socket?.close();
    await browser?.stop();
    server.stop(true);
    await rm(directory, { recursive: true, force: true });
  };
  try {
    browser = await startBrowser(await browserPath(), directory, "about:blank");
    const opened = new WebSocket((await findBrowserPage(Number(browser.port))).webSocketDebuggerUrl);
    socket = opened;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Browser connection timed out")), 5000);
      opened.onopen = () => { clearTimeout(timer); resolve(); };
      opened.onerror = () => { clearTimeout(timer); reject(new Error("Browser connection failed")); };
    });
    opened.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      const request = pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer);
      pending.delete(message.id);
      if (message.error) request.reject(new Error(JSON.stringify(message.error))); else request.resolve(message.result);
    };
    let next = 0;
    const send = (method: string, params: object = {}) => new Promise<any>((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 10000);
      pending.set(id, { resolve, reject, timer });
      opened.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async <T,>(expression: string): Promise<T> => {
      const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails));
      return result.result.value as T;
    };
    const press = async (key: keyof typeof KEYS, shift = false) => {
      const { code, keyCode } = KEYS[key]!;
      const common = { key, code, windowsVirtualKeyCode: keyCode, modifiers: shift ? 8 : 0 };
      await send("Input.dispatchKeyEvent", { type: "keyDown", ...common, ...(key === "Enter" || key === " " ? { text: key === "Enter" ? "\r" : " " } : {}) });
      await send("Input.dispatchKeyEvent", { type: "keyUp", ...common });
    };
    const type = async (text: string) => { await send("Input.insertText", { text }); };
    await send("Page.enable");
    await send("Emulation.setDeviceMetricsOverride", { ...viewport, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: `http://127.0.0.1:${server.port}/` });
    const deadline = Date.now() + 10000;
    while (!(await evaluate<boolean>("document.readyState === 'complete' && document.querySelector('#root').childElementCount > 0").catch(() => false))) {
      if (Date.now() > deadline) throw new Error("The page did not render");
      await Bun.sleep(50);
    }
    return { send, evaluate, press, type, close };
  } catch (error) {
    const diagnostics = browser?.diagnostics() ?? "";
    await close();
    throw new Error(`${String(error)}${diagnostics ? `\nBrowser stderr:\n${diagnostics}` : ""}`);
  }
}
