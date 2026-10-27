import { expect, test } from "bun:test";
import { FakeTaskApi } from "../../test-support/fake-task-api.ts";
import { TaskClient } from "./task-client.ts";
import { UNREACHABLE_SUMMARY_MS, UnreachableLines } from "./unreachable-lines.ts";

const START = Date.UTC(2026, 9, 27, 9, 0, 0);

function clock() {
  let now = START;
  return { now: () => now, pass: (ms: number) => (now += ms) };
}

test("after three failures in a row, one summary a minute says how many since when and the last error", () => {
  const time = clock();
  const lines: string[] = [];
  const record = new UnreachableLines((line) => lines.push(line), time.now);
  // A poll every 3 s for five minutes.
  for (let n = 0; n < 100; n++) {
    record.failed("http://127.0.0.1:54794", "http://127.0.0.1:54794/info", "ECONNRESET");
    time.pass(3000);
  }
  expect(lines.slice(0, 3)).toEqual(Array(3).fill("Could not reach http://127.0.0.1:54794/info: ECONNRESET"));
  const summaries = lines.slice(3);
  expect(summaries).toHaveLength(Math.floor((99 * 3000 - 2 * 3000) / UNREACHABLE_SUMMARY_MS));
  expect(summaries[0]).toBe("Still unreachable: http://127.0.0.1:54794, 23 failures since 2026-10-27T09:00:00.000Z, last error ECONNRESET");

  record.answered("http://127.0.0.1:54794");
  expect(lines.at(-1)).toBe("http://127.0.0.1:54794 answers again, after 100 failures since 2026-10-27T09:00:00.000Z");
  // A new streak starts in full again.
  record.failed("http://127.0.0.1:54794", "http://127.0.0.1:54794/info", "ECONNRESET");
  expect(lines.at(-1)).toBe("Could not reach http://127.0.0.1:54794/info: ECONNRESET");
});

test("an error that changes is logged at once, and a short streak ends without a line", () => {
  const time = clock();
  const lines: string[] = [];
  const record = new UnreachableLines((line) => lines.push(line), time.now);
  for (let n = 0; n < 5; n++) record.failed("a", "a/info", "ECONNRESET");
  record.failed("a", "a/info", "No answer within 10000 ms.");
  expect(lines).toEqual([
    "Could not reach a/info: ECONNRESET",
    "Could not reach a/info: ECONNRESET",
    "Could not reach a/info: ECONNRESET",
    "Could not reach a/info: No answer within 10000 ms.",
  ]);
  const other = new UnreachableLines((line) => lines.push(line), time.now);
  other.failed("b", "b/info", "ECONNREFUSED");
  other.answered("b");
  expect(lines.at(-1)).toBe("Could not reach b/info: ECONNREFUSED");
});

test("clients of one engine share the streak, and an answer from any of them ends it", async () => {
  const lines: string[] = [];
  const record = new UnreachableLines((line) => lines.push(line));
  const gone = { address: "http://127.0.0.1:1", token: "t" };
  for (let n = 0; n < 5; n++) await new TaskClient(gone, { unreachable: record, timeoutMs: 1000 }).info();
  expect(lines.filter((line) => line.startsWith("Could not reach"))).toHaveLength(3);

  const api = new FakeTaskApi({ token: "t" });
  await api.start();
  try {
    for (let n = 0; n < 4; n++) record.failed(api.address, `${api.address}/info`, "ECONNRESET");
    await new TaskClient({ address: api.address, token: "t" }, { unreachable: record }).info();
    expect(lines.at(-1)).toMatch(new RegExp(`^${api.address.replaceAll(".", "\\.")} answers again, after 4 failures since `));
  } finally {
    await api.stop();
  }
});
