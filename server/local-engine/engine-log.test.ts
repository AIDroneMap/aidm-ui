import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import type { EnginePackage } from "../packages/engine-package.ts";
import { eventually } from "../testing/harness.ts";
import { EngineLog, LOG_LINE_MAX_BYTES, LOG_MEMORY_LINES } from "./engine-log.ts";

let folder: string;
let token: string | null;
let logs: EngineLog[];

beforeEach(() => {
  folder = mkdtempSync(join(os.tmpdir(), "aidm-ui-log-test-"));
  token = null;
  logs = [];
});

afterEach(async () => {
  for (const log of logs) await log.stop();
  rmSync(folder, { recursive: true, force: true });
});

function make(options: { rotateBytes?: number; retryBackoffMs?: number } = {}): EngineLog {
  const log = new EngineLog({ dataFolder: folder, token: () => token, log: () => {}, retryBackoffMs: 5, ...options });
  logs.push(log);
  return log;
}

interface ScriptedStream {
  /** What each call of logs sends, in order. A call past the end waits for the abort. */
  streams: string[][];
  calls: Array<{ follow: boolean; tail: number | undefined }>;
  state: "running" | "stopped";
}

/** A package whose log ends by itself, as a stream does when the tool behind it dies. */
function scripted(script: ScriptedStream): EnginePackage {
  return {
    kind: "container",
    preflight: async () => ({ ok: true, value: undefined }),
    install: async () => ({ ok: true, value: undefined }),
    start: async () => ({ ok: true, value: { address: "" } }),
    stop: async () => ({ ok: true, value: undefined }),
    removeContainer: async () => ({ ok: true, value: undefined }),
    remove: async () => ({ ok: true, value: undefined }),
    status: async () => ({ ok: true, value: { state: script.state, exitCode: null } }),
    logs: async (options) => {
      script.calls.push({ follow: options.follow, tail: options.tail });
      const lines = script.streams[script.calls.length - 1];
      if (lines === undefined) {
        await new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve(), { once: true }));
        return { ok: true, value: undefined };
      }
      for (const line of lines) options.onLine(line);
      return { ok: true, value: undefined };
    },
  };
}

test("lines go to engine.log in the logs folder", async () => {
  const log = make();
  const script: ScriptedStream = { streams: [["one", "two"]], calls: [], state: "stopped" };
  log.follow(scripted(script), { fresh: true });
  await eventually(async () => !log.isFollowing());
  expect(readFileSync(join(folder, "logs", "engine.log"), "utf8")).toBe("one\ntwo\n");
  expect(log.lines()).toEqual(["one", "two"]);
});

test("the last 500 lines are kept for a listener that comes later, and a listener hears each new line", async () => {
  const log = make();
  const many = Array.from({ length: LOG_MEMORY_LINES + 20 }, (_, index) => `line ${index}`);
  const script: ScriptedStream = { streams: [many], calls: [], state: "running" };
  log.follow(scripted(script), { fresh: true });
  await eventually(async () => log.lines().length === LOG_MEMORY_LINES && script.calls.length >= 2);
  expect(log.lines()[0]).toBe("line 20");
  expect(log.lines().at(-1)).toBe(`line ${LOG_MEMORY_LINES + 19}`);
});

test("a line that holds the token is cleaned before it is kept or written", async () => {
  token = "secret-token-value";
  const log = make();
  const heard: string[] = [];
  log.subscribe((lines) => heard.push(...lines));
  log.follow(scripted({ streams: [["token is secret-token-value here"]], calls: [], state: "stopped" }), { fresh: true });
  await eventually(async () => !log.isFollowing());
  expect(log.lines()).toEqual(["token is [token] here"]);
  expect(heard).toEqual(["token is [token] here"]);
  expect(readFileSync(join(folder, "logs", "engine.log"), "utf8")).not.toContain("secret-token-value");
});

test("a line longer than 4 KiB is cut with three dots, in the memory, the file and what listeners hear", async () => {
  const log = make();
  const heard: string[] = [];
  log.subscribe((lines) => heard.push(...lines));
  const long = "x".repeat(60_000);
  log.follow(scripted({ streams: [["short", long, "after"]], calls: [], state: "stopped" }), { fresh: true });
  await eventually(async () => !log.isFollowing());
  const cut = `${"x".repeat(LOG_LINE_MAX_BYTES - 3)}...`;
  expect(log.lines()).toEqual(["short", cut, "after"]);
  expect(heard).toEqual(["short", cut, "after"]);
  expect(readFileSync(join(folder, "logs", "engine.log"), "utf8")).toBe(`short\n${cut}\nafter\n`);
  expect(Buffer.byteLength(cut)).toBe(4096);
});

test("a line is cut between characters, never through one", async () => {
  const log = make();
  // Each "é" is two bytes, so 3000 of them are 6000 bytes and the cut falls inside a character.
  log.follow(scripted({ streams: [["é".repeat(3000)]], calls: [], state: "stopped" }), { fresh: true });
  await eventually(async () => !log.isFollowing());
  const [line] = log.lines();
  expect(line?.endsWith("é...")).toBe(true);
  expect(line).not.toContain("\ufffd");
  expect(Buffer.byteLength(line ?? "")).toBeLessThanOrEqual(LOG_LINE_MAX_BYTES);
});

test("a token inside a long line is cleaned before the line is cut", async () => {
  token = "secret-token-value";
  const log = make();
  // The token would be cut in half at the 4 KiB mark if the line were cut first.
  const line = `${"y".repeat(4086)}secret-token-value${"z".repeat(100)}`;
  log.follow(scripted({ streams: [[line]], calls: [], state: "stopped" }), { fresh: true });
  await eventually(async () => !log.isFollowing());
  expect(log.lines()[0]).toContain("[token]");
  expect(log.lines()[0]).not.toContain("secret");
  expect(readFileSync(join(folder, "logs", "engine.log"), "utf8")).not.toContain("secret");
});

test("the file is rotated at the size limit and three old files are kept", async () => {
  const log = make({ rotateBytes: 100 });
  const lines = Array.from({ length: 60 }, (_, index) => `${String(index).padStart(2, "0")} ${"x".repeat(17)}`);
  log.follow(scripted({ streams: [lines], calls: [], state: "stopped" }), { fresh: true });
  await eventually(async () => !log.isFollowing());
  const file = join(folder, "logs", "engine.log");
  for (const name of [file, `${file}.1`, `${file}.2`, `${file}.3`]) expect(existsSync(name)).toBe(true);
  expect(existsSync(`${file}.4`)).toBe(false);
  // The newest lines are in the current file, older ones in higher numbers.
  expect(readFileSync(file, "utf8")).toContain("59 ");
  const oldest = readFileSync(`${file}.3`, "utf8");
  const newest = readFileSync(`${file}.1`, "utf8");
  expect(Number(oldest.slice(0, 2))).toBeLessThan(Number(newest.slice(0, 2)));
  for (const name of [file, `${file}.1`, `${file}.2`, `${file}.3`]) {
    expect(readFileSync(name).length).toBeLessThanOrEqual(100);
  }
});

test("a stream that ends while the container still runs is opened again, for what comes next only", async () => {
  const log = make();
  const script: ScriptedStream = { streams: [["first"], ["second"]], calls: [], state: "running" };
  log.follow(scripted(script), { fresh: true });
  await eventually(async () => log.lines().length === 2);
  expect(log.lines()).toEqual(["first", "second"]);
  expect(script.calls[0]).toEqual({ follow: true, tail: undefined });
  expect(script.calls[1]).toEqual({ follow: true, tail: 0 });
});

test("a stream that ends when the container has stopped is not opened again", async () => {
  const log = make();
  const script: ScriptedStream = { streams: [["only"]], calls: [], state: "stopped" };
  log.follow(scripted(script), { fresh: true });
  await eventually(async () => !log.isFollowing());
  expect(script.calls).toHaveLength(1);
});

test("stop ends the following and leaves the lines", async () => {
  const log = make();
  const script: ScriptedStream = { streams: [["kept"]], calls: [], state: "running" };
  log.follow(scripted(script), { fresh: true });
  await eventually(async () => script.calls.length >= 2);
  await log.stop();
  expect(log.isFollowing()).toBe(false);
  expect(log.lines()).toEqual(["kept"]);
});

test("a new log starts with the last lines of the file from before", () => {
  const first = make();
  expect(first.lines()).toEqual([]);
  writeFileSync(join(folder, "logs", "engine.log"), "old one\nold two\n");
  expect(make().lines()).toEqual(["old one", "old two"]);
});
