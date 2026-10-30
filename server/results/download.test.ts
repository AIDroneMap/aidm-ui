import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadArchive } from "../downloads/downloader.ts";
const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });
function path() { const folder = mkdtempSync(join(tmpdir(), "archive-download-")); folders.push(folder); return join(folder, "archive.part"); }

test("archive download resumes a range and restarts when the task API ignores it", async () => {
  const target = path(); writeFileSync(target, "old");
  const requests: unknown[] = [];
  await downloadArchive(target, async headers => { requests.push(headers); return new Response("new archive", { headers: { "Content-Length": "11" } }); }, new AbortController().signal);
  expect(requests).toEqual([{ Range: "bytes=3-" }]);
  expect(await Bun.file(target).text()).toBe("new archive");
  writeFileSync(target, "new ");
  await downloadArchive(target, async () => new Response("archive", { status: 206, headers: { "Content-Range": "bytes 4-10/11", "Content-Length": "7" } }), new AbortController().signal);
  expect(await Bun.file(target).text()).toBe("new archive");
});

test("an interrupted archive response retries from its saved byte count", async () => {
  const target = path(); let attempts = 0;
  await downloadArchive(target, async headers => {
    attempts++;
    if (attempts === 1) return new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("new ")); },
      pull(controller) { controller.error(new Error("connection cut")); },
    }));
    expect(headers).toEqual({ Range: "bytes=4-" });
    return new Response("archive", { status: 206, headers: { "Content-Range": "bytes 4-10/11" } });
  }, new AbortController().signal);
  expect(await Bun.file(target).text()).toBe("new archive");
});

test("invalid, truncated and cancelled responses cannot finish an archive", async () => {
  const target = path(); writeFileSync(target, "old");
  await expect(downloadArchive(target, async () => new Response("oops", { status: 206, headers: { "Content-Range": "bytes 2-5/6" } }), new AbortController().signal)).rejects.toThrow();
  await expect(downloadArchive(target, async () => new Response("cut", { headers: { "Content-Length": "90" } }), new AbortController().signal)).rejects.toThrow();
  const controller = new AbortController(); controller.abort();
  await expect(downloadArchive(target, async () => { throw new Error("must not request"); }, controller.signal)).rejects.toThrow();
});
