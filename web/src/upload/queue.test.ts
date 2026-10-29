import { expect, test } from "bun:test";
import { UploadQueue } from "./queue.ts";

test("limits active uploads and reports skipped files", async () => {
  let active = 0;
  let maximum = 0;
  const release: (() => void)[] = [];
  const queue = new UploadQueue(async () => {
    active++; maximum = Math.max(maximum, active);
    await new Promise<void>(resolve => release.push(resolve));
    active--;
    return { status: "complete" };
  }, 2);
  const result = queue.enqueue(1, ["a.jpg", "b.mov", "c.png", "d.zip", "e.txt"].map(name => ({ file: new File(["x"], name), name })), new AbortController().signal);
  await Promise.resolve();
  expect(maximum).toBe(2);
  expect(result.skipped.map(item => item.name)).toEqual(["d.zip", "e.txt"]);
  release.shift()!(); release.shift()!();
  await new Promise(resolve => setTimeout(resolve, 0));
  release.shift()!();
  expect((await result.done).length).toBe(3);
});

test("cancellation prevents queued files from starting", async () => {
  const abort = new AbortController();
  let started = 0;
  let finish!: () => void;
  const queue = new UploadQueue(async () => {
    started++;
    await new Promise<void>(resolve => { finish = resolve; });
    return { status: "cancelled" };
  }, 1);
  const result = queue.enqueue(1, ["a.jpg", "b.jpg"].map(name => ({ file: new File(["x"], name), name })), abort.signal);
  await Promise.resolve();
  abort.abort(); finish();
  expect(await result.done).toEqual([{ status: "cancelled" }, { status: "cancelled" }]);
  expect(started).toBe(1);
});
