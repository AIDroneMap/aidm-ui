import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventually, openHarness } from "../../../server/testing/harness.ts";
import { assetsFromFolder } from "../../../server/http/static-assets.ts";
import { FakeTaskApi } from "../../../test-support/fake-task-api.ts";
import { browserPath } from "../controls/browser-path.ts";
import { startBrowser } from "../controls/browser-start.ts";
import { findBrowserPage } from "../controls/browser-target.ts";
import { ROUTE_MAP } from "../router.ts";

const KEYS = { Tab: 9, Enter: 13, Escape: 27, " ": 32, ArrowRight: 39 } as const;

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

test("the sidebar, the route map, the redirects, Projects and Preferences on the production routes", async () => {
  const folder = await mkdtemp(join(tmpdir(), "aidm-shell-browser-"));
  const publicFiles = join(folder, "public"), dataFolder = join(folder, "data");
  await mkdir(publicFiles); await mkdir(dataFolder);
  const engine = new FakeTaskApi(); await engine.start();
  const h = openHarness({ dataFolder, assets: await buildInterface(publicFiles), runPollMs: 10 });
  h.settings.set("wizard.completed", true);
  const engineId = h.engineStore.addRemote({ name: "Field engine", address: engine.address, token: engine.token }).id;
  let browser: Awaited<ReturnType<typeof startBrowser>> | undefined, socket: WebSocket | undefined;
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: Timer }>();
  const requests: Array<{ method: string; url: string }> = [];
  try {
    browser = await startBrowser(await browserPath(), join(folder, "profile"), "about:blank");
    socket = new WebSocket((await findBrowserPage(Number(browser.port))).webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => { socket!.onopen = () => resolve(); socket!.onerror = () => reject(new Error("browser connection")); });
    let next = 0;
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.method === "Network.requestWillBeSent") requests.push({ method: message.params.request.method, url: message.params.request.url });
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
    const press = async (key: keyof typeof KEYS, shift = false) => {
      const common = { key, code: key === " " ? "Space" : key, windowsVirtualKeyCode: KEYS[key], modifiers: shift ? 8 : 0 };
      await send("Input.dispatchKeyEvent", { type: "keyDown", ...common, ...(key === "Enter" ? { text: "\r" } : key === " " ? { text: " " } : {}) });
      await send("Input.dispatchKeyEvent", { type: "keyUp", ...common });
    };
    const viewport = (width: number, height: number) => send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    const go = async (hash: string) => { await evaluate(`location.hash = ${JSON.stringify(hash)}; true`); };
    const heading = () => evaluate<string>("document.querySelector('main h1')?.textContent ?? ''");
    const noSidewaysScroll = async () => expect(await evaluate<boolean>("document.documentElement.scrollWidth <= innerWidth"), await evaluate<string>("location.hash")).toBe(true);
    // Tab from the top of the page until the element matching the selector has the focus, as an operator would.
    // A radio of a segmented control is see-through; its label draws the ring, so only links and buttons are checked here.
    const tabTo = async (selector: string, limit = 40) => {
      await evaluate("document.activeElement?.blur(); window.getSelection()?.removeAllRanges(); true");
      for (let step = 0; step < limit; step++) {
        await press("Tab");
        if (await evaluate<boolean>(`document.activeElement?.matches(${JSON.stringify(selector)}) ?? false`)) {
          if (await evaluate<boolean>("document.activeElement.matches('a, button')")) expect(await evaluate<string>("getComputedStyle(document.activeElement).outlineStyle")).not.toBe("none");
          return;
        }
      }
      throw new Error(`Tab never reached ${selector} on ${await evaluate("location.hash")}`);
    };

    await send("Page.enable"); await send("Network.enable");
    await viewport(1280, 900);

    // Projects shows the sample project row before any run.
    await send("Page.navigate", { url: `${h.base}/#/` });
    await wait("document.querySelector('main table tbody tr')");
    expect(await heading()).toBe("Projects");
    expect(await evaluate("document.querySelector('main table tbody tr td:first-child a')?.textContent")).toBe("Sample project");
    await noSidewaysScroll();

    // The dialog asks for a name and lands on the new project's Photos section.
    await tabTo("main button");
    expect(await evaluate("document.activeElement.textContent")).toBe("New project");
    await press("Enter");
    await wait("document.querySelector('dialog[open]') && document.activeElement?.id === 'new-project-name'");
    await send("Input.insertText", { text: "Vineyard north" });
    await press("Enter");
    await wait("/^#\\/projects\\/\\d+\\/photos$/.test(location.hash) && document.querySelector('main h1')?.textContent === 'Photos'");
    const projectId = Number((await evaluate<string>("location.hash")).split("/")[2]);
    expect(h.ctx.projects.get(projectId)?.name).toBe("Vineyard north");
    await wait("document.querySelector('nav.sidebar')?.textContent.includes('Vineyard north')");

    // A photo and a run, so the badges and the run addresses have something to show.
    const request = (method: string, path: string, body?: unknown) => fetch(h.base + path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    const bytes = Buffer.from("synthetic photo"), sha256 = createHash("sha256").update(bytes).digest("hex");
    const upload = await (await request("POST", `/api/projects/${projectId}/uploads`, { name: "photo.jpg", size: bytes.length, sha256 })).json() as { id: string };
    await fetch(`${h.base}/api/projects/${projectId}/uploads/${upload.id}/chunks/0`, { method: "PUT", headers: { "x-chunk-sha256": sha256 }, body: bytes });
    await request("POST", `/api/projects/${projectId}/uploads/${upload.id}/complete`);
    const body = { engineId, preset: "quick-map", options: [] };
    const review = await (await request("POST", `/api/projects/${projectId}/run-review`, body)).json() as { revision: string };
    const run = await (await request("POST", `/api/projects/${projectId}/runs`, { ...body, name: "First", revision: review.revision })).json() as { id: number };
    await eventually(async () => h.runs.get(run.id)?.state === "queued");

    // Inside the project the sidebar shows the badges: photos and an active run.
    await send("Page.reload");
    await wait("document.querySelector('nav.sidebar')?.textContent.includes('Vineyard north')");
    expect(await evaluate(`document.querySelector("a[href='#/projects/${projectId}/photos']").textContent`)).toContain("Photos: 1");
    expect(await evaluate(`document.querySelector("a[href='#/projects/${projectId}/runs']").textContent`)).toContain("A run is in progress");
    engine.setTask(h.runs.get(run.id)!.taskUuid!, { statusCode: 30, output: ["failed"] });
    await eventually(async () => h.runs.get(run.id)?.state === "failed");
    await wait(`!document.querySelector("a[href='#/projects/${projectId}/runs']").textContent.includes('A run is in progress')`, 8000);

    // The keyboard reaches every project section and every application item; Enter opens it and marks it current.
    const walk: Array<[string, string]> = [
      [`#/projects/${projectId}/settings`, "Settings"],
      [`#/projects/${projectId}/review`, "Review"],
      [`#/projects/${projectId}/runs`, "Runs"],
      [`#/projects/${projectId}/results`, "Results"],
      [`#/projects/${projectId}/details`, "Details"],
      [`#/projects/${projectId}/photos`, "Photos"],
      ["#/engines", "Engines"],
      ["#/preferences", "Preferences"],
      ["#/", "Projects"],
    ];
    for (const [hash, title] of walk) {
      await tabTo(`nav.sidebar a[href="${hash}"]`);
      expect(await evaluate("document.activeElement.textContent")).toContain(title);
      await press("Enter");
      await wait(`location.hash === ${JSON.stringify(hash)} && document.querySelector('main h1')?.textContent === ${JSON.stringify(title)}`);
      expect(await evaluate(`document.querySelector('nav.sidebar a[href="${hash}"]').getAttribute('aria-current')`)).toBe("page");
      expect(await evaluate("document.querySelectorAll('nav.sidebar [aria-current=page]').length")).toBe(1);
      await noSidewaysScroll();
    }
    // Preferences is the application's page; Settings is only ever a section of a project.
    expect(await evaluate("[...document.querySelectorAll('nav.sidebar a')].map(a => a.textContent).join('|')")).toBe("Projects|Engines|Preferences");
    expect(await evaluate("document.querySelector('nav.sidebar').textContent.includes('Settings')")).toBe(false);

    // Every address of the route map opens a screen; the wizard opens without the sidebar.
    for (const { hash, route } of ROUTE_MAP) {
      const address = hash.replace(/\/9(\/|$)/, `/${run.id}$1`).replace("/projects/7", `/projects/${projectId}`);
      await go(address);
      if (route.screen === "wizard") {
        await wait("document.querySelector('main h1') && !document.querySelector('nav.sidebar')");
        continue;
      }
      // A loaded run is titled by its name; its number shows only while it loads.
      const title = route.screen === "projects" ? "Projects" : route.screen === "engines" ? "Engines" : route.screen === "preferences" ? "Preferences" : route.screen === "run" ? "First"
        : { photos: "Photos", settings: "Settings", review: "Review", runs: "Runs", results: "Results", details: "Details" }[route.section];
      await wait(`location.hash === ${JSON.stringify(address)} && document.querySelector('main h1')?.textContent === ${JSON.stringify(title)} && document.querySelector('nav.sidebar')`);
      if (route.screen === "project" && route.viewer) await wait(`document.querySelector('main a[href="#/projects/${projectId}/results/${run.id}"]')`);
      await noSidewaysScroll();
    }

    // Old addresses are replaced by the new ones, without an extra step in the history.
    for (const [old, now] of [[`#/projects/${projectId}`, `#/projects/${projectId}/photos`], ["#/settings", "#/preferences"], ["#/projects/new", "#/"]]) {
      await go("#/engines"); await wait("document.querySelector('main h1')?.textContent === 'Engines'");
      const before = await evaluate<number>("history.length");
      await go(old!);
      await wait(`location.hash === ${JSON.stringify(now)}`);
      expect(await evaluate<number>("history.length")).toBe(before + 1);
    }
    // Before any sample run, #/sample opens the sample project's Runs section.
    const sampleProject = h.ctx.projects.sampleId()!;
    await go("#/engines"); await wait("document.querySelector('main h1')?.textContent === 'Engines'");
    await go("#/sample");
    await wait(`location.hash === '#/projects/${sampleProject}/runs' && document.querySelector('main h1')?.textContent === 'Runs'`);
    // After a run exists the same redirect applies and the sidebar shows the project name.
    h.runs.create({ projectId: sampleProject, engineId, options: [{ name: "dsm", value: true }], sample: true });
    await go("#/engines"); await wait("document.querySelector('main h1')?.textContent === 'Engines'");
    await go("#/sample");
    await wait(`location.hash === '#/projects/${sampleProject}/runs' && document.querySelector('main h1')?.textContent === 'Runs' && document.querySelector('nav.sidebar').textContent.includes('Sample project')`);

    // The theme follows the device until the operator chooses, and the choice stays in this browser.
    const background = () => evaluate<string>("getComputedStyle(document.documentElement).backgroundColor");
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
    await go("#/preferences");
    await wait("document.querySelector('#preferences-theme-light')");
    expect(await evaluate("document.documentElement.hasAttribute('data-theme')")).toBe(false);
    expect(await background()).toBe("rgb(20, 22, 20)");
    const sentBefore = requests.length;
    await tabTo("#preferences-theme-system");
    await press("ArrowRight");
    await wait("document.documentElement.dataset.theme === 'light' && document.querySelector('#preferences-theme-light').checked");
    expect(await background()).toBe("rgb(255, 255, 255)");
    await send("Page.reload");
    await wait("document.querySelector('#preferences-theme-light')?.checked");
    expect(await evaluate("document.documentElement.dataset.theme")).toBe("light");
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
    await tabTo("#preferences-theme-light");
    await press("ArrowRight");
    await wait("document.documentElement.dataset.theme === 'dark'");
    expect(await background()).toBe("rgb(20, 22, 20)");
    await evaluate("document.querySelector('#preferences-theme-system').click(); true");
    await wait("!document.documentElement.hasAttribute('data-theme')");
    expect(await background()).toBe("rgb(255, 255, 255)");
    expect(await evaluate("localStorage.getItem('aidm-ui.theme')")).toBeNull();
    // Choosing a theme asks nothing of the server.
    expect(requests.slice(sentBefore).filter(({ method, url }) => method !== "GET" && !url.includes("/api/auth/") && !url.includes("/events")).map(({ url }) => url)).toEqual([]);

    // Below 64 rem the sidebar keeps its icons; on a tablet held upright it hides behind the menu button.
    await viewport(900, 700);
    await go(`#/projects/${projectId}/photos`);
    await wait("document.querySelector('main h1')?.textContent === 'Photos'");
    expect(await evaluate("document.querySelector('nav.sidebar').getBoundingClientRect().width")).toBeLessThan(80);
    await noSidewaysScroll();
    // The words of a folded item show beside the rail, on keyboard focus and on hover, and nothing covers or clips them.
    const labelShown = (href: string) => evaluate<boolean>(`(() => {
      const label = document.querySelector('nav.sidebar a[href="${href}"] .nav-label'), box = label.getBoundingClientRect();
      if (box.width < 20 || box.left < document.querySelector('nav.sidebar').getBoundingClientRect().right) return false;
      return label.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
    })()`);
    await tabTo('nav.sidebar a[href="#/preferences"]');
    expect(await labelShown("#/preferences")).toBe(true);
    await evaluate("document.activeElement.blur(); true");
    const icon = await evaluate<{ x: number; y: number }>(`(() => { const box = document.querySelector('nav.sidebar a[href="#/engines"]').getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; })()`);
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: icon.x, y: icon.y });
    expect(await labelShown("#/engines")).toBe(true);
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 600, y: 400 });
    await viewport(768, 1024);
    await wait("getComputedStyle(document.querySelector('.shell-nav')).display === 'none'");
    await noSidewaysScroll();
    await tabTo(".shell-bar button");
    expect(await evaluate("document.activeElement.getAttribute('aria-expanded')")).toBe("false");
    await press("Enter");
    await wait("getComputedStyle(document.querySelector('.shell-nav')).display !== 'none' && document.activeElement?.closest('nav.sidebar')");
    expect(await evaluate("document.querySelector('nav.sidebar').getBoundingClientRect().width")).toBeGreaterThan(200);
    await press("Escape");
    await wait("getComputedStyle(document.querySelector('.shell-nav')).display === 'none' && document.activeElement?.matches('.shell-bar button')");
    await press("Enter");
    await wait("document.activeElement?.closest('nav.sidebar')");
    // Following a link closes the menu.
    await tabTo(`nav.sidebar a[href="#/projects/${projectId}/details"]`);
    await press("Enter");
    await wait(`location.hash === '#/projects/${projectId}/details' && getComputedStyle(document.querySelector('.shell-nav')).display === 'none'`);
  } finally {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("test finished")); }
    socket?.close(); await browser?.stop(); await h.stop(); await engine.stop(); await rm(folder, { recursive: true, force: true });
  }
}, 90000);
