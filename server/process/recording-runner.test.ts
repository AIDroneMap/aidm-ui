import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import os, { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedRunner } from "../../test-support/scripted-runner.ts";
import { MAX_LINES_PER_COMMAND, recordingRunner } from "./recording-runner.ts";

const TOKEN = "tok-0123456789abcdef";
let root: string | undefined;

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function tempFolder(): string {
  root = mkdtempSync(join(tmpdir(), "aidm-ui-recording-"));
  return root;
}

function allRecords(file: string): Array<Record<string, unknown>> {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The records of the commands, without the session record that opens the file. */
function records(file: string): Array<Record<string, unknown>> {
  return allRecords(file).filter((record) => record.kind !== "session");
}

function clock(): () => number {
  let time = Date.parse("2026-01-01T00:00:00Z");
  return () => (time += 10);
}

test("a run is recorded with its output, and the caller gets the inner result", async () => {
  const file = join(tempFolder(), "diagnostics", "commands.jsonl");
  const inner = new ScriptedRunner([
    { argv: ["docker", "version"], result: { exitCode: 1, stdout: "out\n", stderr: "bad\n" } },
  ]);
  const runner = recordingRunner(inner, { file, secrets: () => [], now: clock() });

  const result = await runner.run(["docker", "version"], { timeoutMs: 5 });

  expect(result).toEqual({ exitCode: 1, stdout: "out\n", stderr: "bad\n" });
  expect(records(file)).toEqual([
    {
      seq: 1,
      at: "2026-01-01T00:00:00.020Z",
      kind: "run",
      argv: ["docker", "version"],
      exitCode: 1,
      stdout: "out\n",
      stderr: "bad\n",
      durationMs: 10,
    },
  ]);
});

test("a stream is recorded as a start, its lines and an end, with the same number", async () => {
  const file = join(tempFolder(), "commands.jsonl");
  const inner = new ScriptedRunner([
    { argv: ["docker", "logs", "-f", "x"], result: { exitCode: 3, stdout: "a\nb\n", stderr: "c\n" } },
    { argv: ["true"], result: { exitCode: 0, stdout: "", stderr: "" } },
  ]);
  const runner = recordingRunner(inner, { file, secrets: () => [], now: clock() });
  await runner.run(["true"]);
  const seen: string[] = [];

  const result = await runner.stream(["docker", "logs", "-f", "x"], { onLine: (line, from) => seen.push(`${from}:${line}`) });

  expect(result.exitCode).toBe(3);
  expect(seen).toEqual(["stdout:a", "stdout:b", "stderr:c"]);
  const [, start, ...rest] = records(file);
  expect(start).toMatchObject({ seq: 2, kind: "stream-start", argv: ["docker", "logs", "-f", "x"] });
  expect(rest).toEqual([
    { seq: 2, kind: "line", from: "stdout", text: "a" },
    { seq: 2, kind: "line", from: "stdout", text: "b" },
    { seq: 2, kind: "line", from: "stderr", text: "c" },
    { seq: 2, kind: "stream-end", exitCode: 3, durationMs: expect.any(Number), droppedLines: 0 },
  ]);
});

test("the token is hidden in the file everywhere, and not in what the caller gets", async () => {
  const file = join(tempFolder(), "commands.jsonl");
  const argv = ["tool", "--url", `http://x/?t=${TOKEN}`];
  const inner = new ScriptedRunner([
    { argv, result: { exitCode: 0, stdout: `out ${TOKEN}\n`, stderr: `err ${TOKEN} ${TOKEN}\n` } },
  ]);
  const runner = recordingRunner(inner, { file, secrets: () => [TOKEN], now: clock() });

  const result = await runner.run(argv);
  await runner.stream(argv, { onLine: () => {} });

  expect(result.stdout).toContain(TOKEN);
  const text = readFileSync(file, "utf8");
  expect(text).not.toContain(TOKEN);
  const [run, start, outLine, errLine] = records(file);
  expect(run).toMatchObject({ argv: ["tool", "--url", "http://x/?t=***"], stdout: "out ***\n", stderr: "err *** ***\n" });
  expect(start).toMatchObject({ argv: ["tool", "--url", "http://x/?t=***"] });
  expect(outLine).toMatchObject({ text: "out ***" });
  expect(errLine).toMatchObject({ text: "err *** ***" });
});

test("the secrets are asked for again for each command", async () => {
  const file = join(tempFolder(), "commands.jsonl");
  const inner = new ScriptedRunner([{ argv: ["echo"], result: { exitCode: 0, stdout: "later-secret-value", stderr: "" } }]);
  let secrets: string[] = [];
  const runner = recordingRunner(inner, { file, secrets: () => secrets });

  await runner.run(["echo"]);
  secrets = ["later-secret-value"];
  await runner.run(["echo"]);

  expect(records(file).map((record) => record.stdout)).toEqual(["later-secret-value", "***"]);
});

test("the value after --token and the --token= form are hidden", async () => {
  const file = join(tempFolder(), "commands.jsonl");
  const inner = new ScriptedRunner([]);
  const runner = recordingRunner(inner, { file, secrets: () => [] });

  await runner.run(["engine", "--token", "abc", "--port", "1"]);
  await runner.run(["engine", "--token=abc"]);

  expect(records(file).map((record) => record.argv)).toEqual([
    ["engine", "--token", "***", "--port", "1"],
    ["engine", "--token=***"],
  ]);
});

test("a secret shorter than eight characters is left alone", async () => {
  const file = join(tempFolder(), "commands.jsonl");
  const inner = new ScriptedRunner([{ argv: ["echo"], result: { exitCode: 0, stdout: "short12 and 12345678", stderr: "" } }]);
  const runner = recordingRunner(inner, { file, secrets: () => ["short12", "12345678"] });

  await runner.run(["echo"]);

  expect(records(file)[0]?.stdout).toBe("short12 and ***");
});

test("the file is owner-only and so is the folder it made", async () => {
  const file = join(tempFolder(), "diagnostics", "commands.jsonl");
  const runner = recordingRunner(new ScriptedRunner([]), { file, secrets: () => [] });
  await runner.run(["nothing"]);

  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(statSync(join(root as string, "diagnostics")).mode & 0o777).toBe(0o700);
});

test("a later start appends to the same file", async () => {
  const file = join(tempFolder(), "commands.jsonl");
  await recordingRunner(new ScriptedRunner([]), { file, secrets: () => [] }).run(["one"]);
  await recordingRunner(new ScriptedRunner([]), { file, secrets: () => [] }).run(["two"]);

  expect(records(file).map((record) => record.argv)).toEqual([["one"], ["two"]]);
});

test("a stream keeps at most 5000 lines and counts the rest", async () => {
  const file = join(tempFolder(), "commands.jsonl");
  const total = MAX_LINES_PER_COMMAND + 7;
  const stdout = Array.from({ length: total }, (_, i) => `line ${i}`).join("\n");
  const inner = new ScriptedRunner([{ argv: ["logs"], result: { exitCode: 0, stdout, stderr: "" } }]);
  const runner = recordingRunner(inner, { file, secrets: () => [] });
  let delivered = 0;

  await runner.stream(["logs"], { onLine: () => delivered++ });

  expect(delivered).toBe(total);
  const all = records(file);
  expect(all.filter((record) => record.kind === "line")).toHaveLength(MAX_LINES_PER_COMMAND);
  expect(all.at(-1)).toMatchObject({ kind: "stream-end", droppedLines: 7 });
});

test("at the size limit one stopped record is written and the commands still run", async () => {
  const file = join(tempFolder(), "commands.jsonl");
  const inner = new ScriptedRunner([{ argv: ["echo"], result: { exitCode: 0, stdout: "x".repeat(200), stderr: "" } }]);
  const runner = recordingRunner(inner, { file, secrets: () => [], maxBytes: 950 });

  const results = [];
  for (let i = 0; i < 5; i++) results.push(await runner.run(["echo"]));

  expect(results.every((result) => result.stdout.length === 200)).toBe(true);
  const all = records(file);
  expect(all.map((record) => record.kind)).toEqual(["run", "run", "stopped"]);
  expect(all.at(-1)).toEqual({ kind: "stopped", reason: "size_limit" });
  const streamed = await runner.stream(["echo"], { onLine: () => {} });
  expect(streamed.exitCode).toBe(0);
  expect(records(file)).toHaveLength(3);
});

test("a path that cannot be written does not break the commands", async () => {
  const folder = tempFolder();
  // The file path is a folder, so that opening it for appending fails.
  const file = join(folder, "is-a-folder");
  mkdirSync(file);
  const inner = new ScriptedRunner([{ argv: ["echo"], result: { exitCode: 0, stdout: "ok", stderr: "" } }]);
  const runner = recordingRunner(inner, { file, secrets: () => [] });

  expect((await runner.run(["echo"])).stdout).toBe("ok");
  expect((await runner.stream(["echo"], { onLine: () => {} })).exitCode).toBe(0);
});

test("a folder that goes away while recording stops the recording and not the commands", async () => {
  const folder = tempFolder();
  const file = join(folder, "diagnostics", "commands.jsonl");
  const inner = new ScriptedRunner([{ argv: ["echo"], result: { exitCode: 0, stdout: "ok", stderr: "" } }]);
  const runner = recordingRunner(inner, { file, secrets: () => [] });
  await runner.run(["echo"]);
  rmSync(join(folder, "diagnostics"), { recursive: true });

  expect((await runner.run(["echo"])).stdout).toBe("ok");
  expect(existsSync(file)).toBe(false);
  // Even when the folder comes back, a stopped recording stays stopped.
  mkdirSync(join(folder, "diagnostics"));
  await runner.run(["echo"]);
  expect(existsSync(file)).toBe(false);
});

test("a folder that cannot be made does not break the commands", async () => {
  const folder = tempFolder();
  const locked = join(folder, "locked");
  mkdirSync(locked);
  chmodSync(locked, 0o500);
  const inner = new ScriptedRunner([{ argv: ["echo"], result: { exitCode: 0, stdout: "ok", stderr: "" } }]);
  const runner = recordingRunner(inner, { file: join(locked, "a", "commands.jsonl"), secrets: () => [] });

  expect((await runner.run(["echo"])).stdout).toBe("ok");
  chmodSync(locked, 0o700);
});

test("a secrets function that fails stops the recording and not the commands", async () => {
  const file = join(tempFolder(), "commands.jsonl");
  const inner = new ScriptedRunner([{ argv: ["echo"], result: { exitCode: 0, stdout: "ok", stderr: "" } }]);
  const runner = recordingRunner(inner, {
    file,
    secrets: () => {
      throw new Error("database closed");
    },
  });

  expect((await runner.run(["echo"])).stdout).toBe("ok");
  expect(allRecords(file).map((record) => record.kind)).toEqual(["session"]);
});

test("a session record opens each start with its number, the time and the version, and names only the kind of machine", async () => {
  const file = join(tempFolder(), "commands.jsonl");
  const first = recordingRunner(new ScriptedRunner([]), { file, secrets: () => [], now: clock(), version: "0.1.0" });
  await first.run(["one"]);
  await first.run(["two"]);
  const second = recordingRunner(new ScriptedRunner([]), { file, secrets: () => [], version: "0.1.1" });
  await second.run(["three"]);

  const all = allRecords(file);
  expect(all.map((record) => record.kind)).toEqual(["session", "run", "run", "session", "run"]);
  expect(all[0]).toEqual({
    kind: "session",
    session: 1,
    at: "2026-01-01T00:00:00.010Z",
    version: "0.1.0",
    firstSeq: 1,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
  });
  expect(all[3]).toMatchObject({ kind: "session", session: 2, version: "0.1.1", firstSeq: 3 });
  expect(Object.keys(all[3] as object).sort()).toEqual(["arch", "at", "firstSeq", "kind", "osRelease", "platform", "session", "version"]);
});

test("the numbers of the commands go on across starts, so two runs in one file never share a number", async () => {
  const file = join(tempFolder(), "commands.jsonl");
  const first = recordingRunner(new ScriptedRunner([]), { file, secrets: () => [] });
  await first.run(["one"]);
  await first.stream(["two"], { onLine: () => {} });
  const second = recordingRunner(new ScriptedRunner([]), { file, secrets: () => [] });
  await second.run(["three"]);

  const numbers = allRecords(file)
    .filter((record) => record.kind === "run" || record.kind === "stream-start")
    .map((record) => record.seq);
  expect(numbers).toEqual([1, 2, 3]);
});

test("no session record is written when the file cannot be used", async () => {
  const folder = tempFolder();
  const file = join(folder, "is-a-folder");
  mkdirSync(file);
  await recordingRunner(new ScriptedRunner([]), { file, secrets: () => [] }).run(["echo"]);

  expect(readdirSync(file)).toEqual([]);
});
