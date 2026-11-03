import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventually, openHarness } from "../../../../server/testing/harness.ts";
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

test("Review is reached from Settings by keyboard, shows the run before it starts, says why a start is blocked and starts the run", async () => {
  const folder = await mkdtemp(join(tmpdir(), "aidm-review-journey-"));
  const publicFiles = join(folder, "public"); await mkdir(publicFiles); await mkdir(join(folder, "data"));
  const h = openHarness({ dataFolder: join(folder, "data"), assets: await productionAssets(publicFiles) });
  h.settings.set("wizard.completed", true);
  const engine = new FakeTaskApi({ info: { version: "2.7.0" } }); await engine.start();
  h.engineStore.addRemote({ name: "Field engine", address: engine.address, token: engine.token });
  const project = h.ctx.projects.create("Vineyard north", "").id;
  for (const name of ["one.jpg", "two.jpg"]) {
    const bytes = Buffer.from(`synthetic photo ${name}`), sha256 = createHash("sha256").update(bytes).digest("hex");
    const upload = await (await fetch(h.base + `/api/projects/${project}/uploads`, { method: "POST", body: JSON.stringify({ name, size: bytes.length, sha256 }) })).json() as { id: string };
    await fetch(h.base + `/api/projects/${project}/uploads/${upload.id}/chunks/0`, { method: "PUT", headers: { "x-chunk-sha256": sha256 }, body: bytes });
    await fetch(h.base + `/api/projects/${project}/uploads/${upload.id}/complete`, { method: "POST" });
  }

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
    const KEYS: Record<string, [string, number]> = { Tab: ["Tab", 9], Enter: ["Enter", 13], " ": ["Space", 32] };
    const press = async (key: keyof typeof KEYS) => {
      const [code, keyCode] = KEYS[key]!;
      await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: keyCode, ...(key === "Enter" ? { text: "\r" } : key === " " ? { text: " " } : {}) });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode });
    };
    const focus = async (selector: string) => { await wait(`document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled`); await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus(); true`); };
    const fill = async (selector: string, text: string) => { await focus(selector); await evaluate(`document.querySelector(${JSON.stringify(selector)}).select(); true`); await send("Input.insertText", { text }); };
    const button = (text: string) => `[...document.querySelectorAll('button')].find(el => el.textContent === ${JSON.stringify(text)})`;
    /** Moves the focus onto a button and presses Enter on it, as a keyboard user does. */
    const activate = async (text: string) => { await wait(`${button(text)} && !${button(text)}.disabled`); await evaluate(`${button(text)}.focus(); true`); await press("Enter"); };
    const items = (selector: string) => evaluate<string[]>(`[...document.querySelectorAll(${JSON.stringify(selector)})].map(el => el.textContent)`);
    const reviewHash = `#/projects/${project}/review`;
    await send("Page.enable"); await send("Network.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

    // Before any settings are chosen, Review sends the operator to Settings.
    await send("Page.navigate", { url: `${h.base}/${reviewHash}` });
    await wait(`document.querySelector('main h1')?.textContent === ${JSON.stringify(words["review.title"])} && document.body.textContent.includes(${JSON.stringify(words["review.placeholder"])})`);
    await focus(`a[href="#/projects/${project}/settings"].button`); await press("Enter");
    await wait(`location.hash === '#/projects/${project}/settings' && document.querySelectorAll('.settings-row').length === 80`);

    // Two edits by keyboard; then "Review and start" by keyboard.
    await fill("#setting-orthophoto-resolution", "8");
    await fill("#setting-max-concurrency", "2");
    await wait("document.querySelector('[data-option=\"max-concurrency\"] .settings-dot')");
    await activate(words["settings.review"]!);
    await wait(`location.hash === ${JSON.stringify(reviewHash)} && document.querySelector('.review') && document.querySelector('main h1')?.textContent === ${JSON.stringify(words["review.title"])}`);
    expect(await evaluate(`document.querySelector('a[aria-current="page"]')?.getAttribute('href')`)).toBe(reviewHash);

    // What will be processed, on which engine, under which name.
    const left = await evaluate<string>("document.querySelectorAll('.review-column')[0].textContent");
    expect(left).toContain("Included: 2. Left out: 0. Total: 2.");
    expect(left).toContain(words["run_start.way.upload"]!);
    expect(left).toContain("Engine: Field engine");
    expect(left).toContain("Task API version: 2.7.0");
    expect(await evaluate("document.querySelector('#run-name').value")).toMatch(/^Quick map /);
    // What comes out, every changed option by plain name, flag and value, what the server sets, and the warnings.
    expect(await items(`section[aria-labelledby="review-outputs"] ul:first-of-type li`)).toContain(words["run_start.output.orthophoto"]!);
    expect(await items(`section[aria-labelledby="review-changed"] ul:first-of-type li`)).toEqual([
      `${words["option.fast-orthophoto.name"]} fast-orthophoto ${words["run_start.yes"]}`,
      `${words["option.orthophoto-resolution.name"]} orthophoto-resolution 8`,
      `${words["option.max-concurrency.name"]} max-concurrency 2`,
    ]);
    expect(await items(`section[aria-labelledby="review-changed"] h3 + p + ul li`)).toEqual([`${words["option.tiles.name"]} tiles ${words["run_start.yes"]}`]);
    const warnings = await evaluate<string>(`document.querySelector('section[aria-labelledby="review-warnings"]').textContent`);
    expect(warnings).toContain(words["warn.fast_orthophoto"]!.replace("{skip3d}", words["option.skip-3dmodel.name"]!));
    await evaluate("(installAudits => { installAudits(); return true; })(" + installAudits.toString() + ")");
    expect(await evaluate("audits.textContrast(document.querySelector('.review'))")).toEqual([]);

    // A blocked start says why above the buttons and changes nothing else on the screen.
    const columns = await evaluate<string>("document.querySelector('.review-columns').innerHTML");
    engine.info.maxImages = 1;
    await activate(words["run_start.reload"]!);
    const reason = words["project_run.image_limit"]!.replace("{count}", "2").replace("{limit}", "1");
    await wait(`document.querySelector('.review-blocked')?.textContent === ${JSON.stringify(reason)}`);
    expect(await evaluate(`${button(words["review.start"]!)}.disabled`)).toBe(true);
    expect(await evaluate("document.querySelector('.review-start').firstElementChild.classList.contains('review-blocked')")).toBe(true);
    // The engine's facts now carry the limit it reports; nothing else on the screen moves.
    const limit = (value: string) => `<li>${words["run_start.limit"]!.replace("{value}", value)}</li>`;
    expect(await evaluate<string>("document.querySelector('.review-columns').innerHTML")).toBe(columns.replace(limit(words["run_start.no_limit"]!), limit("1")));
    expect(engine.tasks.size).toBe(0);

    // Back in Settings the draft is as it was; Review again, now unblocked, and start by keyboard.
    engine.info.maxImages = null;
    await activate(words["settings.back"]!);
    await wait(`location.hash === '#/projects/${project}/settings' && document.querySelector('#setting-orthophoto-resolution')?.value === '8' && document.querySelector('#setting-max-concurrency')?.value === '2'`);
    await activate(words["settings.review"]!);
    await wait(`location.hash === ${JSON.stringify(reviewHash)} && !document.querySelector('.review-blocked') && ${button(words["review.start"]!)} && !${button(words["review.start"]!)}.disabled`);
    await fill("#run-name", "North block");
    await activate(words["review.start"]!);
    await wait("/^#\\/runs\\/\\d+$/.test(location.hash)");
    await eventually(async () => engine.tasks.size === 1 && [...engine.tasks.values()][0]!.committed);
    const sent = [...engine.tasks.values()][0]!.options as Array<{ name: string; value: unknown }>;
    for (const option of [{ name: "orthophoto-resolution", value: 8 }, { name: "max-concurrency", value: 2 }, { name: "fast-orthophoto", value: true }, { name: "tiles", value: true }]) expect(sent).toContainEqual(option);
    expect(h.runs.latestForProject(project)?.name).toBe("North block");
    expect(requests.filter(url => !url.startsWith("data:") && !url.startsWith("blob:")).every(url => url.startsWith(h.base))).toBe(true);
  } finally {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(Error("test finished")); }
    socket?.close(); await browser?.stop(); await h.stop(); await engine.stop();
    await rm(folder, { recursive: true, force: true });
  }
}, 90000);
