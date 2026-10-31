import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPTION_CATALOGUE } from "../../../shared/option-catalogue.ts";
import texts from "../i18n/en.json";
import { browserPath } from "../controls/browser-path.ts";
import { startBrowser } from "../controls/browser-start.ts";
import { findBrowserPage } from "../controls/browser-target.ts";

test("settings are searchable and editable with a keyboard at tablet width", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aidm-settings-"));
  let server: ReturnType<typeof Bun.serve> | undefined;
  let browser: Awaited<ReturnType<typeof startBrowser>> | undefined;
  let socket: WebSocket | undefined;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  try {
    const build = await Bun.build({ entrypoints: [new URL("./browser-fixture.tsx", import.meta.url).pathname], target: "browser" });
    if (!build.success) throw new Error(build.logs.join("\n"));
    server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/") return new Response('<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/browser-fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script>', { headers: { "content-type": "text/html" } });
      const output = path === "/fixture.js" ? build.outputs.find((file) => file.path.endsWith(".js")) : build.outputs.find((file) => new URL(file.path, "http://example.test").pathname === path);
      return output ? new Response(await output.arrayBuffer(), { headers: { "content-type": output.type } }) : new Response(null, { status: 404 });
    } });
    browser = await startBrowser(await browserPath(), directory, "about:blank");
    socket = new WebSocket((await findBrowserPage(Number(browser.port))).webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Browser connection timed out")), 5000);
      socket!.onopen = () => { clearTimeout(timer); resolve(); };
      socket!.onerror = () => { clearTimeout(timer); reject(new Error("Browser connection failed")); };
    });
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      const request = pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer); pending.delete(message.id);
      if (message.error) request.reject(new Error(JSON.stringify(message.error))); else request.resolve(message.result);
    };
    socket.onclose = () => { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error("Browser connection closed")); } pending.clear(); };
    let nextId = 0;
    const send = (method: string, params: object = {}) => new Promise<any>((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 5000);
      pending.set(id, { resolve, reject, timer });
      try { socket!.send(JSON.stringify({ id, method, params })); } catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
    const evaluate = async (expression: string) => {
      const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const key = async (name: "Space" | "Enter" | "Tab", code: number) => {
      await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: name === "Space" ? " " : name, code: name, windowsVirtualKeyCode: code });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: name === "Space" ? " " : name, code: name, windowsVirtualKeyCode: code });
    };
    await send("Emulation.setDeviceMetricsOverride", { width: 768, height: 1024, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: `http://127.0.0.1:${server.port}/` });
    await evaluate(`new Promise((resolve, reject) => { const end = Date.now() + 4000; const check = () => document.querySelector('details summary') ? resolve(true) : Date.now() > end ? reject(Error('editor did not load')) : setTimeout(check, 20); check(); })`);

    const group = texts["group.how-detailed"];
    await key("Tab", 9);
    await evaluate(`Array.from(document.querySelectorAll('summary')).find(el => el.textContent.includes(${JSON.stringify(group)})).focus()`);
    expect(await evaluate("document.activeElement.matches(':focus-visible')")).toBe(true);
    expect(await evaluate("getComputedStyle(document.activeElement).outlineStyle !== 'none'")).toBe(true);
    const initial = await evaluate("document.activeElement.parentElement.open");
    await key("Space", 32);
    expect(await evaluate("document.activeElement.parentElement.open")).toBe(!initial);
    if (initial) await key("Enter", 13);
    expect(await evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth")).toBe(true);

    const names = OPTION_CATALOGUE.filter((option) => option.bin === "shown").map((option) => option.name);
    expect(names).toHaveLength(63);
    await evaluate("document.querySelectorAll('details').forEach(el => { el.open = true; })");
    for (const name of names) expect(await evaluate(`document.body.innerText.includes(${JSON.stringify(name)})`)).toBe(true);
    for (const option of OPTION_CATALOGUE.filter((entry) => entry.bin !== "shown")) expect(await evaluate(`Array.from(document.querySelectorAll('code')).some(el => el.textContent === ${JSON.stringify(option.name)})`)).toBe(false);
    expect(await evaluate("document.body.innerText.includes('<img src=x onerror=alert(1)> & engine help')")).toBe(true);
    expect(await evaluate("document.querySelector('img[src=x]') === null")).toBe(true);
    expect(await evaluate("Array.from(document.querySelectorAll('input, select, textarea')).every(el => el.labels?.length || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby'))")).toBe(true);

    const optionTexts = texts as Record<string, string>;
    for (const suffix of ["name", "description", "when", "cost", "example"]) {
      expect(await evaluate(`document.body.innerText.includes(${JSON.stringify(optionTexts[`option.orthophoto-resolution.${suffix}`])})`)).toBe(true);
    }
    const control = (label: string) => `Array.from(document.querySelectorAll('input, select')).find(el => Array.from(el.labels || []).some(label => label.textContent.trim() === ${JSON.stringify(label)}))`;
    const setValue = async (label: string, value: string) => evaluate(`(() => { const el = ${control(label)}; const setter = Object.getOwnPropertyDescriptor(el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype, 'value').set; setter.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); })()`);
    const search = texts["run_settings.search"];
    for (const query of ["orthophoto-resolution", ...["name", "description", "when", "cost", "example"].map((suffix) => optionTexts[`option.orthophoto-resolution.${suffix}`]!)]) {
      await setValue(search, query);
      expect(await evaluate(`document.body.innerText.includes(${JSON.stringify(texts["option.orthophoto-resolution.name"])})`)).toBe(true);
      if (query === "orthophoto-resolution") expect(await evaluate(`document.body.innerText.includes(${JSON.stringify(texts["option.mesh-size.name"])})`)).toBe(false);
    }
    await setValue(search, "orthophoto-resolution");
    await evaluate(`Array.from(document.querySelectorAll('summary')).find(el => el.textContent.trim() === ${JSON.stringify(texts["run_settings.more"])}).focus()`);
    const moreOpen = await evaluate("document.activeElement.parentElement.open");
    await key("Space", 32);
    expect(await evaluate("document.activeElement.parentElement.open")).toBe(!moreOpen);

    const numeric = texts["option.orthophoto-resolution.name"];
    await setValue(numeric, "0");
    expect(await evaluate(`${control(numeric)}.getAttribute('aria-invalid')`)).toBe("true");
    expect(await evaluate(`(() => { const el = ${control(numeric)}; return Boolean(document.getElementById(el.getAttribute('aria-describedby'))?.innerText); })()`)).toBe(true);
    const button = (label: string) => `Array.from(document.querySelectorAll('button')).find(el => el.textContent.trim() === ${JSON.stringify(label)})`;
    expect(await evaluate(`${button(texts["run_settings.apply"])}.disabled`)).toBe(true);
    await setValue(numeric, "3");
    expect(await evaluate(`${button(texts["run_settings.apply"])}.disabled`)).toBe(false);
    await evaluate(`Array.from(document.querySelectorAll('button')).find(el => el.getAttribute('aria-label') === ${JSON.stringify(texts["run_settings.reset_one"].replace("{name}", numeric))}).click()`);
    expect(await evaluate(`${control(numeric)}.value`)).toBe("5");

    await setValue(search, "dsm");
    const dsm = texts["option.dsm.name"];
    await evaluate(`${control(dsm)}.focus()`);
    await key("Space", 32);
    expect(await evaluate(`${control(dsm)}.checked`)).toBe(true);
    await setValue(search, "report-units");
    await setValue(texts["option.report-units.name"], "1");
    expect(await evaluate(`${control(texts["option.report-units.name"])}.selectedOptions[0].textContent`)).toBe("ft");
    await evaluate(`${button(texts["run_settings.reset_all"])}.click()`);
    expect(await evaluate(`${control(texts["option.report-units.name"])}.selectedOptions[0].textContent`)).toBe("m");
    await setValue(search, "dem-resolution");
    const dependent = texts["option.dem-resolution.name"];
    expect(await evaluate(`${control(dependent)}.disabled`)).toBe(true);
    expect(await evaluate(`(() => { const el = ${control(dependent)}; return Boolean(document.getElementById(el.getAttribute('aria-describedby'))?.innerText); })()`)).toBe(true);
    await setValue(search, "radiometric-calibration");
    const bands = texts["option.radiometric-calibration.name"];
    expect(await evaluate(`${control(bands)}.disabled`)).toBe(true);
    expect(await evaluate(`document.body.innerText.includes(${JSON.stringify(texts["run_settings.unknown_facts"])})`)).toBe(true);
  } finally {
    socket?.close();
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error("Test ended")); }
    pending.clear();
    await browser?.stop();
    server?.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
