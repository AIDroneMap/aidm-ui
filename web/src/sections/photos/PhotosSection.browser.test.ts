import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHarness } from "../../../../server/testing/harness.ts";
import { assetsFromFolder } from "../../../../server/http/static-assets.ts";
import { detailedTiff, jpeg } from "../../../../test-support/photo-metadata.ts";
import { browserPath } from "../../controls/browser-path.ts";
import { startBrowser } from "../../controls/browser-start.ts";
import { findBrowserPage } from "../../controls/browser-target.ts";

/** Builds the production entry and ships the map worker beside it. */
export async function photosAssets(folder: string) {
  const built = await Bun.build({ entrypoints: [new URL("../../main.tsx", import.meta.url).pathname], target: "browser", plugins: [{ name: "asset-urls", setup(builder) {
    builder.onResolve({ filter: /\?url$/ }, args => ({ path: args.path, namespace: "asset-url" }));
    builder.onLoad({ filter: /.*/, namespace: "asset-url" }, args => ({ contents: `export default ${JSON.stringify(`/assets/${args.path.split("/").pop()!.replace("?url", "")}`)}`, loader: "js" }));
  } }] });
  if (!built.success) throw new Error(built.logs.join("\n"));
  for (const output of built.outputs) await Bun.write(join(folder, output.path.endsWith(".css") ? "app.css" : "app.js"), output.path.endsWith(".css") ? output : (await output.text()).replaceAll("./hash-worker.ts", "/assets/hash-worker.js"));
  const worker = await Bun.build({ entrypoints: [new URL("../../upload/hash-worker.ts", import.meta.url).pathname], target: "browser" });
  if (!worker.success) throw Error(worker.logs.join("\n"));
  await Bun.write(join(folder, "assets/hash-worker.js"), worker.outputs[0]!);
  await Bun.write(join(folder, "assets/maplibre-gl-worker.mjs"), Bun.file(new URL("../../../../node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs", import.meta.url)));
  await Bun.write(join(folder, "index.html"), '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><div id="root"></div><script type="module" src="/app.js"></script></html>');
  return assetsFromFolder(folder);
}

test("Photos takes dropped files through arrival to the grid, positions and keyboard flight selection in both themes", async () => {
  const folder = await mkdtemp(join(tmpdir(), "aidm-photos-journey-"));
  const publicFiles = join(folder, "public"); await mkdir(publicFiles); await mkdir(join(folder, "data"));
  const h = openHarness({ dataFolder: join(folder, "data"), assets: await photosAssets(publicFiles) });
  h.settings.set("wizard.completed", true);
  let browser: Awaited<ReturnType<typeof startBrowser>> | undefined, socket: WebSocket | undefined;
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: Timer }>();
  const requests: string[] = [];
  try {
    browser = await startBrowser(await browserPath(), join(folder, "profile"), "about:blank");
    socket = new WebSocket((await findBrowserPage(Number(browser.port))).webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => { socket!.onopen = () => resolve(); socket!.onerror = () => reject(Error("Browser connection failed")); });
    let next = 0;
    socket.onmessage = event => {
      const message = JSON.parse(String(event.data));
      if (message.method === "Network.requestWillBeSent") requests.push(message.params.request.url);
      const item = pending.get(message.id); if (!item) return;
      pending.delete(message.id); clearTimeout(item.timer);
      message.error ? item.reject(Error(JSON.stringify(message.error))) : item.resolve(message.result);
    };
    const send = (method: string, params: object = {}) => new Promise<any>((resolve, reject) => { const id = ++next; const timer = setTimeout(() => { pending.delete(id); reject(Error(`${method} timeout`)); }, 10000); pending.set(id, { resolve, reject, timer }); socket!.send(JSON.stringify({ id, method, params })); });
    const evaluate = async <T = unknown>(expression: string): Promise<T> => { const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails)); return result.result.value; };
    const wait = async (condition: string) => {
      try { await evaluate(`new Promise((resolve,reject) => { const end=Date.now()+8000; const check=()=>(${condition})?resolve(true):Date.now()>end?reject(Error('timeout')):setTimeout(check,20);check(); })`); }
      catch { throw Error(`Waiting for ${condition}: ${await evaluate("document.body.innerText")}`); }
    };
    await send("Page.enable"); await send("Network.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    for (const theme of ["light", "dark"]) {
      await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
      const created = await fetch(h.base + "/api/projects", { method: "POST", body: JSON.stringify({ name: `Flight ${theme}`, notes: "" }) });
      const project = await created.json() as { id: number };
      await send("Page.navigate", { url: `${h.base}/#/projects/${project.id}/photos` });
      await wait("document.querySelector('.drop-zone-title')?.textContent === 'Add the photos of your flight'");
      expect(await evaluate("document.querySelector('main').textContent")).toContain("Use a folder on this computer");
      const first = detailedTiff(true), second = detailedTiff(true);
      second.write("2024:02:29 13:34:56\0", 310);
      const selections = [{ name: "first.tif", bytes: [...first] }, { name: "copy.tif", bytes: [...first] }, { name: "later.tif", bytes: [...second] }, { name: "no-gps.jpg", bytes: [...jpeg()] }];
      await evaluate(`(() => { const data=new DataTransfer(); for(const file of ${JSON.stringify(selections)}) data.items.add(new File([new Uint8Array(file.bytes)],file.name)); document.querySelector('.drop-zone').dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:data})); return true; })()`);
      await wait("document.querySelector('.thumbnail-grid')?.children.length === 3 && document.querySelectorAll('.timeline-row').length === 2");
      await wait("document.querySelectorAll('.thumbnail-none').length === 3");
      await wait("document.querySelector('canvas[aria-label=\"Photo positions\"]') && document.body.textContent.includes('Without GPS: 1')");
      expect(await evaluate("document.querySelector('main').textContent")).toContain("Add more photos");
      expect(await evaluate("document.querySelector('main').textContent")).toContain("Acme");
      expect(await evaluate("document.querySelectorAll('.timeline-more').length")).toBe(2);
      await evaluate("[...document.querySelectorAll('summary')].find(s => s.textContent === 'Show names').click(); true");
      await wait("document.querySelector('.photo-duplicate-names')?.textContent.includes('first.tif')");
      expect(await evaluate("document.querySelector('.photo-duplicate-names').textContent")).not.toContain('copy.tif');
      // Tab, then Space on the native switch, changes which photos the next run includes.
      await evaluate("document.querySelector('.timeline input[role=switch]').focus(); true");
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
      await wait("!document.querySelector('.timeline input[role=switch]').checked && document.querySelector('.timeline-row.timeline-muted')");
      await wait("document.querySelector('.thumbnail-grid').textContent.includes('Left out')");
      const positions = await (await fetch(`${h.base}/api/projects/${project.id}/photo-positions`)).json() as { photos: Array<{ excluded: boolean }> };
      expect(positions.photos.filter(photo => photo.excluded).length).toBe(1);
      await evaluate("document.querySelector('.timeline-more summary').click(); true");
      await wait("document.querySelector('.capture-minutes')");
      expect(await evaluate("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
    }
    expect(requests.filter(url => !url.startsWith(h.base) && !url.startsWith("data:") && !url.startsWith("blob:") && !url.startsWith("devtools:") && url !== "about:blank")).toEqual([]);
  } finally {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(Error("test finished")); }
    socket?.close(); await browser?.stop(); await h.stop(); await rm(folder, { recursive: true, force: true });
  }
}, 60000);
