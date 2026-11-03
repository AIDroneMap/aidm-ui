import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHarness } from "../../../../server/testing/harness.ts";
import { assetsFromFolder } from "../../../../server/http/static-assets.ts";
import { FakeTaskApi } from "../../../../test-support/fake-task-api.ts";
import { browserPath } from "../../controls/browser-path.ts";
import { startBrowser } from "../../controls/browser-start.ts";
import { findBrowserPage } from "../../controls/browser-target.ts";
import { installAudits } from "../../controls/page-audits.ts";
import texts from "../../i18n/en.json";

const words = texts as Record<string, string>;

/** Builds the production entry, with the map worker's address standing in for the build tool's `?url` import. */
async function productionAssets(folder: string) {
  const built = await Bun.build({ entrypoints: [new URL("../../main.tsx", import.meta.url).pathname], target: "browser", plugins: [{ name: "asset-urls", setup(builder) {
    builder.onResolve({ filter: /\?url$/ }, args => ({ path: args.path, namespace: "asset-url" }));
    builder.onLoad({ filter: /.*/, namespace: "asset-url" }, args => ({ contents: `export default ${JSON.stringify(`/assets/${args.path.split("/").pop()!.replace("?url", "")}`)}`, loader: "js" }));
  } }] });
  if (!built.success) throw new Error(built.logs.join("\n"));
  for (const output of built.outputs) await Bun.write(join(folder, output.path.endsWith(".css") ? "app.css" : "app.js"), output);
  await Bun.write(join(folder, "index.html"), '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><div id="root"></div><script type="module" src="/app.js"></script></html>');
  return assetsFromFolder(folder);
}

test("Settings searches, filters to changed in the address, compares and resets, switches engine, shows a locked option and reaches Review by keyboard", async () => {
  const folder = await mkdtemp(join(tmpdir(), "aidm-settings-journey-"));
  const publicFiles = join(folder, "public"); await mkdir(publicFiles); await mkdir(join(folder, "data"));
  const h = openHarness({ dataFolder: join(folder, "data"), assets: await productionAssets(publicFiles) });
  h.settings.set("wizard.completed", true);
  const field = new FakeTaskApi({ info: { version: "2.7.0" } }); await field.start();
  const other = new FakeTaskApi({ info: { version: "2.7.0" } });
  other.options.find(option => option.name === "orthophoto-resolution")!.domain = "float: 1 <= x <= 5";
  await other.start();
  h.engineStore.addRemote({ name: "Field engine", address: field.address, token: field.token });
  const otherId = h.engineStore.addRemote({ name: "Other engine", address: other.address, token: other.token }).id;
  const project = h.ctx.projects.create("Vineyard north", "").id;
  const bytes = Buffer.from("synthetic photo"), sha256 = createHash("sha256").update(bytes).digest("hex");
  const upload = await (await fetch(h.base + `/api/projects/${project}/uploads`, { method: "POST", body: JSON.stringify({ name: "photo.jpg", size: bytes.length, sha256 }) })).json() as { id: string };
  await fetch(h.base + `/api/projects/${project}/uploads/${upload.id}/chunks/0`, { method: "PUT", headers: { "x-chunk-sha256": sha256 }, body: bytes });
  await fetch(h.base + `/api/projects/${project}/uploads/${upload.id}/complete`, { method: "POST" });

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
      catch { throw Error(`Waiting for ${condition}: ${await evaluate("document.querySelector('main')?.innerText")}`); }
    };
    const KEYS: Record<string, [string, number]> = { Tab: ["Tab", 9], Enter: ["Enter", 13], Escape: ["Escape", 27], " ": ["Space", 32], ArrowRight: ["ArrowRight", 39] };
    const press = async (key: keyof typeof KEYS) => {
      const [code, keyCode] = KEYS[key]!;
      await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: keyCode, ...(key === "Enter" ? { text: "\r" } : key === " " ? { text: " " } : {}) });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode });
    };
    const focus = async (selector: string) => { await wait(`document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled`); await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus(); true`); };
    /** Replaces a field's text: focus it, select what it holds, then type. */
    const fill = async (selector: string, text: string) => { await focus(selector); await evaluate(`document.querySelector(${JSON.stringify(selector)}).select(); true`); await send("Input.insertText", { text }); };
    const rows = () => evaluate<string[]>("[...document.querySelectorAll('.settings-row')].map(row => row.dataset.option)");
    const railCount = (group: string) => evaluate<string>(`[...document.querySelectorAll('.settings-rail-group')].find(el => el.textContent.startsWith(${JSON.stringify(words[`settings.group.${group}`])})).querySelector('.settings-rail-count .visually-hidden')?.textContent ?? ''`);
    const compared = () => evaluate<string[][]>("[...document.querySelectorAll('.settings-compare tbody tr')].map(row => [row.querySelector('.diff-code').textContent, row.querySelector('.diff-from').textContent, row.querySelector('.diff-to').textContent])");
    const settingsAddress = `${h.base}/#/projects/${project}/settings`;
    await send("Page.enable"); await send("Network.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: settingsAddress });

    // Every option the engine's task API reports is a row, in the nine groups, starting from Quick map.
    await wait("document.querySelectorAll('.settings-row').length === 80");
    expect(await evaluate("document.querySelector('#settings-preset').value")).toBe("quick-map");
    expect(await evaluate("document.querySelector('#run-engine').selectedOptions[0].textContent")).toBe("Field engine");
    expect(await evaluate("document.querySelectorAll('.settings-rail-group').length")).toBe(9);
    expect(await railCount("orthophoto")).toBe("1 changed");
    expect(await evaluate("document.querySelector('.settings-summary').textContent")).toContain(words["settings.changed_one"]!);

    // Search across names, flags and the explanations, with its count.
    await fill("#settings-search", "vertices");
    await wait("document.querySelectorAll('.settings-row').length === 1");
    expect(await rows()).toEqual(["mesh-octree-depth"]);
    expect(await evaluate("document.querySelector('#settings-search-count').textContent")).toBe("1 match");
    await press("Escape");
    await wait("document.querySelectorAll('.settings-row').length === 80");

    // "Changed only" is kept in the address, and a reload keeps it.
    await focus("#settings-changed-only"); await press(" ");
    await wait(`location.hash === '#/projects/${project}/settings?changed' && document.querySelectorAll('.settings-row').length === 1`);
    expect(await rows()).toEqual(["fast-orthophoto"]);
    await send("Page.reload");
    await wait("document.querySelectorAll('.settings-row').length === 1 && document.querySelector('#settings-changed-only')?.checked");
    expect(await rows()).toEqual(["fast-orthophoto"]);
    await focus("#settings-changed-only"); await press(" ");
    await wait(`location.hash === '#/projects/${project}/settings' && document.querySelectorAll('.settings-row').length === 80`);

    // Edits by keyboard mark their rows and count in the rail.
    await fill("#setting-orthophoto-resolution", "8");
    await wait("document.querySelector('[data-option=\"orthophoto-resolution\"] .settings-dot')");
    await focus("#setting-dsm"); await press(" ");
    await wait("document.querySelector('#setting-dsm').checked && document.querySelector('[data-option=\"dsm\"] .settings-dot')");
    expect(await railCount("orthophoto")).toBe("2 changed");
    expect(await railCount("elevation-models")).toBe("1 changed");

    // A locked option shows its reason and cannot be edited.
    expect(await evaluate("document.querySelector('#setting-cog').disabled && document.querySelector('#setting-cog').checked")).toBe(true);
    expect(await evaluate("document.querySelector('[data-option=\"cog\"] .settings-row-reason').textContent")).toBe(words["settings.locked.always-on"]!);

    // The comparison: against the engine's defaults, then against the preset, with a reset per row; Escape closes it.
    await focus("#settings-compare-open"); await press("Enter");
    await wait("document.activeElement?.id === 'settings-compare-title'");
    expect(await compared()).toEqual([["dsm", "Off", "On"], ["fast-orthophoto", "Off", "On"], ["orthophoto-resolution", "5", "8"]]);
    await evaluate("(installAudits => { installAudits(); return true; })(" + installAudits.toString() + ")");
    expect(await evaluate("audits.textContrast(document.querySelector('.settings-workspace'))")).toEqual([]);
    await focus(`.settings-compare button[aria-label="${words["settings.compare.reset_default"]!.replace("{name}", words["option.orthophoto-resolution.name"]!)}"]`); await press("Enter");
    await wait("document.querySelector('#setting-orthophoto-resolution').value === '5'");
    expect(await compared()).toEqual([["dsm", "Off", "On"], ["fast-orthophoto", "Off", "On"]]);
    await focus("#settings-compare-mode-defaults"); await press("ArrowRight");
    await wait("document.querySelector('#settings-compare-mode-preset').checked");
    expect(await compared()).toEqual([["dsm", "Off", "On"]]);
    await focus(`.settings-compare button[aria-label="${words["settings.compare.reset_preset"]!.replace("{name}", words["option.dsm.name"]!)}"]`); await press("Enter");
    await wait(`document.querySelector('.settings-compare .diff-empty')?.textContent === ${JSON.stringify(words["settings.compare.none_preset"])} && !document.querySelector('#setting-dsm').checked`);
    await press("Escape");
    await wait("!document.querySelector('.settings-compare') && document.activeElement?.id === 'settings-compare-open'");

    // A preset replaces edits only after asking; Keep changes nothing.
    await fill("#setting-orthophoto-resolution", "8");
    await evaluate("(el => { el.value = 'map-with-heights'; el.dispatchEvent(new Event('change', { bubbles: true })); return true; })(document.querySelector('#settings-preset'))");
    await wait("document.querySelector('dialog[open]')");
    expect(await evaluate("document.activeElement.textContent")).toBe(words["settings.confirm.keep"]!);
    await press("Escape");
    await wait("!document.querySelector('dialog[open]') && document.querySelector('#settings-preset').value === 'quick-map' && document.querySelector('#setting-orthophoto-resolution').value === '8'");

    // Another engine reconciles the draft again: a value it does not accept is dropped and listed.
    await evaluate(`(el => { el.value = '${otherId}'; el.dispatchEvent(new Event('change', { bubbles: true })); return true; })(document.querySelector('#run-engine'))`);
    await wait(`document.querySelectorAll('.settings-row').length === 80 && document.querySelector('#setting-orthophoto-resolution').value === '5' && document.querySelector('section[aria-label=${JSON.stringify(words["run_settings.moved"])}]')?.textContent.includes('orthophoto-resolution')`);
    expect(await evaluate("document.querySelector('[data-option=\"orthophoto-resolution\"] .settings-row-facts').textContent")).toContain("A number from 1 to 5.");

    // A value the engine does not accept keeps Review and start disabled, with the reason beside it.
    const review = `[...document.querySelectorAll('button')].find(el => el.textContent === ${JSON.stringify(words["settings.review"])})`;
    await fill("#setting-orthophoto-resolution", "0");
    await wait(`${review}.disabled && document.querySelector('#settings-review-reason')?.textContent === ${JSON.stringify(words["settings.review_blocked"]!.replace("{names}", words["option.orthophoto-resolution.name"]!))}`);
    await fill("#setting-orthophoto-resolution", "3");
    await wait(`!${review}.disabled && !document.querySelector('#settings-review-reason')`);

    // Review is reached by keyboard and shows the edited value on the chosen engine.
    await evaluate(`${review}.focus(); true`); await press("Enter");
    await wait(`document.body.textContent.includes('Engine: Other engine') && document.body.textContent.includes(${JSON.stringify(`${words["option.orthophoto-resolution.name"]} (orthophoto-resolution): 3`)})`);
    await wait(`[...document.querySelectorAll('button')].some(el => el.textContent === ${JSON.stringify(words["run_start.start"])} && !el.disabled)`);

    // Back in Settings, the dark theme keeps the text readable.
    await evaluate(`[...document.querySelectorAll('button')].find(el => el.textContent === ${JSON.stringify(words["settings.back"])}).click(); true`);
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
    await wait("document.querySelectorAll('.settings-row').length === 80 && document.querySelector('#setting-orthophoto-resolution').value === '3'");
    await focus("#settings-compare-open"); await press("Enter");
    await wait("document.querySelector('.settings-compare')");
    // Colours change over the state transition; the audit reads them once it has ended.
    await evaluate("new Promise(resolve => setTimeout(() => resolve(true), 400))");
    expect(await evaluate("audits.textContrast(document.querySelector('.settings-workspace'))")).toEqual([]);
    expect(requests.filter(url => !url.startsWith("data:") && !url.startsWith("blob:")).every(url => url.startsWith(h.base))).toBe(true);
  } finally {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(Error("test finished")); }
    socket?.close(); await browser?.stop(); await h.stop(); await field.stop(); await other.stop();
    await rm(folder, { recursive: true, force: true });
  }
}, 90000);
