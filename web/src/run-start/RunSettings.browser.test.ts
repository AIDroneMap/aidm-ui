import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fixtureOptions from "../../../test-support/fixtures/task-api-2.6.1-options.json";
import type { EngineOption } from "../../../shared/engine-options.ts";
import { reconcileOptions } from "../../../server/options/reconcile.ts";
import { planPreset } from "../../../shared/run-plan.ts";
import { PRESET_IDS, type OptionValue, type PresetId } from "../../../shared/option-catalogue.ts";
import texts from "../i18n/en.json";
import { browserPath } from "../controls/browser-path.ts";
import { startBrowser } from "../controls/browser-start.ts";
import { findBrowserPage } from "../controls/browser-target.ts";

test("edited settings survive review and are reconciled before changing engines", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aidm-settings-flow-"));
  const build = await Bun.build({ entrypoints: [new URL("./browser-fixture.tsx", import.meta.url).pathname], target: "browser" });
  expect(build.success).toBe(true);
  const requests: Array<{ engine: number; options: Array<{ name: string; value: OptionValue }> }> = [];
  let posted: any;
  const warning = "Hamming requires a GPU, from engine help.";
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/") return new Response('<link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script>', { headers: { "content-type": "text/html" } });
    if (url.pathname === "/fixture.js" || url.pathname === "/fixture.css") {
      const asset = build.outputs.find(asset => asset.path.endsWith(url.pathname.endsWith(".css") ? ".css" : ".js"));
      return asset ? new Response(asset) : new Response(null, { status: 404 });
    }
    if (url.pathname === "/api/presets") return Response.json({ presets: [], nextOffset: null });
    if (url.pathname === "/api/engines") return Response.json([{ id: 1, name: "Local", enabled: true }, { id: 2, name: "Remote", enabled: true }]);
    if (url.pathname.endsWith("/run-review")) {
      const body = request.method === "POST" ? await request.json() as any : null;
      const engine = body?.engineId ?? Number(url.searchParams.get("engineId"));
      const preset = (body?.preset ?? url.searchParams.get("preset")) as PresetId;
      const options = body?.options ?? [];
      requests.push({ engine, options });
      const reported = structuredClone(fixtureOptions) as EngineOption[];
      const matcher = reported.find(option => option.name === "matcher-type")!;
      matcher.domain = ["bow", "bruteforce", "flann", "hamming"];
      if (engine === 2) {
        const resolution = reported.find(option => option.name === "orthophoto-resolution")!;
        resolution.domain = "float: 1 <= x <= 5";
      }
      const reconciled = reconcileOptions(reported);
      const plan = planPreset(preset, reconciled, options);
      const detail = (value: any) => ({ ...value, help: "", unexplained: false });
      return Response.json({ project: { id: 1, name: "Field" }, engine: { id: engine, name: engine === 1 ? "Local" : "Remote", kind: engine === 1 ? "local" : "remote", gpu: engine === 1 ? false : null, info: { version: "2.6.1" }, imageLimit: null, imageLimitReported: true }, preset, presets: PRESET_IDS.map(id => ({ id, departures: planPreset(id, reconciled).departures.map(detail) })), wayIn: "upload", photos: { included: 3, excluded: 0, total: 3, bytes: 123 }, facts: null, options: plan.departures.map(detail), outputs: plan.outputs, alwaysProduced: [], revision: `revision-${engine}-${JSON.stringify(options)}`, blocked: null,
        settings: { options: reconciled, facts: { bands: false, videos: false }, matcherWarning: engine === 1 && plan.effectiveOptions.some(option => option.name === "matcher-type" && option.value === "hamming") ? warning : null } });
    }
    if (url.pathname.endsWith("/runs")) { posted = await request.json(); return Response.json({ id: 99 }, { status: 202 }); }
    return new Response(null, { status: 404 });
  } });
  let browser: Awaited<ReturnType<typeof startBrowser>> | undefined;
  let socket: WebSocket | undefined;
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  try {
    browser = await startBrowser(await browserPath(), directory, "about:blank");
    socket = new WebSocket((await findBrowserPage(Number(browser.port))).webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error("Browser connection timeout")), 5000); socket!.onopen = () => { clearTimeout(timer); resolve(); }; socket!.onerror = () => { clearTimeout(timer); reject(new Error("Browser connection failed")); }; });
    const urls: string[] = [];
    socket.onmessage = event => { const message = JSON.parse(String(event.data)); if (message.method === "Network.requestWillBeSent") urls.push(message.params.request.url); const item = pending.get(message.id); if (!item) return; clearTimeout(item.timer); pending.delete(message.id); if (message.error) item.reject(new Error(JSON.stringify(message.error))); else item.resolve(message.result); };
    let nextId = 0;
    const send = (method: string, params: object = {}) => new Promise<any>((resolve, reject) => { const id = ++nextId; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 7000); pending.set(id, { resolve, reject, timer }); socket!.send(JSON.stringify({ id, method, params })); });
    const evaluate = async (expression: string) => { const value = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (value.exceptionDetails) throw new Error(JSON.stringify(value.exceptionDetails)); return value.result.value; };
    const wait = (expression: string) => evaluate(`new Promise((resolve,reject) => { const end=Date.now()+4000; const check=()=>${expression} ? resolve(true) : Date.now()>end ? reject(Error('Condition timed out: '+${JSON.stringify(expression)})) : setTimeout(check,20); check(); })`);
    const button = (text: string) => `[...document.querySelectorAll('button')].find(button=>button.textContent===${JSON.stringify(text)})`;
    const click = async (text: string) => { await wait(`${button(text)} && !${button(text)}.disabled`); await evaluate(`${button(text)}.click()`); };
    const search = async (value: string) => { await wait("document.querySelector('.settings-editor input[id$=\"-search\"]')"); await evaluate("document.querySelector('.settings-editor input[id$=\"-search\"]').focus()"); await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 }); await send("Input.insertText", { text: value }); };
    await send("Network.enable");
    await send("Page.navigate", { url: `http://127.0.0.1:${server.port}/` });
    await click(texts["run_start.choose"]);
    await click("Change settings");
    await search("orthophoto-resolution");
    await wait("document.querySelectorAll('.settings-editor-row').length === 1");
    await evaluate("document.querySelector('.settings-editor-row input').focus()");
    await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
    await send("Input.insertText", { text: "8" });
    await search("dsm");
    await evaluate("[...document.querySelectorAll('.settings-editor-row')].find(row=>row.querySelector('code')?.textContent==='dsm').querySelector('input').click()");
    await search("matcher-type");
    await wait("document.querySelectorAll('.settings-editor-row').length === 1");
    await evaluate("document.querySelector('.settings-editor-row select').value='3'; document.querySelector('.settings-editor-row select').dispatchEvent(new Event('change',{bubbles:true}))");
    await click(texts["run_settings.apply"]);
    await wait(`document.body.textContent.includes(${JSON.stringify(warning)})`);
    expect(requests.some(request => request.options.some(option => option.name === "orthophoto-resolution" && option.value === 8))).toBe(true);
    await evaluate("document.querySelector('#run-engine').value='2'; document.querySelector('#run-engine').dispatchEvent(new Event('change',{bubbles:true}))");
    await wait("document.body.textContent.includes('Engine: Remote')");
    await wait("document.body.textContent.includes('orthophoto-resolution')");
    expect(await evaluate(`document.body.textContent.includes(${JSON.stringify(warning)})`)).toBe(false);
    expect(requests.filter(request => request.engine === 2).every(request => !request.options.some(option => option.name === "orthophoto-resolution" && option.value === 8))).toBe(true);
    await click(texts["run_start.start"]);
    await wait("location.hash === '#/runs/99'");
    expect(posted.engineId).toBe(2);
    expect(posted.options).toContainEqual({ name: "dsm", value: true });
    expect(posted.options).toContainEqual({ name: "matcher-type", value: "hamming" });
    expect(posted.options.some((option: any) => option.name === "orthophoto-resolution" && option.value === 8)).toBe(false);
    expect(urls.filter(url => !url.startsWith("data:") && !url.startsWith("blob:")).every(url => url.startsWith(`http://127.0.0.1:${server.port}/`))).toBe(true);
  } finally { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("Test finished")); } pending.clear(); socket?.close(); await browser?.stop(); server.stop(true); await rm(directory, { recursive: true, force: true }); }
}, 30000);
