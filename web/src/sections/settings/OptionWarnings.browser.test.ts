import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHarness } from "../../../../server/testing/harness.ts";
import { assetsFromFolder } from "../../../../server/http/static-assets.ts";
import { FakeTaskApi } from "../../../../test-support/fake-task-api.ts";
import { browserPath } from "../../controls/browser-path.ts";
import { startBrowser } from "../../controls/browser-start.ts";
import { findBrowserPage } from "../../controls/browser-target.ts";
import texts from "../../i18n/en.json";

const KEYS = { Tab: 9, " ": 32 } as const;

/** Builds the interface's own entry file, styles included, as the server serves it. */
async function buildInterface(folder: string) {
  const build = await Bun.build({ entrypoints: [new URL("../../main.tsx", import.meta.url).pathname], target: "browser", plugins: [{ name: "asset-urls", setup(builder) {
    builder.onResolve({ filter: /\?url$/ }, (args) => ({ path: args.path, namespace: "asset-url" }));
    builder.onLoad({ filter: /.*/, namespace: "asset-url" }, (args) => ({ contents: `export default ${JSON.stringify(`/assets/${args.path.split("/").pop()!.replace("?url", "")}`)}`, loader: "js" }));
  } }] });
  if (!build.success) throw new Error(build.logs.join("\n"));
  for (const output of build.outputs) await Bun.write(join(folder, output.path.endsWith(".css") ? "app.css" : "app.js"), output);
  await Bun.write(join(folder, "index.html"), '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"><div id="root"></div><script type="module" src="/app.js"></script></html>');
  return assetsFromFolder(folder);
}

test("on the Settings route, a warning appears under its row as the value is set, goes when it goes, and never blocks", async () => {
  const folder = await mkdtemp(join(tmpdir(), "aidm-warnings-browser-"));
  const publicFiles = join(folder, "public"), dataFolder = join(folder, "data");
  await mkdir(publicFiles); await mkdir(dataFolder);
  const engine = new FakeTaskApi(); await engine.start();
  const h = openHarness({ dataFolder, assets: await buildInterface(publicFiles) });
  h.settings.set("wizard.completed", true);
  h.engineStore.addRemote({ name: "Field engine", address: engine.address, token: engine.token });
  const projectId = h.ctx.projects.create("Vineyard north", "").id;
  let browser: Awaited<ReturnType<typeof startBrowser>> | undefined, socket: WebSocket | undefined;
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: Timer }>();
  try {
    browser = await startBrowser(await browserPath(), join(folder, "profile"), "about:blank");
    socket = new WebSocket((await findBrowserPage(Number(browser.port))).webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => { socket!.onopen = () => resolve(); socket!.onerror = () => reject(new Error("browser connection")); });
    let next = 0;
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      const item = pending.get(message.id); if (!item) return;
      pending.delete(message.id); clearTimeout(item.timer);
      message.error ? item.reject(new Error(JSON.stringify(message.error))) : item.resolve(message.result);
    };
    const send = (method: string, params: object = {}) => new Promise<any>((resolve, reject) => { const id = ++next; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timeout`)); }, 10000); pending.set(id, { resolve, reject, timer }); socket!.send(JSON.stringify({ id, method, params })); });
    const evaluate = async <T = unknown>(expression: string): Promise<T> => { const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails)); return result.result.value as T; };
    const wait = async (condition: string, ms = 5000) => {
      try { await evaluate(`new Promise((resolve, reject) => { const end = Date.now() + ${ms}; const tick = () => (${condition}) ? resolve(true) : Date.now() > end ? reject(Error("timeout")) : setTimeout(tick, 20); tick(); })`); }
      catch { throw new Error(`Waiting for ${condition} at ${await evaluate("location.hash")}: ${await evaluate("document.body.innerText")}`); }
    };
    const press = async (key: keyof typeof KEYS) => {
      const common = { key, code: key === " " ? "Space" : key, windowsVirtualKeyCode: KEYS[key] };
      await send("Input.dispatchKeyEvent", { type: "keyDown", ...common, ...(key === " " ? { text: " " } : {}) });
      await send("Input.dispatchKeyEvent", { type: "keyUp", ...common });
    };
    const button = (text: string) => `[...document.querySelectorAll('main button')].find((button) => button.textContent === ${JSON.stringify(text)})`;
    const click = async (text: string) => { await wait(`${button(text)} && !${button(text)}.disabled`); await evaluate(`${button(text)}.click(); true`); };
    const row = (flag: string) => `[...document.querySelectorAll('.settings-editor-row')].find((row) => row.querySelector('code')?.textContent === ${JSON.stringify(flag)})`;
    const warning = texts["warn.disk_space"];

    await send("Page.enable");
    await send("Page.navigate", { url: `${h.base}/#/projects/${projectId}/settings` });
    await wait("document.querySelector('main h1')?.textContent === 'Settings'");
    await click(texts["run_start.choose"]);
    await click(texts["run_settings.change"]);
    await wait(`${row("optimize-disk-space")}`);
    expect(await evaluate<boolean>(`document.body.textContent.includes(${JSON.stringify(warning)})`)).toBe(false);

    // The operator reaches the toggle with the keyboard and turns it on: the notice appears under that row only.
    await evaluate(`(() => { const details = ${row("optimize-disk-space")}.closest('details'); details.open = true; ${row("optimize-disk-space")}.querySelector('input').focus(); return true; })()`);
    await press(" ");
    await wait(`${row("optimize-disk-space")}.querySelector('.notice-warn')?.textContent.includes(${JSON.stringify(warning)})`);
    expect(await evaluate<number>(`[...document.querySelectorAll('.notice-warn')].filter((notice) => notice.textContent.includes(${JSON.stringify(warning)})).length`)).toBe(1);
    expect(await evaluate<string>(`${row("optimize-disk-space")}.querySelector('input').getAttribute('aria-describedby')`)).toContain("-warnings");
    expect(await evaluate<boolean>(`getComputedStyle(${row("optimize-disk-space")}.querySelector('.notice-warn')).display !== 'none'`)).toBe(true);
    // It never blocks: Apply stays enabled while the warning shows.
    expect(await evaluate<boolean>(`${button(texts["run_settings.apply"])}.disabled`)).toBe(false);

    // Turning it off again takes the notice away.
    await press(" ");
    await wait(`!document.body.textContent.includes(${JSON.stringify(warning)})`);
  } finally {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("test finished")); }
    socket?.close(); await browser?.stop(); await h.stop(); await engine.stop(); await rm(folder, { recursive: true, force: true });
  }
}, 60000);
