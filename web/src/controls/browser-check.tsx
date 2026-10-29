import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "./Button.tsx";
import { TextField } from "./TextField.tsx";
import { NumberField } from "./NumberField.tsx";
import { Select } from "./Select.tsx";
import { Toggle } from "./Toggle.tsx";
import { Disclosure } from "./Disclosure.tsx";
import { Table } from "./Table.tsx";
import { Dialog } from "./Dialog.tsx";
import { Notice } from "./Notice.tsx";
import { Progress } from "./Progress.tsx";

async function browserPath(): Promise<string> {
  const candidates = [process.env.CHROME_BIN, process.env.CHROMIUM_BIN, Bun.which("google-chrome"), Bun.which("chromium"), Bun.which("chromium-browser")];
  const cache = join(process.env.HOME ?? "", ".cache", "ms-playwright");
  for (const dir of await readdir(cache).catch(() => [])) {
    if (dir.startsWith("chromium-")) candidates.push(join(cache, dir, "chrome-linux64", "chrome"));
  }
  for (const path of candidates) if (path && await Bun.file(path).exists()) return path;
  throw new Error("A Chrome or Chromium executable is required for the control tests. Set CHROME_BIN.");
}

export async function browserCheck(): Promise<string[]> {
  const browser = await browserPath();
  const dir = await mkdtemp(join(tmpdir(), "aidm-controls-"));
  const root = new URL("../", import.meta.url);
  const styles = await Promise.all(["tokens.css", "styles.css", ...["Button", "TextField", "NumberField", "Select", "Toggle", "Disclosure", "Table", "Dialog", "Notice", "Progress"].map((name) => `controls/${name}.css`)].map((file) => readFile(new URL(file, root), "utf8")));
  const markup = renderToStaticMarkup(<><Button id="button">Button</Button><TextField id="text" label="Text" /><NumberField id="number" label="Number" /><Select id="select" label="Select"><option>A</option><option>B</option></Select><Toggle id="toggle" label="Toggle" /><Disclosure label="More">Details</Disclosure><Table label="Table"><tbody><tr><td>Cell</td></tr></tbody></Table><Notice>Notice</Notice><Progress id="progress" label="Progress" value={1} max={2} /><Dialog id="dialog" label="Dialog"><Button id="close">Close</Button></Dialog></>);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) { return new URL(req.url).pathname === "/" ? new Response(`<!doctype html><style>${styles.join("\n").replace(/@import[^;]+;/g, "")}</style>${markup}`, { headers: { "Content-Type": "text/html", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" } }) : new Response("", { status: 404 }); } });
  const proc = Bun.spawn([browser, "--headless", "--no-sandbox", "--disable-gpu", "--disable-background-networking", "--no-first-run", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1", `--user-data-dir=${dir}`, "--remote-debugging-port=0", `http://127.0.0.1:${server.port}/`], { stdout: "ignore", stderr: "ignore" });
  try {
    let port = "";
    for (let i = 0; i < 100 && !port; i++) { port = (await readFile(join(dir, "DevToolsActivePort"), "utf8").catch(() => "")).split("\n")[0] ?? ""; if (!port) await Bun.sleep(50); }
    if (!port) throw new Error("Browser did not start");
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { type: string; webSocketDebuggerUrl: string }[];
    const target = targets.find((item) => item.type === "page");
    if (!target) throw new Error("Browser fixture page is missing");
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error("DevTools connection failed")); });
    let id = 0;
    const pending = new Map<number, (value: any) => void>();
    ws.onmessage = (event) => { const message = JSON.parse(String(event.data)); if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id); } };
    const send = (method: string, params: object = {}) => new Promise<any>((resolve) => { const next = ++id; pending.set(next, resolve); ws.send(JSON.stringify({ id: next, method, params })); });
    const evaluate = async (expression: string) => { const response = await send("Runtime.evaluate", { expression, returnByValue: true }); if (response.error) throw new Error(JSON.stringify(response.error)); return response.result.result.value; };
    const failures: string[] = [];
    const check = (ok: unknown, name: string) => { if (!ok) failures.push(name); };
    await send("Page.enable");
    await send("Page.navigate", { url: `http://127.0.0.1:${server.port}/` });
    for (let i = 0; i < 100 && !(await evaluate("document.readyState === 'complete' && document.querySelector('#button') !== null").catch(() => false)); i++) await Bun.sleep(50);
    for (const name of ["button", "text", "number", "select", "toggle", "summary"]) {
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
      check(await evaluate(`(document.activeElement.id || document.activeElement.localName) === '${name}' && getComputedStyle(document.activeElement).outlineStyle !== 'none' && parseFloat(getComputedStyle(document.activeElement).outlineWidth) > 0`), `focus ${name}`);
      if (name === "button") {
        await evaluate("document.querySelector('#button').addEventListener('click', () => document.body.dataset.clicked = 'yes')");
        await send("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
        await send("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
        check(await evaluate("document.body.dataset.clicked === 'yes'"), "activate button");
      }
      if (name === "text" || name === "number") {
        await send("Input.insertText", { text: name === "text" ? "abc" : "2" });
        check(await evaluate(`document.querySelector('#${name}').value === '${name === "text" ? "abc" : "2"}'`), `edit ${name}`);
      }
      if (name === "select") {
        await send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 });
        await send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 });
        check(await evaluate("document.querySelector('#select').selectedIndex === 1"), "select choice");
      }
      if (name === "toggle" || name === "summary") {
        await send("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
        await send("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
        check(await evaluate(name === "toggle" ? "document.querySelector('#toggle').checked" : "document.querySelector('details').open"), `activate ${name}`);
      }
    }
    check(await evaluate("document.querySelector('table caption').textContent === 'Table' && document.querySelector('[role=status]').textContent === 'Notice' && document.querySelector('label[for=progress]') !== null"), "non-interactive labels");
    await evaluate("document.querySelector('dialog').showModal()");
    check(await evaluate("document.querySelector('dialog').open && document.activeElement.id === 'close'"), "dialog focus");
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    check(await evaluate("!document.querySelector('dialog').open"), "dialog escape");
    ws.close();
    return failures;
  } finally { proc.kill(); await proc.exited; server.stop(true); await rm(dir, { recursive: true, force: true }); }
}
