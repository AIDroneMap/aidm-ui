import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function startBrowser(executable: string, dir: string, url: string, timeoutMs = 15000) {
  const proc = Bun.spawn([executable, "--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--disable-background-networking", "--disable-crash-reporter", "--no-first-run", "--no-default-browser-check", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1", `--user-data-dir=${dir}`, "--remote-debugging-port=0", url], { stdout: "ignore", stderr: "pipe" });
  let stderr = "";
  const drain = (async () => {
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        stderr = (stderr + decoder.decode(value, { stream: true })).slice(-16000);
      }
    } finally { reader.releaseLock(); }
  })();
  const stop = async () => {
    if (proc.exitCode === null) proc.kill("SIGKILL");
    await Promise.race([proc.exited, Bun.sleep(2000)]);
    await Promise.race([drain, Bun.sleep(2000)]);
  };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && proc.exitCode === null) {
    const port = (await readFile(join(dir, "DevToolsActivePort"), "utf8").catch(() => "")).split("\n")[0] ?? "";
    if (/^\d+$/.test(port)) return { port, stop, diagnostics: () => stderr };
    await Bun.sleep(50);
  }
  await stop();
  throw new Error(`Browser failed to start (${executable}, exit ${proc.exitCode ?? "timeout"}).\n${stderr}`);
}
