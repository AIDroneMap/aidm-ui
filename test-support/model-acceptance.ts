import { mkdtemp, mkdir, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetsFromFolder, type AssetMap } from "../server/http/static-assets.ts";
import { browserPath } from "../web/src/controls/browser-path.ts";
import { startBrowser } from "../web/src/controls/browser-start.ts";
import { findBrowserPage } from "../web/src/controls/browser-target.ts";

export async function modelAcceptanceAssets(folder: string): Promise<AssetMap> {
  const assets = join(folder, "assets");
  await mkdir(assets, { recursive: true });
  const build = await Bun.build({ entrypoints: [join(import.meta.dir, "model-acceptance-fixture.tsx")], target: "browser", plugins: [{ name: "decoder-assets", setup(builder) {
    builder.onResolve({ filter: /draco_(wasm_wrapper\.js|decoder\.wasm)\?url$/ }, args => ({ path: args.path, namespace: "decoder-assets" }));
    builder.onLoad({ filter: /.*/, namespace: "decoder-assets" }, args => ({ contents: `export default ${JSON.stringify(`/assets/${args.path.includes("wrapper") ? "draco_wasm_wrapper.js" : "draco_decoder.wasm"}`)}`, loader: "js" }));
  } }] });
  if (!build.success || !build.outputs[0]) throw new Error(`Model fixture build failed: ${build.logs.join("\n")}`);
  await Bun.write(join(assets, "model-fixture.js"), build.outputs[0]);
  for (const name of ["draco_wasm_wrapper.js", "draco_decoder.wasm"]) {
    await copyFile(join(import.meta.dir, "../node_modules/three/examples/jsm/libs/draco/gltf", name), join(assets, name));
  }
  await Bun.write(join(folder, "index.html"), '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/assets/model-fixture.js"></script></body></html>');
  return assetsFromFolder(folder);
}

export async function assertArchivedModel(base: string, runId: number, { screenshotPath }: { screenshotPath?: string } = {}): Promise<{ outputRequests: number; coloredPixels: number; externalRequests: string[] }> {
  const origin = new URL(base).origin;
  const outputUrl = new URL(`/api/runs/${runId}/outputs/glb`, origin).href;
  const folder = await mkdtemp(join(tmpdir(), "model-browser-"));
  let browser: Awaited<ReturnType<typeof startBrowser>> | undefined;
  let socket: WebSocket | undefined;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const requests: string[] = [];
  let id = 0;
  let opened = false;
  let closeView: (() => Promise<unknown>) | undefined;
  const rejectPending = (error: Error) => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
  };
  try {
    browser = await startBrowser(await browserPath(), folder, "about:blank");
    socket = new WebSocket((await findBrowserPage(Number(browser.port))).webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Browser connection timed out")), 5000);
      socket!.onopen = () => { clearTimeout(timer); resolve(); };
      socket!.onerror = () => { clearTimeout(timer); reject(new Error("Browser connection failed")); };
    });
    socket.onmessage = event => {
      const message = JSON.parse(String(event.data));
      if (message.method === "Network.requestWillBeSent") requests.push(message.params.request.url);
      const entry = pending.get(message.id);
      if (!entry) return;
      clearTimeout(entry.timer); pending.delete(message.id);
      if (message.error) entry.reject(new Error(`Browser command failed: ${message.error.message}`));
      else entry.resolve(message);
    };
    socket.onclose = () => rejectPending(new Error("Browser connection closed"));
    const send = (method: string, params: object = {}) => new Promise<any>((resolve, reject) => {
      const next = ++id;
      const timer = setTimeout(() => { pending.delete(next); reject(new Error(`Browser command ${method} timed out`)); }, 12000);
      pending.set(next, { resolve, reject, timer });
      try { socket!.send(JSON.stringify({ id: next, method, params })); }
      catch (error) { clearTimeout(timer); pending.delete(next); reject(error); }
    });
    const evaluate = async (expression: string) => {
      const response = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (response.result.exceptionDetails) throw new Error(`Browser evaluation failed: ${response.result.exceptionDetails.exception?.description ?? response.result.exceptionDetails.text}`);
      return response.result.result.value;
    };
    closeView = () => evaluate(`(async () => { document.querySelector('button')?.click(); const deadline = Date.now() + 2000; while (document.querySelector('canvas') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20)); if (document.querySelector('canvas')) throw new Error('Model view did not close'); })()`);
    await send("Network.enable");
    await send("Page.enable");
    const navigation = await send("Page.navigate", { url: `${origin}/?runId=${encodeURIComponent(String(runId))}` });
    if (navigation.result.errorText) throw new Error(`Browser navigation failed: ${navigation.result.errorText}`);
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !await evaluate("document.readyState === 'complete' && !!document.querySelector('button')")) await Bun.sleep(50);
    if (!await evaluate("document.readyState === 'complete' && !!document.querySelector('button')")) throw new Error("Model fixture did not become ready");
    if (await evaluate("!!document.querySelector('canvas')") || requests.includes(outputUrl)) throw new Error("Model opened before the button was clicked");
    await evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Open the 3D model').click()`);
    opened = true;
    let coloredPixels = 0;
    const renderDeadline = Date.now() + 15000;
    while (Date.now() < renderDeadline) {
      const alert = await evaluate("document.querySelector('[role=alert]')?.textContent ?? null");
      if (alert) throw new Error(`Model viewer error: ${alert}`);
      coloredPixels = await evaluate(`(async () => { const canvas = document.querySelector('canvas'); if (!canvas || document.querySelector('[role=status]')) return 0; const image = new Image(); image.src = canvas.toDataURL(); await image.decode(); const copy = document.createElement('canvas'); copy.width = image.width; copy.height = image.height; const context = copy.getContext('2d'); context.drawImage(image, 0, 0); const pixels = context.getImageData(0, 0, copy.width, copy.height).data; let count = 0; for (let index = 0; index < pixels.length; index += 4) if (Math.abs(pixels[index] - pixels[index + 1]) > 40 || Math.abs(pixels[index + 1] - pixels[index + 2]) > 40) count++; return count; })()`);
      if (coloredPixels > 0) break;
      await Bun.sleep(50);
    }
    if (!coloredPixels) throw new Error(`Model did not render colored pixels. Page: ${await evaluate("document.body?.innerText")}`);
    const outputRequests = requests.filter(url => url === outputUrl).length;
    const externalRequests = requests.filter(url => !url.startsWith("data:") && !url.startsWith("blob:") && new URL(url).origin !== origin);
    if (!outputRequests) throw new Error(`Model output was not requested: ${outputUrl}`);
    if (externalRequests.length) throw new Error(`External browser requests: ${externalRequests.join(", ")}`);
    if (screenshotPath) {
      const data = await evaluate("document.querySelector('canvas').toDataURL('image/png')");
      await Bun.write(screenshotPath, Buffer.from(data.split(",")[1], "base64"));
    }
    await closeView();
    opened = false;
    return { outputRequests, coloredPixels, externalRequests };
  } finally {
    if (opened && socket?.readyState === WebSocket.OPEN) await closeView?.().catch(() => {});
    rejectPending(new Error("Browser session ended"));
    socket?.close();
    await browser?.stop();
    await rm(folder, { recursive: true, force: true });
  }
}
