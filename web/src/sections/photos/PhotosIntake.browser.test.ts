import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { openHarness } from "../../../../server/testing/harness.ts";
import { assetsFromFolder } from "../../../../server/http/static-assets.ts";
import { browserPath } from "../../controls/browser-path.ts";
import { startBrowser } from "../../controls/browser-start.ts";
import { findBrowserPage } from "../../controls/browser-target.ts";

const KEYS = { Tab: 9, Enter: 13, " ": 32 } as const;

/** The interface's own entry file, as the server serves it. The hash worker is built beside it, where the page looks for it. */
async function buildInterface(folder: string) {
  const build = await Bun.build({ entrypoints: [new URL("../../main.tsx", import.meta.url).pathname], target: "browser", plugins: [{ name: "asset-urls", setup(builder) {
    builder.onResolve({ filter: /\?url$/ }, (args) => ({ path: args.path, namespace: "asset-url" }));
    builder.onLoad({ filter: /.*/, namespace: "asset-url" }, (args) => ({ contents: `export default ${JSON.stringify(`/assets/${args.path.split("/").pop()!.replace("?url", "")}`)}`, loader: "js" }));
  } }] });
  const worker = await Bun.build({ entrypoints: [new URL("../../upload/hash-worker.ts", import.meta.url).pathname], target: "browser" });
  if (!build.success || !worker.success) throw new Error([...build.logs, ...worker.logs].join("\n"));
  await mkdir(join(folder, "assets"));
  for (const output of build.outputs) {
    if (output.path.endsWith(".css")) await Bun.write(join(folder, "app.css"), output);
    else await Bun.write(join(folder, "app.js"), (await output.text()).replaceAll("./hash-worker.ts", "/assets/hash-worker.js"));
  }
  await Bun.write(join(folder, "assets", "hash-worker.js"), worker.outputs[0]!);
  await Bun.write(join(folder, "index.html"), '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"><div id="root"></div><script type="module" src="/app.js"></script></html>');
  return assetsFromFolder(folder);
}

type Paused = { requestId: string; session: string };

/**
 * The Photos section on the production entry and the production upload routes. The only thing the test adds is a
 * hold on the chunk requests in the browser, so that "in flight" and "queued" are states it can wait for.
 */
async function withPhotos(body: (page: Page) => Promise<void>, remote = false) {
  const folder = await mkdtemp(join(tmpdir(), "aidm-photos-intake-"));
  const publicFiles = join(folder, "public");
  await mkdir(publicFiles); await mkdir(join(folder, "data"));
  const h = openHarness({ hostname: remote ? "0.0.0.0" : "127.0.0.1", dataFolder: join(folder, "data"), assets: await buildInterface(publicFiles) });
  h.settings.set("wizard.completed", true);
  let browser: Awaited<ReturnType<typeof startBrowser>> | undefined, socket: WebSocket | undefined;
  const waiting = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: Timer }>();
  try {
    const project = await (await fetch(`${h.base}/api/projects`, { method: "POST", body: JSON.stringify({ name: "Vineyard north", notes: "" }) })).json() as { id: number };
    let executable = await browserPath();
    if (remote) {
      const address = Object.values(networkInterfaces()).flat().find(item => item && item.family === "IPv4" && !item.internal)?.address;
      if (!address) throw Error("No non-loopback address for the remote-browser test");
      const wrapper = join(folder, "browser");
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
      await writeFile(wrapper, `#!/bin/sh\nexec ${quote(executable)} "$@" ${quote(`--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE ${address}`)}\n`, { mode: 0o700 });
      executable = wrapper;
    }
    browser = await startBrowser(executable, join(folder, "profile"), "about:blank");
    socket = new WebSocket((await findBrowserPage(Number(browser.port))).webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => { socket!.onopen = () => resolve(); socket!.onerror = () => reject(new Error("browser connection")); });
    const hold = { on: false, failNext: false, paused: [] as Paused[], failed: [] as string[] };
    let next = 0;
    const send = (method: string, params: object = {}) => new Promise<any>((resolve, reject) => {
      const id = ++next, timer = setTimeout(() => { waiting.delete(id); reject(new Error(`${method} timeout`)); }, 10000);
      waiting.set(id, { resolve, reject, timer });
      socket!.send(JSON.stringify({ id, method, params }));
    });
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.method === "Fetch.requestPaused") {
        const requestId = message.params.requestId as string, session = /\/uploads\/([a-f0-9]{32})\/chunks\//.exec(message.params.request.url)?.[1] ?? "";
        if (hold.failNext) {
          hold.failNext = false; hold.failed.push(session);
          void send("Fetch.fulfillRequest", { requestId, responseCode: 500, responseHeaders: [{ name: "content-type", value: "application/json" }], body: btoa(JSON.stringify({ error: { code: "server.internal_error", data: {} } })) }).catch(() => {});
        } else if (hold.on) hold.paused.push({ requestId, session });
        else void send("Fetch.continueRequest", { requestId }).catch(() => {});
        return;
      }
      const item = waiting.get(message.id); if (!item) return;
      waiting.delete(message.id); clearTimeout(item.timer);
      message.error ? item.reject(new Error(JSON.stringify(message.error))) : item.resolve(message.result);
    };
    const evaluate = async <T = unknown>(expression: string): Promise<T> => {
      const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails));
      return result.result.value as T;
    };
    const wait = async (condition: string, ms = 8000) => {
      try { await evaluate(`new Promise((resolve, reject) => { const end = Date.now() + ${ms}; const tick = () => (${condition}) ? resolve(true) : Date.now() > end ? reject(Error("timeout")) : setTimeout(tick, 20); tick(); })`); }
      catch { throw new Error(`Waiting for ${condition}: ${await evaluate("document.body.innerText")}`); }
    };
    const key = async (name: keyof typeof KEYS) => {
      const common = { key: name, code: name === " " ? "Space" : name, windowsVirtualKeyCode: KEYS[name] };
      await send("Input.dispatchKeyEvent", { type: "keyDown", ...common, ...(name === "Enter" ? { text: "\r" } : name === " " ? { text: " " } : {}) });
      await send("Input.dispatchKeyEvent", { type: "keyUp", ...common });
    };
    const button = (label: string) => `[...document.querySelectorAll('main button')].find(element => element.textContent === ${JSON.stringify(label)})`;
    const choose = async (paths: string[]) => {
      const root = (await send("DOM.getDocument")).root.nodeId;
      const nodeId = (await send("DOM.querySelector", { nodeId: root, selector: ".drop-zone input[type=file]" })).nodeId;
      expect(nodeId).toBeGreaterThan(0);
      await send("DOM.setFileInputFiles", { nodeId, files: paths });
    };
    const release = async () => {
      hold.on = false;
      for (const item of hold.paused.splice(0)) await send("Fetch.continueRequest", { requestId: item.requestId }).catch(() => {});
    };
    const files = async (name: string, count: number) => {
      const paths: string[] = [];
      for (let index = 1; index <= count; index++) {
        const path = join(folder, `${name}-${index}.jpg`);
        await writeFile(path, Buffer.alloc(64 * 1024, name.length * 10 + index));
        paths.push(path);
      }
      return paths;
    };
    const stored = (path: string) => fetch(`${h.base}/api/projects/${project.id}${path}`);
    const arrivedOnServer = async () => ((await (await stored("/photos?offset=0&limit=100")).json()) as { files: unknown[] }).files.length;
    await send("Page.enable"); await send("Fetch.enable", { patterns: [{ urlPattern: "*/uploads/*/chunks/*", requestStage: "Request" }] });
    let base = h.base;
    if (remote) {
      const address = Object.values(networkInterfaces()).flat().find(item => item && item.family === "IPv4" && !item.internal)?.address;
      if (!address) throw Error("No non-loopback address for the remote-browser test");
      base = `http://${address}:${h.port}`;
      const passphrase = "photos-remote-test";
      expect((await fetch(h.base + "/api/settings/lan", { method: "PUT", body: JSON.stringify({ enabled: true, passphrase }) })).status).toBe(200);
      const login = await fetch(base + "/api/auth/login", { method: "POST", body: JSON.stringify({ passphrase }) });
      const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
      const separator = cookie.indexOf("=");
      await send("Network.setCookie", { name: cookie.slice(0, separator), value: cookie.slice(separator + 1), url: base });
    }
    await send("Page.navigate", { url: `${base}/#/projects/${project.id}/photos` });
    await body({ evaluate, wait, key, button, choose, release, files, stored, arrivedOnServer, hold, folder, projectId: project.id });
  } finally {
    for (const item of waiting.values()) { clearTimeout(item.timer); item.reject(new Error("test finished")); }
    socket?.close(); await browser?.stop(); await h.stop(); await rm(folder, { recursive: true, force: true });
  }
}
type Page = {
  evaluate<T = unknown>(expression: string): Promise<T>;
  wait(condition: string, ms?: number): Promise<void>;
  key(name: keyof typeof KEYS): Promise<void>;
  button(label: string): string;
  choose(paths: string[]): Promise<void>;
  release(): Promise<void>;
  files(name: string, count: number): Promise<string[]>;
  stored(path: string): Promise<Response>;
  arrivedOnServer(): Promise<number>;
  hold: { on: boolean; failNext: boolean; paused: Paused[]; failed: string[] };
  folder: string;
  projectId: number;
};

const text = "document.querySelector('main').innerText";

test("Pause holds the files that have not started, Resume sends them, and a second batch can be added", async () => {
  await withPhotos(async (page) => {
    const { evaluate, wait, hold } = page;
    await wait("document.querySelector('.drop-zone')");
    const empty = await evaluate<string>(text);
    expect(empty).toContain("Add the photos of your flight");
    for (const card of ["Drop or choose files", "Give the address of a ZIP file"]) expect(empty).toContain(card);
    // The browser and the server share a machine here, so the folder is offered; no other way in is.
    expect(empty).toContain("Use a folder on this computer");

    hold.on = true;
    await page.choose(await page.files("first", 6));
    await wait("document.querySelectorAll('progress').length === 1");
    for (let waited = 0; hold.paused.length < 2 && waited < 8000; waited += 20) await Bun.sleep(20);
    expect(hold.paused.length).toBe(2);
    expect(await evaluate<string>(text)).toContain("Arrived: 0");
    expect(await evaluate<string>(text)).toContain("Files remaining: 6");
    // The folder and the address are not offered once files are on their way: the server would refuse them.
    expect(await evaluate<string>(text)).not.toContain("Use a folder on this computer");
    expect(await evaluate<string>(text)).not.toContain("Give the address of a ZIP file");

    // Pause with the keyboard.
    await evaluate(`${page.button("Pause")}.focus(); true`);
    await page.key(" ");
    await wait(`${page.button("Resume")} !== undefined`);
    expect(await evaluate<string>(text)).toContain("Files already on their way will finish");

    // The two in flight finish; nothing else starts while paused.
    await page.release();
    await wait(`${text}.includes('Arrived: 2')`);
    expect(await evaluate<string>(text)).toContain("Files remaining: 4");
    await Bun.sleep(400);
    expect(await page.arrivedOnServer()).toBe(2);
    expect(hold.paused.length).toBe(0);
    expect(await evaluate<string>(text)).toContain("Arrived: 2");

    await evaluate(`${page.button("Resume")}.click(); true`);
    await wait("!document.querySelector('progress')");
    await wait(`${text}.includes('Photos arrived: 6')`);
    expect(await page.arrivedOnServer()).toBe(6);
    expect(await evaluate<boolean>(`${page.button("Add more photos")} !== undefined`)).toBe(true);
    // Ready is one line: no drop zone and no list of files until the operator asks for more.
    expect(await evaluate("document.querySelector('.drop-zone')")).toBeNull();
    expect(await evaluate("document.querySelector('main table')")).toBeNull();

    await evaluate(`${page.button("Add more photos")}.click(); true`);
    await wait("document.querySelector('.drop-zone')");
    expect(await evaluate<string>(text)).not.toContain("Give the address of a ZIP file");
    await page.choose(await page.files("second", 1));
    await wait(`${text}.includes('Photos arrived: 7')`);
    expect(await page.arrivedOnServer()).toBe(7);
  });
}, 90000);

test("Cancel stops everything, removes the uploads it was making and keeps a failed one for a retry", async () => {
  await withPhotos(async (page) => {
    const { evaluate, wait, hold } = page;
    await wait("document.querySelector('.drop-zone')");
    hold.on = true; hold.failNext = true;
    await page.choose(await page.files("flight", 4));
    // One file fails at once; the two next in line are in flight and held; the fourth waits in the queue.
    for (let waited = 0; (hold.paused.length < 2 || hold.failed.length < 1) && waited < 8000; waited += 20) await Bun.sleep(20);
    expect(hold.failed.length).toBe(1);
    expect(hold.paused.length).toBe(2);
    await wait("document.querySelector('main [role=alert]')");
    const inFlight = hold.paused.map(item => item.session);
    expect(await evaluate<string>(text)).toContain("Files remaining: 3");

    await evaluate(`${page.button("Cancel")}.click(); true`);
    await wait("!document.querySelector('progress')");
    await Bun.sleep(300);
    // Only the failed file's upload is left, on the server and in the page, and it is offered again.
    for (const session of inFlight) expect((await page.stored(`/uploads/${session}`)).status).toBe(404);
    expect((await page.stored(`/uploads/${hold.failed[0]}`)).status).toBe(200);
    expect(await evaluate<number>("JSON.parse(localStorage.getItem('aidm.pendingUploads') ?? '[]').length")).toBe(1);
    expect(await evaluate<number>("document.querySelectorAll('main input[type=file]:not(.visually-hidden)').length")).toBe(1);
    expect(await page.arrivedOnServer()).toBe(0);
    expect(hold.paused.length).toBe(2);

    // Retry sends the one that was kept, from the file the page still holds.
    await page.release();
    await evaluate(`[...document.querySelectorAll('main button')].find(element => element.textContent.startsWith('Retry '))?.click(); true`);
    await wait(`${text}.includes('Photos arrived: 1')`);
    expect(await page.arrivedOnServer()).toBe(1);
    expect(await evaluate<number>("JSON.parse(localStorage.getItem('aidm.pendingUploads') ?? '[]').length")).toBe(0);
  });
}, 90000);

const lanAddress = Object.values(networkInterfaces()).flat().some(item => item && item.family === "IPv4" && !item.internal);
test.skipIf(!lanAddress)("a browser connecting from the network sees files and ZIP intake with no local-folder way in", async () => {
  await withPhotos(async ({ evaluate, wait }) => {
    await wait("document.querySelector('.drop-zone-title')?.textContent === 'Add the photos of your flight'");
    expect(await evaluate(text)).toContain("Drop or choose files");
    expect(await evaluate(text)).toContain("Give the address of a ZIP file");
    expect(await evaluate(text)).not.toContain("Use a folder on this computer");
    expect(await evaluate("document.querySelector('#photos-intake-path')")).toBeNull();
  }, true);
}, 30000);
