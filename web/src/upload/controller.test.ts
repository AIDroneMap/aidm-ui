import { expect, test } from "bun:test";
import { UploadController } from "./controller.ts";
import { hashBlob } from "./hash.ts";

test("hashes the whole file before sending missing chunks", async () => {
  const calls: string[] = [];
  const transport = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (path.endsWith("/uploads")) return Response.json({ id: "0123456789abcdef0123456789abcdef", chunkSize: 2, received: [0], complete: false });
    if (path.endsWith("/complete")) return Response.json({ id: "0123456789abcdef0123456789abcdef", chunkSize: 2, received: [0, 1], complete: true });
    return new Response(null, { status: 204 });
  };
  const controller = new UploadController({ fetch: transport, storage: new MapStorage(), hash: async (blob, signal) => { calls.push(`hash ${blob.size}`); return hashBlob(blob, signal); } });
  const result = await controller.upload(1, new File(["abcd"], "a.jpg"), "a.jpg", new AbortController().signal);
  expect(result.status).toBe("complete");
  expect(calls).toEqual(["hash 4", "POST /api/projects/1/uploads", "hash 2", "PUT /api/projects/1/uploads/0123456789abcdef0123456789abcdef/chunks/1", "POST /api/projects/1/uploads/0123456789abcdef0123456789abcdef/complete"]);
});

test("a failed transfer resumes only server-confirmed missing chunks after reselection", async () => {
  const storage = new MapStorage();
  const received = new Set<number>();
  const sent: number[] = [];
  let fail = true;
  const id = "0123456789abcdef0123456789abcdef";
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/uploads") || (path.endsWith(id) && !init?.method)) return Response.json({ id, chunkSize: 2, received: [...received], complete: false });
    if (path.endsWith("/complete")) return Response.json({ id, chunkSize: 2, received: [...received], complete: true });
    const index = Number(path.split("/").pop());
    sent.push(index);
    if (index === 1 && fail) { fail = false; throw new Error("network"); }
    received.add(index);
    return new Response(null, { status: 204 });
  };
  const options = { fetch: fetcher, storage, hash: hashBlob };
  const first = new UploadController(options);
  const file = new File(["abcdef"], "a.jpg");
  expect((await first.upload(1, file, "a.jpg", new AbortController().signal)).status).toBe("error");
  const second = new UploadController(options);
  const pending = second.pending(1)[0]!;
  expect(pending).toBeDefined();
  expect((await second.upload(1, new File(["xxxxxx"], "a.jpg"), "a.jpg", new AbortController().signal, undefined, pending))).toMatchObject({ status: "error", code: "upload.reselection_mismatch" });
  expect(sent).toEqual([0, 1]);
  expect((await second.upload(1, file, "a.jpg", new AbortController().signal, undefined, pending)).status).toBe("complete");
  expect(sent).toEqual([0, 1, 1, 2]);
  expect(second.pending(1)).toEqual([]);
});

test("a whole-file checksum failure reloads server state and resends once", async () => {
  const id = "0123456789abcdef0123456789abcdef";
  let completions = 0;
  const sent: number[] = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/uploads") || (path.endsWith(id) && !init?.method)) return Response.json({ id, chunkSize: 2, received: [], complete: false });
    if (path.endsWith("/complete")) {
      if (++completions === 1) return Response.json({ error: { code: "upload.checksum_mismatch", data: {} } }, { status: 400 });
      return Response.json({ id, chunkSize: 2, received: [0, 1], complete: true });
    }
    sent.push(Number(path.split("/").pop()));
    return new Response(null, { status: 204 });
  };
  const controller = new UploadController({ fetch: fetcher, storage: new MapStorage(), hash: hashBlob });
  expect((await controller.upload(1, new File(["abcd"], "a.jpg"), "a.jpg", new AbortController().signal)).status).toBe("complete");
  expect(sent).toEqual([0, 1, 0, 1]);
  expect(completions).toBe(2);
});

test("an expired session is reported and removed rather than recreated", async () => {
  const id = "0123456789abcdef0123456789abcdef";
  const storage = new MapStorage();
  const digest = await hashBlob(new Blob(["ab"]));
  storage.setItem("aidm.pendingUploads", JSON.stringify([{ projectId: 1, id, name: "a.jpg", size: 2, sha256: digest }]));
  const calls: string[] = [];
  const controller = new UploadController({ storage, hash: hashBlob, fetch: async (input, init) => {
    calls.push(`${init?.method ?? "GET"} ${input}`);
    return Response.json({ error: { code: "api.not_found", data: {} } }, { status: 404 });
  } });
  expect(await controller.upload(1, new File(["ab"], "a.jpg"), "a.jpg", new AbortController().signal, undefined, controller.pending(1)[0])).toMatchObject({ status: "error", code: "api.not_found" });
  expect(calls).toEqual([`GET /api/projects/1/uploads/${id}`]);
  expect(controller.pending(1)).toEqual([]);
});

test("cancellation during hashing sends nothing", async () => {
  const abort = new AbortController();
  let calls = 0;
  const controller = new UploadController({ storage: new MapStorage(), fetch: async () => { calls++; return new Response(); }, hash: async () => { abort.abort(); throw abort.signal.reason; } });
  expect(await controller.upload(1, new File(["ab"], "a.jpg"), "a.jpg", abort.signal)).toEqual({ status: "cancelled" });
  expect(calls).toBe(0);
});

class MapStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

test("unknown server error codes use the existing generic error", async () => {
  const controller = new UploadController({ storage: new MapStorage(), hash: hashBlob, fetch: async () => Response.json({ error: { code: "untrusted.message", data: {} } }, { status: 500 }) });
  expect(await controller.upload(1, new File(["ab"], "a.jpg"), "a.jpg", new AbortController().signal)).toMatchObject({ status: "error", code: "server.internal_error" });
});

test("cancelling a transfer stops chunks and cleans up independently of its aborted signal", async () => {
  const id = "0123456789abcdef0123456789abcdef";
  const storage = new MapStorage();
  const abort = new AbortController();
  const calls: string[] = [];
  let admitted!: () => void;
  const writing = new Promise<void>(resolve => { admitted = resolve; });
  const controller = new UploadController({ storage, hash: hashBlob, fetch: async (input, init) => {
    const path = String(input);
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (path.endsWith("/uploads")) return Response.json({ id, chunkSize: 2, received: [], complete: false });
    if (init?.method === "DELETE") {
      expect(init.signal?.aborted ?? false).toBe(false);
      return new Response(null, { status: 204 });
    }
    if (path.endsWith("/chunks/0")) {
      return await new Promise<Response>((_, reject) => {
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
        admitted();
      });
    }
    throw new Error("No further chunk or completion should run after cancellation");
  } });
  const sending = controller.upload(1, new File(["abcd"], "a.jpg"), "a.jpg", abort.signal);
  await writing;
  abort.abort();
  expect(await sending).toEqual({ status: "cancelled" });
  const entry = controller.pending(1)[0]!;
  expect(entry.id).toBe(id);
  expect(await controller.cancel(entry)).toEqual({ status: "cancelled" });
  expect(controller.pending(1)).toEqual([]);
  expect(calls).toEqual([`POST /api/projects/1/uploads`, `PUT /api/projects/1/uploads/${id}/chunks/0`, `DELETE /api/projects/1/uploads/${id}`]);
});

test("failed cancellation retains the session until cleanup succeeds", async () => {
  const storage = new MapStorage();
  const entry = { projectId: 1, id: "0123456789abcdef0123456789abcdef", name: "a.jpg", size: 2, sha256: await hashBlob(new Blob(["ab"])) };
  storage.setItem("aidm.pendingUploads", JSON.stringify([entry]));
  let requests = 0;
  const controller = new UploadController({ storage, fetch: async () => ++requests === 1
    ? Response.json({ error: { code: "project.deletion_busy", data: {} } }, { status: 409 })
    : new Response(null, { status: 204 }) });
  expect(await controller.cancel(entry)).toMatchObject({ status: "error", code: "project.deletion_busy" });
  expect(controller.pending(1)).toEqual([entry]);
  expect(await controller.cancel(entry)).toEqual({ status: "cancelled" });
  expect(controller.pending(1)).toEqual([]);
});
