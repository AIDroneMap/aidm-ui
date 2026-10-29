import { hashBlob } from "./hash.ts";

self.onmessage = async (event: MessageEvent<Blob>) => {
  try { self.postMessage({ hash: await hashBlob(event.data) }); }
  catch { self.postMessage({ error: true }); }
};
