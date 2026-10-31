import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserPath } from "../controls/browser-path.ts";
import { startBrowser } from "../controls/browser-start.ts";
import { findBrowserPage } from "../controls/browser-target.ts";

test("resumes after a connection cut and reload through the upload panel", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aidm-upload-page-"));
  const profile = join(directory, "profile");
  const bytes = Uint8Array.from({ length: 2 * 1024 * 1024 + 17 }, (_, index) => (index * 37 + 11) % 251);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const file = join(directory, "flight.jpg");
  const wrong = join(directory, "wrong.jpg");
  const folder = join(directory, "flight-folder");
  await mkdir(folder);
  await writeFile(join(folder, "ignored.zip"), "x");
  await writeFile(file, bytes);
  await writeFile(wrong, new Uint8Array(bytes.length));
  const id = "0123456789abcdef0123456789abcdef";
  const chunks = new Map<number, Buffer>();
  const sent: number[] = [];
  let cutting = true;
  let cuts = 0;
  let damage = true;
  let damagedChunks = 0;
  let completed = false;
  let completedHash = "";
  let statusRequests = 0;
  let blocking = false;
  let blocked = false;
  let deletes = 0;
  let projectRequests = 0;
  const requests: string[] = [];
  const styles = await Promise.all(["tokens.css", "styles.css", "controls/Button.css", "controls/TextField.css", "controls/Disclosure.css", "controls/Table.css"].map(path => readFile(new URL(`../${path}`, import.meta.url), "utf8")));
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    requests.push(`${request.method} ${path}`);
    const json = (value: unknown, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    if (path === "/") { response.writeHead(200, { "content-type": "text/html", "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; worker-src 'self'" }); response.end('<link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script>'); return; }
    if (path === "/fixture.css") { response.writeHead(200, { "content-type": "text/css" }); response.end(styles.join("\n").replace(/@import[^;]+;/g, "")); return; }
    if (path === "/fixture.js" || path === "/hash-worker.ts") { response.writeHead(200, { "content-type": "text/javascript" }); response.end(await readFile(join(directory, path.slice(1)))); return; }
    if (/^\/api\/projects\/[12]$/.test(path)) {
      projectRequests++;
      json({ id: path.endsWith("/2") ? 2 : 1, name: completed ? "Survey updated" : "Survey", notes: "Saved notes", builtin: path.endsWith("/2") ? "sample" : null, photoCount: completed ? 1 : 0, runCount: 0, latestState: null, lastChange: "2024-01-01T00:00:00Z" }); return;
    }
    if (path.endsWith("/link")) { json({ url: null, size: null, facts: null, factsRunId: null }); return; }
    if (path.endsWith("/import")) { json({ available: true, state: "none", path: null, acceptedCount: 0, skippedCount: 0, groundControlCount: 0, files: [], nextOffset: null }); return; }
    if (path.endsWith("/photos")) { json({ files: completed ? [{ name: "flight.jpg", size: bytes.length, sha256: digest, kind: "photo" }] : [], nextOffset: null }); return; }
    const session = () => ({ id, chunkSize: 1024 * 1024, received: [...chunks.keys()], complete: completed });
    if (path.endsWith("/uploads") && request.method === "POST") {
      const parts: Buffer[] = []; for await (const part of request) parts.push(Buffer.from(part));
      const payload = JSON.parse(Buffer.concat(parts).toString());
      if (payload.sha256 !== digest) { json({ error: { code: "api.invalid_body", data: {} } }, 400); return; }
      json(session(), 201); return;
    }
    if (path.endsWith(id) && request.method === "GET") { statusRequests++; json(session()); return; }
    if (path.endsWith(id) && request.method === "DELETE") { deletes++; chunks.clear(); response.writeHead(204); response.end(); return; }
    if (path.endsWith("/complete")) {
      completedHash = createHash("sha256").update(Buffer.concat([chunks.get(0)!, chunks.get(1)!, chunks.get(2)!])).digest("hex");
      completed = completedHash === digest;
      json(session()); return;
    }
    const match = path.match(/\/chunks\/(\d+)$/);
    if (match && request.method === "PUT") {
      const index = Number(match[1]); sent.push(index);
      if (index === 0 && blocking) { blocked = true; request.resume(); return; }
      if (index === 1 && cutting) {
        request.once("data", () => { cuts++; request.socket.destroy(); });
        return;
      }
      const parts: Buffer[] = []; for await (const part of request) parts.push(Buffer.from(part));
      const body = Buffer.concat(parts);
      if (index === 1 && damage) { body[0] = body[0]! ^ 1; damage = false; damagedChunks++; }
      if (createHash("sha256").update(body).digest("hex") !== request.headers["x-chunk-sha256"]) { json({ error: { code: "upload.checksum_mismatch", data: {} } }, 400); return; }
      chunks.set(index, body); response.writeHead(204); response.end(); return;
    }
    response.writeHead(404); response.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test server address");
  const url = `http://127.0.0.1:${address.port}/#/projects/1`;
  let browser: Awaited<ReturnType<typeof startBrowser>> | undefined;
  let socket: WebSocket | undefined;
  try {
    const page = await Bun.build({ entrypoints: [new URL("./browser-fixture.tsx", import.meta.url).pathname], outdir: directory, naming: "fixture.[ext]", target: "browser" });
    const worker = await Bun.build({ entrypoints: [new URL("./hash-worker.ts", import.meta.url).pathname], outdir: directory, naming: "hash-worker.ts", target: "browser" });
    expect(page.success && worker.success).toBe(true);
    browser = await startBrowser(await browserPath(), profile, "about:blank");
    socket = new WebSocket((await findBrowserPage(Number(browser.port))).webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Browser connection timed out")), 5000);
      socket!.onopen = () => { clearTimeout(timer); resolve(); };
      socket!.onerror = () => { clearTimeout(timer); reject(new Error("Browser connection failed")); };
    });
    let nextId = 0;
    const pending = new Map<number, (value: any) => void>();
    socket.onmessage = event => { const message = JSON.parse(String(event.data)); if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id); } };
    const send = (method: string, params: object = {}) => new Promise<any>((resolve, reject) => {
      const requestId = ++nextId;
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`${method} timed out: ${JSON.stringify({ requests, sent })}`)); }, 20000);
      pending.set(requestId, value => { clearTimeout(timer); if (value.error) reject(new Error(JSON.stringify(value.error))); else resolve(value.result); });
      socket!.send(JSON.stringify({ id: requestId, method, params }));
    });
    const evaluate = async (expression: string) => {
      const answer = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (answer.exceptionDetails) throw new Error(JSON.stringify(answer.exceptionDetails));
      return answer.result.value;
    };
    const wait = async (expression: string) => {
      const result = await evaluate(`new Promise((resolve, reject) => { const end = Date.now() + 15000; const check = () => { if (${expression}) resolve(true); else if (Date.now() > end) reject(new Error('condition timed out')); else setTimeout(check, 30); }; check(); })`);
      if (result !== true) throw new Error(`Waiting for ${expression}: ${JSON.stringify({ requests, sent, text: await evaluate("document.body.innerText") })}`);
      expect(result).toBe(true);
    };
    const select = async (selector: string, path: string) => {
      const root = (await send("DOM.getDocument")).root.nodeId;
      const nodeId = (await send("DOM.querySelector", { nodeId: root, selector })).nodeId;
      expect(nodeId).toBeGreaterThan(0);
      await send("DOM.setFileInputFiles", { nodeId, files: [path] });
    };
    const key = async (value: string) => {
      const code = value === " " ? "Space" : value;
      const windowsVirtualKeyCode = value === " " ? 32 : value === "Enter" ? 13 : 9;
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: value, code, windowsVirtualKeyCode });
      if (value === "Enter") await send("Input.dispatchKeyEvent", { type: "char", text: "\r", unmodifiedText: "\r", key: value, code, windowsVirtualKeyCode });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: value, code, windowsVirtualKeyCode });
    };
    const focusByTab = async (expression: string) => {
      await evaluate("document.activeElement.blur()");
      for (let index = 0; index < 30; index++) {
        await key("Tab");
        if (await evaluate(expression)) {
          expect(await evaluate("getComputedStyle(document.activeElement).outlineStyle !== 'none' && getComputedStyle(document.activeElement).outlineWidth !== '0px'")).toBe(true);
          return;
        }
      }
      throw new Error(`Could not focus ${expression}`);
    };
    await send("Page.enable");
    await send("Page.navigate", { url });
    await wait("document.querySelector('#upload-files')");
    expect(await evaluate("document.body.textContent.includes('Photos arrived: 0')")).toBe(true);
    await focusByTab("document.activeElement.id === 'upload-files'");
    await focusByTab("document.activeElement.id === 'upload-folder'");
    await select("#upload-files", file);
    await wait("document.querySelector('[role=alert]')?.textContent.includes('could not reach')");
    expect(sent[0]).toBe(0);
    expect(sent.slice(1).every(index => index === 1)).toBe(true);
    expect(cuts).toBeGreaterThan(0);
    expect([...chunks.keys()]).toEqual([0]);
    await wait("Array.from(document.querySelectorAll('button')).some(button => button.textContent.startsWith('Retry '))");
    await focusByTab("document.activeElement.textContent.startsWith('Retry ')");
    await key(" ");
    await wait("document.body.textContent.includes('Files remaining: 1')");
    await wait("document.querySelector('[role=alert]')?.textContent.includes('could not reach')");
    expect(statusRequests).toBe(1);
    const interrupted = sent.length;
    const beforeReload = projectRequests;
    await send("Page.reload");
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 10000;
      const check = () => { if (projectRequests > beforeReload) resolve(); else if (Date.now() > deadline) reject(new Error("Page did not reload")); else setTimeout(check, 20); };
      check();
    });
    await wait("document.querySelector('[id^=upload-reselect-]')");
    expect(await evaluate("document.body.textContent.includes('Select the original file to resume.')")).toBe(true);
    expect(await evaluate("!Array.from(document.querySelectorAll('button')).some(button => button.textContent.startsWith('Retry '))")).toBe(true);
    await focusByTab("document.activeElement.id.startsWith('upload-reselect-')");
    await select("[id^=upload-reselect-]", wrong);
    await wait("document.querySelector('[role=alert]')?.textContent.includes('does not match')");
    expect(sent.length).toBe(interrupted);
    await evaluate("document.querySelector('#project-name').focus(); document.querySelector('#project-name').select()");
    await send("Input.insertText", { text: "Unsaved name" });
    await evaluate("document.querySelector('#project-notes').focus(); document.querySelector('#project-notes').select()");
    await send("Input.insertText", { text: "Unsaved notes" });
    const beforeRefresh = projectRequests;
    cutting = false;
    await select("[id^=upload-reselect-]", file);
    await wait("document.querySelector('table')?.textContent.includes('flight.jpg')");
    expect(sent.slice(interrupted)).toEqual([1, 1, 2]);
    expect(damagedChunks).toBe(1);
    expect(statusRequests).toBe(2);
    expect(completedHash).toBe(digest);
    await wait("document.body.textContent.includes('Photos arrived: 1')");
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const check = () => { if (projectRequests > beforeRefresh) resolve(); else if (Date.now() > deadline) reject(new Error("Project did not refresh")); else setTimeout(check, 20); };
      check();
    });
    await wait("document.querySelector('h1')?.textContent === 'Survey updated'");
    expect(await evaluate("document.querySelector('#project-name').value + '|' + document.querySelector('#project-notes').value")).toBe("Unsaved name|Unsaved notes");
    expect(await evaluate("document.querySelector('table').textContent.includes('2 MiB')")).toBe(true);
    await evaluate(`(() => { const data = new DataTransfer(); data.items.add(new File(['x'], 'notes.txt')); data.items.add(new File(['x'], 'archive.zip')); document.querySelector('#upload-files').closest('section').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data })); })()`);
    await wait("document.querySelector('summary')?.textContent.includes('Skipped files: 2')");
    expect(await evaluate("document.querySelector('[role=alert]').textContent.includes('later version')")).toBe(true);
    await focusByTab("document.activeElement.tagName === 'SUMMARY'");
    await key(" ");
    expect(await evaluate("document.querySelector('details').open && document.querySelector('details').textContent.includes('archive.zip')")).toBe(true);
    await key("Enter");
    expect(await evaluate("!document.querySelector('details').open")).toBe(true);
    await select("#upload-folder", folder);
    await wait("document.querySelector('summary')?.textContent.includes('Skipped files: 3')");
    expect(await evaluate("document.querySelector('details').textContent.includes('flight-folder/ignored.zip')")).toBe(true);
    expect(await evaluate("Array.from(document.querySelectorAll('input')).every(input => !!input.labels?.length)")).toBe(true);
    chunks.clear(); completed = false; blocking = true;
    await select("#upload-files", file);
    await wait("Array.from(document.querySelectorAll('button')).some(button => button.textContent === 'Cancel uploads')");
    await wait("document.body.textContent.includes('Files remaining: 1')");
    await focusByTab("document.activeElement.textContent === 'Cancel uploads'");
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 10000;
      const check = () => { if (blocked) resolve(); else if (Date.now() > deadline) reject(new Error("Upload did not reach the barrier")); else setTimeout(check, 20); };
      check();
    });
    await key(" ");
    await wait("!document.body.textContent.includes('Cancel uploads')");
    expect(deletes).toBe(1);
    blocking = false;
    const beforeDrop = sent.length;
    await evaluate(`(() => { const data = new DataTransfer(); const bytes = Uint8Array.from({ length: ${bytes.length} }, (_, index) => (index * 37 + 11) % 251); data.items.add(new File([bytes], 'flight.jpg')); document.querySelector('#upload-files').closest('section').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data })); })()`);
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 10000;
      const check = () => { if (completed) resolve(); else if (Date.now() > deadline) reject(new Error("Dropped file did not complete")); else setTimeout(check, 20); };
      check();
    });
    expect(sent.slice(beforeDrop)).toEqual([0, 1, 2]);
    expect(completedHash).toBe(digest);
    await wait("document.querySelector('#upload-files')?.disabled === false");
    await evaluate(`(() => {
      const event = new DragEvent('drop', { bubbles: true, cancelable: true });
      const file = new File(['delayed'], 'delayed.jpg');
      window.staleFileReads = 0;
      Object.defineProperty(file, 'size', { get() { window.staleFileReads++; return 7; } });
      Object.defineProperty(event, 'dataTransfer', { value: { items: [{ webkitGetAsEntry: () => ({ name: 'delayed.jpg', isFile: true, file(done) { window.finishDrop = () => done(file); } }) }], files: [] } });
      document.querySelector('#upload-files').closest('section').dispatchEvent(event);
    })()`);
    expect(await evaluate("typeof window.finishDrop")).toBe("function");
    await evaluate("location.hash = '#/projects/new'");
    await wait("document.querySelector('#project-name') && !document.querySelector('#upload-files')");
    expect(await evaluate("new Promise(resolve => { window.finishDrop(); setTimeout(() => resolve(window.staleFileReads), 0); })")).toBe(0);
    await evaluate("location.hash = '#/projects/2'");
    await wait("document.body.textContent.includes('Sample project') && !document.querySelector('#upload-files')");
  } finally {
    socket?.close();
    await browser?.stop();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);
