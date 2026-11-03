import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventually, openHarness } from "../../../../server/testing/harness.ts";
import { assetsFromFolder } from "../../../../server/http/static-assets.ts";
import { detailedTiff } from "../../../../test-support/photo-metadata.ts";
import { folderSnapshot } from "../../../../test-support/import-folder.ts";
import { writeStoredZip } from "../../../../test-support/stored-zip-writer.ts";
import { FakeTaskApi } from "../../../../test-support/fake-task-api.ts";
import { browserPath } from "../../controls/browser-path.ts";
import { startBrowser } from "../../controls/browser-start.ts";
import { findBrowserPage } from "../../controls/browser-target.ts";

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

function sha256hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

test("Details and all three deletion questions use production routes and preserve imported photos", async () => {
  const folder = await mkdtemp(join(tmpdir(), "aidm-details-browser-"));
  const publicFiles = join(folder, "public"), dataFolder = join(folder, "data"), imported = join(folder, "flight-" + "north".repeat(35));
  await mkdir(publicFiles); await mkdir(dataFolder); await mkdir(imported);
  await writeFile(join(imported, "photo.tif"), detailedTiff(true));
  const originalFolder = await folderSnapshot(imported);
  const engine = new FakeTaskApi(); await engine.start();
  const h = openHarness({ dataFolder, assets: await buildInterface(publicFiles), runPollMs: 10 });
  h.settings.set("wizard.completed", true);
  const engineId = h.engineStore.addRemote({ name: "Field engine", address: engine.address, token: engine.token }).id;
  const request = (method: string, path: string, body?: unknown) => fetch(h.base + path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  const project = await (await request("POST", "/api/projects", { name: "Vineyard north", notes: "" })).json() as { id: number };
  const importedProject = await (await request("POST", "/api/projects", { name: "Imported flight", notes: "Keep the folder" })).json() as { id: number };
  expect((await request("PUT", `/api/projects/${importedProject.id}/import`, { path: imported })).status).toBe(200);
  const upload = async (name: string, bytes: Buffer) => {
    const sha256 = sha256hex(bytes);
    const session = await (await request("POST", `/api/projects/${project.id}/uploads`, { name, size: bytes.length, sha256 })).json() as { id: string; complete: boolean };
    if (session.complete) return;
    expect((await fetch(`${h.base}/api/projects/${project.id}/uploads/${session.id}/chunks/0`, { method: "PUT", headers: { "x-chunk-sha256": sha256 }, body: new Uint8Array(bytes) })).status).toBe(204);
    expect((await request("POST", `/api/projects/${project.id}/uploads/${session.id}/complete`)).status).toBe(200);
  };
  const first = Buffer.alloc(1024, 1);
  await upload("a.jpg", first);
  // Aliases cross the route's page boundary. They must still occupy one copy.
  for (let index = 0; index < 100; index++) await upload(`copy-${String(index).padStart(3, "0")}.jpg`, first);
  await upload("z.jpg", Buffer.alloc(2048, 2));
  const input = { engineId, preset: "quick-map", options: [] };
  const review = await (await request("POST", `/api/projects/${project.id}/run-review`, input)).json() as { revision: string };
  const run = await (await request("POST", `/api/projects/${project.id}/runs`, { ...input, name: "First flight", revision: review.revision })).json() as { id: number };
  await eventually(async () => h.runs.get(run.id)?.state === "queued");
  const archivePath = join(folder, "outputs.zip");
  writeStoredZip(archivePath, [{ name: "odm_orthophoto/odm_orthophoto.tif", data: new TextEncoder().encode("map bytes") }]);
  const archive = new Uint8Array(await Bun.file(archivePath).arrayBuffer());
  engine.setTask(h.runs.get(run.id)!.taskUuid!, { statusCode: 40, results: archive, output: ["Finished"] });
  await eventually(async () => ((await (await request("GET", `/api/runs/${run.id}`)).json()) as { results?: { state: string } }).results?.state === "ready");

  await upload("a_mask.png", Buffer.alloc(512, 3));

  let browser: Awaited<ReturnType<typeof startBrowser>> | undefined, socket: WebSocket | undefined;
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: Timer }>();
  const requests: string[] = [];
  try {
    browser = await startBrowser(await browserPath(), join(folder, "profile"), "about:blank");
    socket = new WebSocket((await findBrowserPage(Number(browser.port))).webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => { socket!.onopen = () => resolve(); socket!.onerror = () => reject(new Error("browser connection")); });
    let next = 0;
    socket.onmessage = event => {
      const message = JSON.parse(String(event.data));
      if (message.method === "Network.requestWillBeSent") requests.push(message.params.request.url);
      const item = pending.get(message.id); if (!item) return;
      pending.delete(message.id); clearTimeout(item.timer);
      message.error ? item.reject(new Error(JSON.stringify(message.error))) : item.resolve(message.result);
    };
    const send = (method: string, params: object = {}) => new Promise<any>((resolve, reject) => { const id = ++next; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timeout`)); }, 10000); pending.set(id, { resolve, reject, timer }); socket!.send(JSON.stringify({ id, method, params })); });
    const evaluate = async <T = unknown>(expression: string): Promise<T> => { const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails)); return result.result.value; };
    const wait = async (condition: string) => {
      try { await evaluate(`new Promise((resolve, reject) => { const end = Date.now() + 8000; const tick = () => (${condition}) ? resolve(true) : Date.now() > end ? reject(Error("timeout")) : setTimeout(tick, 20); tick(); })`); }
      catch { throw new Error(`Waiting for ${condition}: ${await evaluate("document.body.innerText")}`); }
    };
    const press = async (key: "Tab" | "Enter" | "Escape") => {
      const common = { key, code: key, windowsVirtualKeyCode: { Tab: 9, Enter: 13, Escape: 27 }[key] };
      await send("Input.dispatchKeyEvent", { type: "keyDown", ...common, ...(key === "Enter" ? { text: "\r" } : {}) });
      await send("Input.dispatchKeyEvent", { type: "keyUp", ...common });
    };
    const tabTo = async (selector: string) => {
      for (let step = 0; step < 50; step++) {
        if (await evaluate(`document.activeElement?.matches(${JSON.stringify(selector)})`)) return;
        await press("Tab");
      }
      throw new Error(`Keyboard did not reach ${selector}`);
    };
    const activate = async (selector: string) => { await tabTo(selector); await press("Enter"); };
    const go = async (hash: string, title: string) => {
      await evaluate(`location.hash = ${JSON.stringify(hash)}; true`);
      await wait(`document.querySelector('main h1')?.textContent === ${JSON.stringify(title)}`);
    };
    const onlyConfirmRed = async (open: boolean) => {
      const red = await evaluate<string[]>("[...document.querySelectorAll('button')].filter(b => b.getClientRects().length && getComputedStyle(b).backgroundColor === getComputedStyle(document.querySelector('dialog button.danger')).backgroundColor).map(b => b.textContent)");
      expect(red.length).toBe(open ? 1 : 0);
      if (open) expect(await evaluate("document.activeElement?.textContent")).toMatch(/^Keep /);
    };
    const openQuestion = async (selector: string, title: string, contents: string[], confirm: string) => {
      await activate(selector);
      await wait("document.querySelector('dialog[open]')");
      expect(await evaluate("document.querySelector('dialog[open] h2').textContent")).toBe(title);
      for (const text of contents) expect(await evaluate("document.querySelector('dialog[open]').textContent")).toContain(text);
      expect(await evaluate("document.querySelector('dialog[open] button.danger').textContent")).toBe(confirm);
      await onlyConfirmRed(true);
      expect(await evaluate("document.querySelector('dialog[open]').scrollWidth <= document.querySelector('dialog[open]').clientWidth")).toBe(true);
    };
    await send("Page.enable"); await send("Network.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    // A failed inventory read must be visible and prevent an incomplete confirmation.
    await send("Network.setBlockedURLs", { urls: [`*/api/projects/${project.id}/photos*`] });
    await send("Page.navigate", { url: `${h.base}/#/projects/${project.id}/details` });
    await wait("document.querySelector('[data-storage-retry]')");
    expect(await evaluate("document.querySelector('.details-danger button').disabled")).toBe(true);
    await send("Network.setBlockedURLs", { urls: [] });
    await activate("[data-storage-retry]");
    await wait("document.querySelector('.details-storage')?.textContent.includes('2 files (3 KiB)')");
    expect(await evaluate("document.querySelector('.details-storage').textContent")).toContain(`Run ${run.id}${archive.length} B`);
    expect(await evaluate("document.documentElement.scrollWidth <= innerWidth")).toBe(true);

    for (const theme of ["light", "dark"]) {
      await evaluate(`document.documentElement.dataset.theme = '${theme}'; true`);
      await openQuestion(".details-danger button", 'Delete "Vineyard north"?', ["Uploaded photos: 2 (3 KiB)", "Masks and videos: 1 (512 B)", `Result archives: 1 (${archive.length} B)`, "Runs, their settings and logs: 1"], "Delete project and 4 KiB");
      await press("Enter"); // Keep has the focus.
      await wait("!document.querySelector('dialog[open]')");
      await onlyConfirmRed(false);
      expect((await request("GET", `/api/projects/${project.id}`)).status).toBe(200);

      await go(`#/runs/${run.id}`, `Run ${run.id}`);
      await wait("document.querySelector('main button') && [...document.querySelectorAll('main button')].some(b => b.textContent === 'Delete run')");
      const runButton = "main section[aria-label] .actions button:last-child";
      await openQuestion(runButton, 'Delete run "First flight"?', [`Local result archive: ${archive.length} B`, "This run's settings and log", "This run on Field engine", "The project, its photos and imported folders stay."], `Delete run and ${archive.length} B`);
      await press("Escape");
      await wait("!document.querySelector('dialog[open]')");
      expect((await request("GET", `/api/runs/${run.id}`)).status).toBe(200);

      await go(`#/projects/${project.id}/results/${run.id}`, "Results");
      await wait("document.querySelector('main section button')");
      await openQuestion("main section button", 'Delete the results of "First flight"?', [`Local result archive: ${archive.length} B`, "The run, its settings and log, project photos and imported folders stay."], `Delete results and ${archive.length} B`);
      await press("Enter");
      await wait("!document.querySelector('dialog[open]')");
      expect((await request("GET", `/api/runs/${run.id}/results`)).status).toBe(200);
      await go(`#/projects/${project.id}/details`, "Details");
      await wait("document.querySelector('.details-danger button')?.disabled === false");
    }
    const fill = async (selector: string, value: string) => {
      await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    };
    await fill("#project-name", "Vineyard south"); await fill("#project-notes", "Fly again after harvest\nCheck the north field");
    await activate("main form button[type=submit]");
    await wait("document.querySelector('nav.sidebar')?.textContent.includes('Vineyard south')");
    await go("#/", "Projects");
    await wait("document.querySelector('main')?.textContent.includes('Vineyard south')");
    await go(`#/projects/${project.id}/details`, "Details");
    await wait("document.querySelector('#project-notes')?.value === 'Fly again after harvest\\nCheck the north field'");
    expect(await evaluate("getComputedStyle(document.querySelector('#project-notes')).resize")).toBe("vertical");

    await go(`#/projects/${importedProject.id}/details`, "Details");
    await wait("document.querySelector('.details-danger button')?.disabled === false");
    expect(await evaluate("document.querySelector('.details-storage').textContent")).toContain(imported);
    expect(await evaluate("document.querySelector('.details-storage tr:last-child').textContent")).toBe("Total0 B");
    await openQuestion(".details-danger button", 'Delete "Imported flight"?', [`The imported folder ${imported} stays as it is.`, "Uploaded photos: 0 (0 B)", "Result archives: 0 (0 B)"], "Delete project and 0 B");
    await press("Tab"); // Move from Keep to the destructive confirmation.
    expect(await evaluate("document.activeElement?.classList.contains('danger')")).toBe(true);
    await press("Enter");
    await wait("location.hash === '#/'");
    expect((await request("GET", `/api/projects/${importedProject.id}`)).status).toBe(404);
    expect(await folderSnapshot(imported)).toEqual(originalFolder);
    expect(engine.requests.some(r => r.path === "/task/remove")).toBe(false);
    expect(requests.filter(url => !url.startsWith(h.base) && !url.startsWith("data:") && !url.startsWith("blob:"))).toEqual([]);
  } finally {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("test finished")); }
    socket?.close(); await browser?.stop(); await h.stop(); await engine.stop(); await rm(folder, { recursive: true, force: true });
  }
}, 90000);
