import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedRunner } from "../test-support/scripted-runner.ts";
import { recordingRunner } from "../server/process/recording-runner.ts";
import { convertRecording, main, slugOf } from "./runtime-recording-to-fixtures.ts";

let root: string | undefined;

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function tempFolder(): string {
  root = mkdtempSync(join(tmpdir(), "aidm-ui-fixtures-"));
  return root;
}

const jsonl = (...records: object[]) => records.map((record) => JSON.stringify(record)).join("\n") + "\n";

function byName(recording: string): Record<string, string> {
  return Object.fromEntries(convertRecording(recording).map((file) => [file.name, file.content]));
}

test("the slug is the words after the program, lower case, with dashes, cut to 40 characters", () => {
  expect(slugOf(["container", "system", "status", "--format", "json"])).toBe("system-status-format-json");
  expect(slugOf(["/usr/local/bin/container", "Image", "Pull", "ghcr.io/Some/Very-Long-Name:latest-and-more-text"])).toBe(
    "image-pull-ghcr-io-some-very-long-name-l",
  );
  expect(slugOf(["sw_vers"])).toBe("command");
});

test("a run that succeeded gets a text file and no json file", () => {
  const files = byName(
    jsonl({ seq: 1, kind: "run", argv: ["container", "--version"], exitCode: 0, stdout: "container 1.6.1\n", stderr: "" }),
  );
  expect(Object.keys(files)).toEqual(["001-version.txt", "index.txt"]);
  expect(files["001-version.txt"]).toBe("container 1.6.1\n");
  expect(files["index.txt"]).toBe("001-version: container --version\n");
});

test("a run that failed, or wrote to stderr, gets a json file with the exit code and stderr", () => {
  const files = byName(
    jsonl(
      { seq: 1, kind: "run", argv: ["container", "inspect", "x"], exitCode: 1, stdout: "[]", stderr: "container not found: x\n" },
      { seq: 2, kind: "run", argv: ["container", "pull", "i"], exitCode: 0, stdout: "", stderr: "progress\n" },
    ),
  );
  expect(JSON.parse(files["001-inspect-x.json"] as string)).toEqual({ exitCode: 1, stderr: "container not found: x\n" });
  expect(files["001-inspect-x.txt"]).toBe("[]");
  expect(JSON.parse(files["002-pull-i.json"] as string)).toEqual({ exitCode: 0, stderr: "progress\n" });
  expect(files["002-pull-i.txt"]).toBe("");
});

test("a stream becomes its stdout lines and its stderr lines, each joined with a final line break", () => {
  const files = byName(
    jsonl(
      { seq: 3, kind: "stream-start", argv: ["container", "image", "pull", "i"] },
      { seq: 3, kind: "line", from: "stderr", text: "[1/2] Fetching" },
      { seq: 3, kind: "line", from: "stdout", text: "a" },
      { seq: 3, kind: "line", from: "stdout", text: "b" },
      { seq: 3, kind: "line", from: "stderr", text: "[2/2] Unpacking" },
      { seq: 3, kind: "stream-end", exitCode: 0, durationMs: 5, droppedLines: 0 },
      { seq: 4, kind: "stream-start", argv: ["container", "system", "start"] },
      { seq: 4, kind: "stream-end", exitCode: 0, durationMs: 5, droppedLines: 0 },
    ),
  );
  expect(files["001-image-pull-i.txt"]).toBe("a\nb\n");
  expect(JSON.parse(files["001-image-pull-i.json"] as string)).toEqual({
    exitCode: 0,
    stderr: "[1/2] Fetching\n[2/2] Unpacking\n",
  });
  expect(files["002-system-start.txt"]).toBe("");
  expect(files["002-system-start.json"]).toBeUndefined();
});

test("the cases are numbered by order of appearance, and the index notes a stream that never ended", () => {
  const files = byName(
    jsonl(
      { seq: 2, kind: "run", argv: ["b", "two"], exitCode: 0, stdout: "", stderr: "" },
      { seq: 1, kind: "stream-start", argv: ["a", "one"] },
      { kind: "stopped", reason: "size_limit" },
    ),
  );
  expect(files["index.txt"]).toBe(
    "001-two: b two\n002-one: a one (the recording ends before this command did)\n",
  );
});

test("a recording of two sessions with repeated numbers gives distinct cases with the right outputs", () => {
  const files = byName(
    jsonl(
      { kind: "session", at: "2026-10-26T10:00:00.000Z", platform: "darwin", arch: "arm64", osRelease: "25.0.0" },
      { seq: 1, kind: "run", argv: ["container", "--version"], exitCode: 0, stdout: "first\n", stderr: "" },
      { seq: 2, kind: "stream-start", argv: ["container", "logs", "e"] },
      { seq: 2, kind: "line", from: "stdout", text: "from the first session" },
      { seq: 2, kind: "stream-end", exitCode: 0, durationMs: 1, droppedLines: 0 },
      { kind: "session", at: "2026-10-26T11:00:00.000Z", platform: "darwin", arch: "arm64", osRelease: "26.1.0" },
      { seq: 1, kind: "run", argv: ["container", "--version"], exitCode: 1, stdout: "", stderr: "second\n" },
      { seq: 2, kind: "stream-start", argv: ["container", "logs", "e"] },
      { seq: 2, kind: "line", from: "stdout", text: "from the second session" },
      { seq: 2, kind: "line", from: "stderr", text: "late" },
      { seq: 2, kind: "stream-end", exitCode: 2, durationMs: 1, droppedLines: 0 },
    ),
  );
  expect(Object.keys(files).sort()).toEqual([
    "001-version.txt",
    "002-logs-e.txt",
    "003-version.json",
    "003-version.txt",
    "004-logs-e.json",
    "004-logs-e.txt",
    "index.txt",
  ]);
  expect(files["001-version.txt"]).toBe("first\n");
  expect(files["002-logs-e.txt"]).toBe("from the first session\n");
  expect(JSON.parse(files["003-version.json"] as string)).toEqual({ exitCode: 1, stderr: "second\n" });
  expect(files["004-logs-e.txt"]).toBe("from the second session\n");
  expect(JSON.parse(files["004-logs-e.json"] as string)).toEqual({ exitCode: 2, stderr: "late\n" });
  expect(files["index.txt"]).toBe(
    [
      "# session: platform darwin, arch arm64, os release 25.0.0",
      "001-version: container --version",
      "002-logs-e: container logs e",
      "# session: platform darwin, arch arm64, os release 26.1.0",
      "003-version: container --version",
      "004-logs-e: container logs e",
      "",
    ].join("\n"),
  );
});

test("records before any session record count as one session without a header", () => {
  const files = byName(
    jsonl(
      { seq: 1, kind: "run", argv: ["a", "b"], exitCode: 0, stdout: "x", stderr: "" },
      { kind: "session", at: "t", platform: "linux", arch: "x64", osRelease: "7.0" },
      { seq: 1, kind: "run", argv: ["a", "c"], exitCode: 0, stdout: "y", stderr: "" },
    ),
  );
  expect(files["index.txt"]).toBe("001-b: a b\n# session: platform linux, arch x64, os release 7.0\n002-c: a c\n");
});

test("a half written last line is skipped", () => {
  const recording = jsonl({ seq: 1, kind: "run", argv: ["a", "b"], exitCode: 0, stdout: "x", stderr: "" }) + '{"seq":2,"kind":"ru';
  expect(Object.keys(byName(recording))).toEqual(["001-b.txt", "index.txt"]);
});

test("a recording made by the recording runner converts back to what the commands printed", async () => {
  const folder = tempFolder();
  const file = join(folder, "recording.jsonl");
  const inner = new ScriptedRunner([
    { argv: ["container", "inspect", "e"], result: { exitCode: 1, stdout: "[]", stderr: "container not found: e\n" } },
    { argv: ["container", "logs", "e"], result: { exitCode: 0, stdout: "one\ntwo\n", stderr: "" } },
  ]);
  const runner = recordingRunner(inner, { file, secrets: () => [] });
  await runner.run(["container", "inspect", "e"]);
  await runner.stream(["container", "logs", "e"], { onLine: () => {} });

  const files = byName(readFileSync(file, "utf8"));
  expect(files["001-inspect-e.txt"]).toBe("[]");
  expect(JSON.parse(files["001-inspect-e.json"] as string)).toEqual({ exitCode: 1, stderr: "container not found: e\n" });
  expect(files["002-logs-e.txt"]).toBe("one\ntwo\n");
});

test("main writes a new folder, and refuses one that already holds files", () => {
  const folder = tempFolder();
  const recording = join(folder, "recording.jsonl");
  writeFileSync(recording, jsonl({ seq: 1, kind: "run", argv: ["a", "b"], exitCode: 0, stdout: "x", stderr: "" }));
  const lines: string[] = [];

  expect(main([recording, join(folder, "out")], (line) => lines.push(line))).toBe(0);
  expect(readdirSync(join(folder, "out")).sort()).toEqual(["001-b.txt", "index.txt"]);

  lines.length = 0;
  expect(main([recording, join(folder, "out")], (line) => lines.push(line))).toBe(1);
  expect(lines.join("\n")).toContain("not empty");

  const empty = join(folder, "empty");
  mkdirSync(empty);
  expect(main([recording, empty], () => {})).toBe(0);
});

test("main explains a missing recording and a wrong number of arguments", () => {
  const folder = tempFolder();
  const lines: string[] = [];
  expect(main([join(folder, "nope.jsonl"), join(folder, "out")], (line) => lines.push(line))).toBe(1);
  expect(lines[0]).toContain("no recording file");
  expect(main([], (line) => lines.push(line))).toBe(1);
});
