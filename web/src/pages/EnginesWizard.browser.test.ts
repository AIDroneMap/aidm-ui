import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHarness, type Harness } from "../../../server/testing/harness.ts";
import { assetsFromFolder } from "../../../server/http/static-assets.ts";
import { FakeTaskApi } from "../../../test-support/fake-task-api.ts";
import { linuxInputs, macInputs, recordedMachine } from "../../../test-support/recorded-machine.ts";
import { browserPath } from "../controls/browser-path.ts";
import { startBrowser } from "../controls/browser-start.ts";
import { findBrowserPage } from "../controls/browser-target.ts";
import { installAudits } from "../controls/page-audits.ts";

const KEYS = { Tab: 9, Enter: 13 } as const;

/** Builds the interface's own entry file, styles included, as the server serves it. */
async function buildInterface(folder: string) {
  const build = await Bun.build({ entrypoints: [new URL("../main.tsx", import.meta.url).pathname], target: "browser", plugins: [{ name: "asset-urls", setup(builder) {
    builder.onResolve({ filter: /\?url$/ }, (args) => ({ path: args.path, namespace: "asset-url" }));
    builder.onLoad({ filter: /.*/, namespace: "asset-url" }, (args) => ({ contents: `export default ${JSON.stringify(`/assets/${args.path.split("/").pop()!.replace("?url", "")}`)}`, loader: "js" }));
  } }] });
  if (!build.success) throw new Error(build.logs.join("\n"));
  for (const output of build.outputs) await Bun.write(join(folder, output.path.endsWith(".css") ? "app.css" : "app.js"), output);
  await Bun.write(join(folder, "index.html"), '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"><div id="root"></div><script type="module" src="/app.js"></script></html>');
  return assetsFromFolder(folder);
}

type Page = Awaited<ReturnType<typeof openPage>>;

/** Headless Chromium on the harness's production routes, driven through the DevTools protocol. */
async function openPage(folder: string, h: Harness) {
  const browser = await startBrowser(await browserPath(), join(folder, "profile"), "about:blank");
  const socket = new WebSocket((await findBrowserPage(Number(browser.port))).webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error("browser connection")); });
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: Timer }>();
  const requests: string[] = [];
  let next = 0;
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (message.method === "Network.requestWillBeSent") requests.push(message.params.request.url);
    const item = pending.get(message.id); if (!item) return;
    pending.delete(message.id); clearTimeout(item.timer);
    message.error ? item.reject(new Error(JSON.stringify(message.error))) : item.resolve(message.result);
  };
  const send = (method: string, params: object = {}) => new Promise<any>((resolve, reject) => { const id = ++next; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timeout`)); }, 10000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async <T = unknown>(expression: string): Promise<T> => { const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails)); return result.result.value as T; };
  const wait = async (condition: string, ms = 8000) => {
    try { await evaluate(`new Promise((resolve, reject) => { const end = Date.now() + ${ms}; const tick = () => (${condition}) ? resolve(true) : Date.now() > end ? reject(Error("timeout")) : setTimeout(tick, 20); tick(); })`); }
    catch { throw new Error(`Waiting for ${condition} at ${await evaluate("location.hash")}: ${await evaluate("document.body.innerText")}`); }
  };
  const press = async (key: keyof typeof KEYS) => {
    const common = { key, code: key, windowsVirtualKeyCode: KEYS[key] };
    await send("Input.dispatchKeyEvent", { type: "keyDown", ...common, ...(key === "Enter" ? { text: "\r" } : {}) });
    await send("Input.dispatchKeyEvent", { type: "keyUp", ...common });
  };
  const type = (text: string) => send("Input.insertText", { text });
  // Tab from where the focus is until the control matching the selector has it, as an operator would, and check the ring on every stop.
  const tabTo = async (selector: string, limit = 40) => {
    for (let step = 0; step < limit; step++) {
      await press("Tab");
      const focus = await evaluate<{ ring: boolean; where: string } | null>("audits.focused()");
      if (focus) expect(focus.ring, `focus ring on ${focus.where} at ${await evaluate("location.hash")}`).toBe(true);
      if (await evaluate<boolean>(`document.activeElement?.matches(${JSON.stringify(selector)}) ?? false`)) return;
    }
    throw new Error(`Tab never reached ${selector} on ${await evaluate("location.hash")}`);
  };
  /** Every piece of text and every control edge as drawn, in the current theme. */
  const contrast = async (label: string) => {
    expect(await evaluate<string[]>("audits.textContrast()"), `text on ${label}`).toEqual([]);
    expect(await evaluate<string[]>("audits.edgeContrast()"), `edges on ${label}`).toEqual([]);
  };
  const heading = () => evaluate<string>("document.querySelector('h1')?.textContent ?? ''");
  const audits = () => evaluate(`(${installAudits.toString()})(); true`);
  // A fresh load each time, even to the address the page is on, so the first-run redirect is asked again.
  const open = async (hash: string) => {
    await send("Page.navigate", { url: "about:blank" });
    await send("Page.navigate", { url: `${h.base}/${hash}` });
    await wait("document.readyState === 'complete' && document.querySelector('#root').childElementCount > 0");
    await audits();
  };
  await send("Page.enable"); await send("Network.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  const close = async () => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("test finished")); }
    socket.close(); await browser.stop();
  };
  return { send, evaluate, wait, press, type, tabTo, contrast, heading, open, requests, close };
}

/** Only the server that serves the interface is ever asked for anything. */
function onlyOwnServer(page: Page, h: Harness): void {
  expect(page.requests.filter((url) => !url.startsWith(h.base) && !url.startsWith("data:") && !url.startsWith("blob:") && url !== "about:blank")).toEqual([]);
}

test("the wizard walks by keyboard in both themes, and a computer that cannot run the engine is refused with the requirement alone", async () => {
  const folder = await mkdtemp(join(tmpdir(), "aidm-wizard-browser-"));
  const publicFiles = join(folder, "public");
  await mkdir(publicFiles);
  const machine = recordedMachine(linuxInputs());
  const h = openHarness({ assets: await buildInterface(publicFiles), machine });
  let page: Page | undefined;
  try {
    page = await openPage(folder, h);
    for (const theme of ["light", "dark"] as const) {
      h.settings.set("wizard.completed", false);
      await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
      // The first page goes to the wizard, which has no sidebar.
      await page.open("#/");
      await page.wait("location.hash === '#/wizard' && document.activeElement?.id === 'wizard-title'");
      expect(await page.heading()).toBe("Welcome to AIDM UI");
      expect(await page.evaluate("document.querySelector('nav.sidebar')")).toBeNull();
      expect(await page.evaluate("document.querySelector('.wizard-steps [aria-current=step]').textContent")).toBe("Welcome");
      await page.contrast(`welcome, ${theme}`);

      await page.tabTo("button:not(.secondary)");
      expect(await page.evaluate("document.activeElement.textContent")).toBe("Next");
      await page.press("Enter");
      await page.wait("location.hash === '#/wizard/check' && document.querySelectorAll('.check-lines li').length > 0 && document.activeElement?.id === 'wizard-title'");
      expect(await page.evaluate("[...document.querySelectorAll('.check-lines .result')].every(result => /^(Pass|Warning|Fail)$/.test(result.textContent))")).toBe(true);
      await page.contrast(`machine check, ${theme}`);

      await page.tabTo(".wizard-nav button:not(.secondary)");
      await page.press("Enter");
      await page.wait("location.hash === '#/wizard/engine' && document.activeElement?.id === 'wizard-title'");
      expect(await page.heading()).toBe("Choose an engine");
      await page.contrast(`engine choice, ${theme}`);

      await page.tabTo(".choice button:not(.secondary)");
      expect(await page.evaluate("document.activeElement.textContent")).toBe("Install on this computer");
      await page.press("Enter");
      await page.wait("location.hash === '#/wizard/install' && document.querySelector('#wizard-title')?.textContent === 'Install the engine' && document.querySelector('.wizard-panel .choice h2') !== null");
      await page.contrast(`install, ${theme}`);

      // Next needs no install: the operator may come back to it from Preferences.
      await page.tabTo(".wizard-nav button:not(.secondary)");
      await page.press("Enter");
      await page.wait("location.hash === '#/wizard/sample' && document.activeElement?.id === 'wizard-title'");
      expect(await page.heading()).toBe("Try the sample job");
      await page.contrast(`sample job, ${theme}`);

      await page.tabTo(".wizard-nav button:not(.secondary)");
      expect(await page.evaluate("document.activeElement.textContent")).toBe("Finish the setup");
      await page.press("Enter");
      await page.wait("location.hash === '#/' && document.querySelector('nav.sidebar') !== null");
      expect(h.settings.get("wizard.completed")).toBe(true);
    }

    // An Intel Mac: checked again, the panel of the local engine says what the engine needs, and nothing else.
    machine.inputs = macInputs("26", { arch: "x64" });
    h.settings.set("wizard.completed", false);
    await page.open("#/wizard/check");
    await page.wait("document.querySelectorAll('.check-lines li').length > 0");
    await page.tabTo(".wizard-nav button.secondary:not(:first-child)");
    expect(await page.evaluate("document.activeElement.textContent")).toBe("Check again");
    await page.press("Enter");
    await page.wait("document.querySelector('.check-lines .result-fail') !== null");
    await page.tabTo(".wizard-nav button:not(.secondary)");
    await page.press("Enter");
    await page.wait("location.hash === '#/wizard/engine' && document.querySelector('.choice-refused') !== null");
    expect(await page.evaluate("document.querySelector('.choice-refused').innerText.trim().split('\\n').filter(Boolean)")).toEqual([
      "An engine on this computer",
      "The engine needs a Mac with Apple silicon.",
    ]);
    expect(await page.evaluate("document.querySelector('.choice-refused button')")).toBeNull();
    await page.contrast("refused, dark");
    onlyOwnServer(page, h);
  } finally {
    await page?.close(); await h.stop(); await rm(folder, { recursive: true, force: true });
  }
}, 90000);

test("the Engines screen follows an engine from ready to busy to not answering to removed, and the sidebar dot shows each state", async () => {
  const folder = await mkdtemp(join(tmpdir(), "aidm-engines-browser-"));
  const publicFiles = join(folder, "public");
  await mkdir(publicFiles);
  const engine = new FakeTaskApi(); await engine.start();
  const h = openHarness({ assets: await buildInterface(publicFiles), enginePollMs: 50 });
  h.settings.set("wizard.completed", true);
  let page: Page | undefined;
  const dot = "document.querySelector('nav.sidebar a[href=\"#/engines\"] .visually-hidden')?.textContent";
  const pill = "document.querySelector('.engine .status-pill')";
  try {
    page = await openPage(folder, h);
    // Empty: no engine yet, one action, and the dot says so.
    await page.open("#/engines");
    await page.wait(`document.querySelector('.empty-state') !== null && ${dot} === 'No engine installed'`);
    expect(await page.evaluate("document.querySelector('.shell-engine-dot').className")).toBe("shell-engine-dot shell-engine-dot-not_installed");
    expect(await page.evaluate("document.querySelector('.page-header-actions')")).toBeNull();
    for (const theme of ["light", "dark"]) {
      await page.evaluate(`document.documentElement.dataset.theme = '${theme}'; true`);
      await page.contrast(`empty Engines, ${theme}`);
    }
    await page.evaluate("delete document.documentElement.dataset.theme; true");

    // Added by keyboard: the form opens with the focus in its first field, and Enter saves it.
    await page.tabTo(".empty-state button");
    expect(await page.evaluate("document.activeElement.textContent")).toBe("Add a remote engine");
    await page.press("Enter");
    await page.wait("document.activeElement?.id === 'engine-name'");
    await page.type("Barn engine");
    await page.tabTo("#engine-address");
    await page.type(engine.address);
    await page.tabTo("#engine-token");
    await page.type(engine.token);
    await page.press("Enter");
    await page.wait(`document.querySelector('#engine-name') === null && document.activeElement?.matches('main h1') && ${pill}?.textContent === 'State: Ready'`);
    await page.wait(`${dot} === 'An engine is ready'`);
    expect(await page.evaluate(`${pill}.className`)).toBe("status-pill status-ok");
    expect(await page.evaluate("document.querySelector('.engine h2').textContent")).toBe("Barn engine");
    for (const theme of ["light", "dark"]) {
      await page.evaluate(`document.documentElement.dataset.theme = '${theme}'; true`);
      await page.contrast(`Engines with a ready engine, ${theme}`);
    }
    await page.evaluate("delete document.documentElement.dataset.theme; true");

    // Busy: work waiting or running on the engine.
    engine.info.taskQueueCount = 1;
    await page.wait(`${pill}?.textContent === 'State: Busy' && ${dot} === 'An engine is busy'`);
    expect(await page.evaluate(`${pill}.className`)).toBe("status-pill status-running");
    expect(await page.evaluate("document.querySelector('.shell-engine-dot').className")).toBe("shell-engine-dot shell-engine-dot-busy");

    // Not answering: the engine is gone from the network; the screen warns instead of failing.
    await engine.stop();
    await page.wait(`${pill}?.textContent === 'State: Not answering' && ${dot} === 'No engine is answering'`, 15000);
    expect(await page.evaluate(`${pill}.className`)).toBe("status-pill status-warn");
    expect(await page.evaluate("document.querySelector('.engine .warning')?.textContent")).toStartWith("No engine answered at this address.");
    for (const theme of ["light", "dark"]) {
      await page.evaluate(`document.documentElement.dataset.theme = '${theme}'; true`);
      await page.contrast(`Engines with an engine not answering, ${theme}`);
    }
    await page.evaluate("delete document.documentElement.dataset.theme; true");

    // Removed by keyboard: asked first, with the red answer focused, then the empty state and its dot again.
    await page.tabTo("button[aria-label='Remove Barn engine']");
    await page.press("Enter");
    await page.wait("document.activeElement?.getAttribute('aria-label') === 'Yes, remove Barn engine'");
    expect(await page.evaluate("document.activeElement.className")).toBe("danger");
    await page.press("Enter");
    await page.wait(`document.querySelector('.empty-state') !== null && ${dot} === 'No engine installed'`);
    expect(h.engineStore.list().length).toBe(0);
    onlyOwnServer(page, h);
  } finally {
    await page?.close(); await h.stop(); await engine.stop(); await rm(folder, { recursive: true, force: true });
  }
}, 90000);

