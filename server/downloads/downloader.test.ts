import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeFileServer } from "../../test-support/fake-file-server.ts";
import { downloadVerified, type DownloadTarget } from "./downloader.ts";

const data = Uint8Array.from({ length: 300_000 }, (_, i) => (i * 31 + (i >> 8)) & 0xff);
const SHA = new Bun.CryptoHasher("sha256").update(data).digest("hex");
const FAST = { backoffMs: () => 5 };
const PLENTY = () => Number.MAX_SAFE_INTEGER;

/** Wraps a function so it can stand in for fetch. */
function asFetch(fn: (input: Request | URL | string, init?: RequestInit) => Promise<Response>): typeof fetch {
  return Object.assign(fn, { preconnect: fetch.preconnect }) as typeof fetch;
}

/** A fetch whose bodies arrive in small pieces, so a test can stop between them. */
const inSmallPieces = asFetch(async (input, init) => {
  const response = await fetch(input, init);
  const reader = response.body!.getReader();
  const pieces = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) return controller.close();
      for (let at = 0; at < value.length; at += 10_000) {
        controller.enqueue(value.subarray(at, at + 10_000));
      }
      await Bun.sleep(1);
    },
    cancel: () => reader.cancel(),
  });
  return new Response(pieces, { status: response.status, headers: response.headers });
});

let root = "";
let server: FakeFileServer;
let n = 0;
let target: DownloadTarget;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "aidm-download-"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

beforeEach(async () => {
  server = new FakeFileServer({ "/data.bin": data });
  await server.start();
  n++;
  target = {
    url: server.url("/data.bin"),
    size: data.length,
    sha256: SHA,
    path: join(root, `run-${n}`, "nested", "data.bin"),
  };
});
afterEach(async () => {
  await server.stop();
});

async function finalBytes(): Promise<Uint8Array> {
  return new Uint8Array(await Bun.file(target.path).arrayBuffer());
}

test("downloads a file, reports progress up to the total, verifies it and leaves no part", async () => {
  const seen: Array<[number, number]> = [];
  const outcome = await downloadVerified(target, {
    freeBytes: PLENTY,
    onProgress: (received, total) => seen.push([received, total]),
  });
  expect(outcome).toEqual({ ok: true, path: target.path });
  expect(await finalBytes()).toEqual(data);
  expect(existsSync(`${target.path}.part`)).toBe(false);
  expect(seen.at(-1)).toEqual([data.length, data.length]);
  expect(seen.every(([, total]) => total === data.length)).toBe(true);
  const received = seen.map(([r]) => r);
  expect(received).toEqual([...received].sort((a, b) => a - b));
});

test("killing the server mid-download and restarting it resumes from the bytes already received", async () => {
  server.cutNextResponseAfter(100_000);
  const restarting = (async () => {
    // Wait for the first request, then take the server away for a moment.
    while (server.requests.length === 0) await Bun.sleep(1);
    await server.stop();
    await Bun.sleep(60);
    await server.restart();
  })();
  const outcome = await downloadVerified(target, {
    freeBytes: PLENTY,
    backoffMs: () => 40,
    retries: 20,
  });
  await restarting;
  expect(outcome).toEqual({ ok: true, path: target.path });
  expect(await finalBytes()).toEqual(data);
  const gets = server.requests.filter((r) => r.method === "GET");
  expect(gets[0]?.range).toBeNull();
  const resumed = gets.find((r) => r.range !== null);
  const from = Number(/^bytes=(\d+)-$/.exec(resumed?.range ?? "")?.[1]);
  expect(from).toBeGreaterThan(0);
  expect(from).toBeLessThanOrEqual(100_000);
});

test("a connection cut mid-body is retried with a Range header from the bytes that arrived", async () => {
  server.cutNextResponseAfter(120_000);
  const outcome = await downloadVerified(target, { freeBytes: PLENTY, ...FAST });
  expect(outcome.ok).toBe(true);
  expect(await finalBytes()).toEqual(data);
  const ranges = server.requests.map((r) => r.range);
  expect(ranges[0]).toBeNull();
  expect(ranges[1]).toMatch(/^bytes=[1-9]\d*-$/);
});

test("gives up with download.failed after the retries when the host keeps failing", async () => {
  let calls = 0;
  const failing = asFetch(async () => {
    calls++;
    return new Response("Busy", { status: 503 });
  });
  const outcome = await downloadVerified(target, { freeBytes: PLENTY, ...FAST, retries: 2, fetch: failing });
  expect(outcome).toEqual({ ok: false, error: { code: "download.failed", data: {} } });
  expect(calls).toBe(3);
});

test("a 4xx answer other than 408 and 429 fails at once without retries", async () => {
  server.files.delete("/data.bin");
  const missing = await downloadVerified(target, { freeBytes: PLENTY, ...FAST, retries: 5 });
  expect(missing).toEqual({ ok: false, error: { code: "download.failed", data: {} } });
  expect(server.requests).toHaveLength(1);

  let calls = 0;
  const forbidden = asFetch(async () => {
    calls++;
    return new Response("No", { status: 403 });
  });
  const refused = await downloadVerified(target, { freeBytes: PLENTY, ...FAST, retries: 5, fetch: forbidden });
  expect(refused).toEqual({ ok: false, error: { code: "download.failed", data: {} } });
  expect(calls).toBe(1);
});

test("408 and 429 are retried like a server error", async () => {
  const answers = [408, 429];
  const slowHost = asFetch(async (input, init) => {
    const status = answers.shift();
    if (status !== undefined) return new Response("Wait", { status });
    return fetch(input, init);
  });
  const outcome = await downloadVerified(target, { freeBytes: PLENTY, ...FAST, retries: 5, fetch: slowHost });
  expect(outcome).toEqual({ ok: true, path: target.path });
  expect(answers).toEqual([]);
});

test("a corrupted file fails verification and is discarded", async () => {
  const bad = new Uint8Array(data);
  bad[1000] = (bad[1000] ?? 0) ^ 0xff;
  server.files.set("/data.bin", bad);
  const outcome = await downloadVerified(target, { freeBytes: PLENTY, ...FAST });
  expect(outcome).toEqual({ ok: false, error: { code: "download.checksum_mismatch", data: {} } });
  expect(existsSync(target.path)).toBe(false);
  expect(existsSync(`${target.path}.part`)).toBe(false);
  expect(server.requests).toHaveLength(1);
});

test("a 200 answer to a Range request starts over and still verifies", async () => {
  const dir = join(root, `run-${n}`, "nested");
  await Bun.write(join(dir, "data.bin.part"), data.subarray(0, 50_000));
  const plain = server.url("/plain.bin");
  server.files.set("/plain.bin", data);
  // A host that ignores Range answers 200 with the whole body.
  const ignoringRange = asFetch((input, init) => {
    const headers = new Headers(init?.headers);
    headers.delete("range");
    return fetch(input, { ...init, headers });
  });
  const seenRanges: Array<string | null> = [];
  const spy = asFetch((input, init) => {
    seenRanges.push(new Headers(init?.headers).get("range"));
    return ignoringRange(input, init);
  });
  const outcome = await downloadVerified({ ...target, url: plain }, { freeBytes: PLENTY, fetch: spy });
  expect(outcome.ok).toBe(true);
  expect(seenRanges).toEqual(["bytes=50000-"]);
  expect(await finalBytes()).toEqual(data);
  expect(existsSync(`${target.path}.part`)).toBe(false);
});

test("not enough free space gives download.not_enough_space with the bytes and makes no request", async () => {
  const outcome = await downloadVerified(target, { freeBytes: () => 1000 });
  expect(outcome).toEqual({
    ok: false,
    error: {
      code: "download.not_enough_space",
      data: { needed: data.length * 1.2, free: 1000 },
    },
  });
  expect(server.requests).toHaveLength(0);
});

test("the space needed counts the bytes already in the part", async () => {
  const dir = join(root, `run-${n}`, "nested");
  await Bun.write(join(dir, "data.bin.part"), data.subarray(0, 200_000));
  const needed = data.length - 200_000 + 0.2 * data.length;
  const tooLittle = await downloadVerified(target, { freeBytes: () => needed - 1 });
  expect(tooLittle.ok).toBe(false);
  expect(server.requests).toHaveLength(0);
  const enough = await downloadVerified(target, { freeBytes: () => needed });
  expect(enough.ok).toBe(true);
  expect(server.requests[0]?.range).toBe("bytes=200000-");
});

test("an existing verified file makes no request", async () => {
  await Bun.write(target.path, data);
  const outcome = await downloadVerified(target, { freeBytes: () => 0 });
  expect(outcome).toEqual({ ok: true, path: target.path });
  expect(server.requests).toHaveLength(0);
});

test("an existing file that does not verify is deleted and downloaded again", async () => {
  await Bun.write(target.path, "not the dataset");
  const outcome = await downloadVerified(target, { freeBytes: PLENTY });
  expect(outcome.ok).toBe(true);
  expect(await finalBytes()).toEqual(data);
  expect(server.requests).toHaveLength(1);
});

test("a part that is already complete is verified without a download (416)", async () => {
  await Bun.write(`${target.path}.part`, data);
  const outcome = await downloadVerified(target, { freeBytes: PLENTY });
  expect(outcome.ok).toBe(true);
  expect(await finalBytes()).toEqual(data);
});

test("a 416 answer to a part shorter than the file deletes the part and starts over from byte 0", async () => {
  await Bun.write(`${target.path}.part`, data.subarray(0, 1000));
  const ranges: Array<string | null> = [];
  const refusesTheRange = asFetch(async (input, init) => {
    const range = new Headers(init?.headers).get("range");
    ranges.push(range);
    if (range !== null) return new Response(null, { status: 416 });
    return fetch(input, init);
  });
  const outcome = await downloadVerified(target, { freeBytes: PLENTY, fetch: refusesTheRange, ...FAST });
  expect(outcome).toEqual({ ok: true, path: target.path });
  expect(ranges).toEqual(["bytes=1000-", null]);
  expect(await finalBytes()).toEqual(data);
  expect(existsSync(`${target.path}.part`)).toBe(false);
});

test("a host that answers 416 again after the fresh start fails with download.failed", async () => {
  await Bun.write(`${target.path}.part`, data.subarray(0, 1000));
  let calls = 0;
  const always416 = asFetch(async () => {
    calls++;
    return new Response(null, { status: 416 });
  });
  const outcome = await downloadVerified(target, { freeBytes: PLENTY, fetch: always416, ...FAST });
  expect(outcome).toEqual({ ok: false, error: { code: "download.failed", data: {} } });
  expect(calls).toBe(2);
  expect(existsSync(`${target.path}.part`)).toBe(false);
});

test("cancelling while an existing file is being checked stops with download.cancelled", async () => {
  await Bun.write(target.path, data);
  const outcome = await downloadVerified(target, { freeBytes: PLENTY, signal: AbortSignal.abort() });
  expect(outcome).toEqual({ ok: false, error: { code: "download.cancelled", data: {} } });
  expect(server.requests).toHaveLength(0);
});

test("cancelling keeps the part, and a second call resumes from it", async () => {
  const controller = new AbortController();
  const outcome = await downloadVerified(target, {
    freeBytes: PLENTY,
    fetch: inSmallPieces,
    signal: controller.signal,
    onProgress: (received) => {
      if (received >= 100_000) controller.abort();
    },
  });
  expect(outcome).toEqual({ ok: false, error: { code: "download.cancelled", data: {} } });
  expect(existsSync(target.path)).toBe(false);
  const kept = Bun.file(`${target.path}.part`).size;
  expect(kept).toBeGreaterThanOrEqual(100_000);

  const again = await downloadVerified(target, { freeBytes: PLENTY });
  expect(again.ok).toBe(true);
  expect(await finalBytes()).toEqual(data);
  expect(server.requests.at(-1)?.range).toBe(`bytes=${kept}-`);
});

test("a signal that is already aborted makes no request", async () => {
  const outcome = await downloadVerified(target, { freeBytes: PLENTY, signal: AbortSignal.abort() });
  expect(outcome).toEqual({ ok: false, error: { code: "download.cancelled", data: {} } });
  expect(server.requests).toHaveLength(0);
});

test("a redirect is followed and the Range header survives it", async () => {
  server.files.set("/store/blob", data);
  server.redirects.set("/data.bin", "/store/blob");
  await Bun.write(`${target.path}.part`, data.subarray(0, 70_000));
  const outcome = await downloadVerified(target, { freeBytes: PLENTY });
  expect(outcome.ok).toBe(true);
  expect(await finalBytes()).toEqual(data);
  expect(server.requests.map((r) => [r.path, r.range])).toEqual([
    ["/data.bin", "bytes=70000-"],
    ["/store/blob", "bytes=70000-"],
  ]);
});

test("a file longer than the pinned size is stopped and discarded", async () => {
  server.files.set("/data.bin", new Uint8Array(data.length * 2));
  const outcome = await downloadVerified(target, { freeBytes: PLENTY, ...FAST });
  expect(outcome).toEqual({ ok: false, error: { code: "download.checksum_mismatch", data: {} } });
  expect(existsSync(`${target.path}.part`)).toBe(false);
  expect(existsSync(target.path)).toBe(false);
});

test("a link that keeps breaking but makes progress each time is not given up", async () => {
  // Every response breaks after a quarter of the file: four attempts are needed,
  // more than the two retries allowed, yet each one brings new bytes.
  const cutEvery = asFetch(async (input, init) => {
    server.cutNextResponseAfter(data.length / 4);
    return fetch(input, init);
  });
  const outcome = await downloadVerified(target, { freeBytes: PLENTY, ...FAST, retries: 2, fetch: cutEvery });
  expect(outcome).toEqual({ ok: true, path: target.path });
  expect(await finalBytes()).toEqual(data);
});
