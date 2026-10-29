export function hashInWorker(blob: Blob, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./hash-worker.ts", import.meta.url), { type: "module" });
    const finish = () => { worker.terminate(); signal.removeEventListener("abort", abort); };
    const abort = () => { finish(); reject(signal.reason ?? new DOMException("Aborted", "AbortError")); };
    signal.addEventListener("abort", abort, { once: true });
    worker.onerror = () => { finish(); reject(new Error("upload.hash_failed")); };
    worker.onmessage = (event: MessageEvent<{ hash?: string; error?: boolean }>) => {
      finish();
      if (event.data.hash) resolve(event.data.hash); else reject(new Error("upload.hash_failed"));
    };
    try { worker.postMessage(blob); }
    catch { finish(); reject(new Error("upload.hash_failed")); }
  });
}
