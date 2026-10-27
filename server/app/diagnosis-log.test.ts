import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { excerpt, openDiagnosisLog } from "./diagnosis-log.ts";

let folder = "";
afterEach(() => rmSync(folder, { recursive: true, force: true }));

function logIn(options: Partial<Parameters<typeof openDiagnosisLog>[0]> = {}) {
  folder = mkdtempSync(join(tmpdir(), "aidm-ui-diagnosis-"));
  const terminal: string[] = [];
  const log = openDiagnosisLog({ dataFolder: folder, terminal: (line) => terminal.push(line), now: () => Date.UTC(2026, 9, 27, 8, 0, 0), ...options });
  return { log, terminal, file: join(folder, "logs", "aidm-ui.log") };
}

test("each line goes to the terminal and to logs/aidm-ui.log, with its time", () => {
  const { log, terminal, file } = logIn();
  log("Install step start of the engine: started");
  expect(terminal).toEqual(["2026-10-27T08:00:00.000Z Install step start of the engine: started"]);
  expect(readFileSync(file, "utf8")).toBe("2026-10-27T08:00:00.000Z Install step start of the engine: started\n");
});

test("a file that cannot be written says so once, and the first line that gets through counts what it lacks", () => {
  const { log, terminal, file } = logIn();
  log("first");
  // Something takes the file's place: a folder cannot be appended to.
  rmSync(file);
  mkdirSync(file);
  log("second");
  log("third");
  expect(terminal.filter((line) => line.includes("cannot be written"))).toHaveLength(1);
  rmSync(file, { recursive: true });
  log("fourth");
  expect(readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => line.slice(25))).toEqual([
    "The log file can be written again. 2 lines are only in the terminal.",
    "fourth",
  ]);
  expect(terminal.map((line) => line.slice(25))).toEqual([
    "first",
    `The log file ${file} cannot be written (EISDIR). Lines go to this terminal only until it can.`,
    "second",
    "third",
    "The log file can be written again. 2 lines are only in the terminal.",
    "fourth",
  ]);
});

test("the file rotates at its size and keeps three older files", () => {
  const { log, file } = logIn({ rotateBytes: 100, keptFiles: 3 });
  for (let n = 0; n < 20; n++) log(`line ${n} ${"x".repeat(40)}`);
  expect(existsSync(`${file}.1`)).toBe(true);
  expect(existsSync(`${file}.3`)).toBe(true);
  expect(existsSync(`${file}.4`)).toBe(false);
  expect(readFileSync(file, "utf8")).toContain("line 19");
});

test("an engine token never reaches the log, even when the tokens can no longer be read", () => {
  let readable = true;
  const { log, terminal, file } = logIn({
    secrets: () => {
      if (!readable) throw new Error("database closed");
      return ["tok-1234567890"];
    },
  });
  log("asked http://127.0.0.1:1/info?token=tok-1234567890");
  readable = false;
  log("again tok-1234567890");
  expect(terminal.join("\n")).not.toContain("tok-1234567890");
  expect(readFileSync(file, "utf8")).not.toContain("tok-1234567890");
});

test("a tool's output is quoted on one line and cut after 300 characters", () => {
  expect(excerpt("Error: notFound:\n  image not found\n")).toBe("Error: notFound: image not found");
  expect(excerpt("")).toBe("(no output)");
  expect(excerpt("a".repeat(400))).toBe(`${"a".repeat(300)}...`);
});
