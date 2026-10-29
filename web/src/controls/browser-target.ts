type BrowserPage = { type: "page"; webSocketDebuggerUrl: string };
type Options = { deadlineMs?: number; requestTimeoutMs?: number; retryMs?: number };

export async function findBrowserPage(port: number, { deadlineMs = 5000, requestTimeoutMs = 1000, retryMs = 50 }: Options = {}): Promise<BrowserPage> {
  const deadline = Date.now() + deadlineMs;
  let lastError = "no page target";
  while (Date.now() < deadline) {
    try {
      const remaining = deadline - Date.now();
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(Math.max(1, Math.min(requestTimeoutMs, remaining))) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const targets: unknown = await response.json();
      if (!Array.isArray(targets)) throw new Error("invalid target list");
      const page = targets.find((target): target is BrowserPage => target?.type === "page" && typeof target.webSocketDebuggerUrl === "string");
      if (page) return page;
      lastError = "no page target";
    } catch (error) {
      lastError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      if (error instanceof Error && error.message.startsWith("HTTP ")) lastError = error.message;
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await Bun.sleep(Math.min(retryMs, remaining));
  }
  throw new Error(`DevTools target discovery timed out: ${lastError}`);
}
