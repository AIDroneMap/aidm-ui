import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeCommand,
  EXIT_CANNOT_RUN,
  EXIT_NOT_FOUND,
  EXIT_TIMED_OUT,
  OUTPUT_CAP_BYTES,
  systemRunner,
} from "./command-runner.ts";

test("a program that runs gives its output and exit code", async () => {
  const result = await systemRunner().run(["sh", "-c", "echo out; echo err >&2; exit 3"]);
  expect(result).toEqual({ exitCode: 3, stdout: "out\n", stderr: "err\n" });
});

test("a program that is not installed gives 127 and not found", async () => {
  const result = await systemRunner().run(["aidm-no-such-program-7"]);
  expect(result).toEqual({ exitCode: EXIT_NOT_FOUND, stdout: "", stderr: "not found" });
});

test("a program that outlives its time is killed and gives 124", async () => {
  const started = Date.now();
  const result = await systemRunner().run(["sleep", "30"], { timeoutMs: 100 });
  expect(result.exitCode).toBe(EXIT_TIMED_OUT);
  expect(Date.now() - started).toBeLessThan(5000);
});

test("the extra environment reaches the program", async () => {
  const result = await systemRunner().run(["sh", "-c", "printf %s \"$AIDM_TEST_VALUE\""], {
    env: { AIDM_TEST_VALUE: "seven" },
  });
  expect(result.stdout).toBe("seven");
});

test("a timeout also ends a background program that holds the output open", async () => {
  const started = Date.now();
  const result = await systemRunner().run(["sh", "-c", "sleep 30 & sleep 30"], { timeoutMs: 200 });
  expect(result.exitCode).toBe(EXIT_TIMED_OUT);
  expect(Date.now() - started).toBeLessThan(2000);
});

test("a program that ends but leaves a background program holding the output does not keep the caller waiting", async () => {
  const started = Date.now();
  const result = await systemRunner().run(["sh", "-c", "echo done; sleep 30 & exit 0"], { timeoutMs: 5000 });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("done\n");
  expect(Date.now() - started).toBeLessThan(2000);
});

test("output beyond 4 MiB on each stream is dropped and the first 4 MiB is kept", async () => {
  const result = await systemRunner().run([
    "sh",
    "-c",
    "head -c 5000000 /dev/zero | tr '\\0' a; head -c 5000000 /dev/zero | tr '\\0' b >&2; echo end",
  ]);
  expect(result.exitCode).toBe(0);
  expect(OUTPUT_CAP_BYTES).toBe(4 * 1024 * 1024);
  expect(result.stdout.length).toBe(OUTPUT_CAP_BYTES);
  expect(result.stdout).toBe("a".repeat(OUTPUT_CAP_BYTES));
  expect(result.stderr).toBe("b".repeat(OUTPUT_CAP_BYTES));
});

test("a program that is there but cannot be started gives 126 and the reason", async () => {
  const folder = mkdtempSync(join(tmpdir(), "aidm-runner-"));
  try {
    const file = join(folder, "not-executable");
    writeFileSync(file, "#!/bin/sh\necho hi\n");
    chmodSync(file, 0o644);
    const result = await systemRunner().run([file]);
    expect(result.exitCode).toBe(EXIT_CANNOT_RUN);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toBe("");
    expect(result.stderr).not.toBe("not found");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("a streamed program hands over its lines as they arrive, from both streams", async () => {
  const lines: Array<[string, string]> = [];
  const result = await systemRunner().stream(
    ["sh", "-c", "echo one; echo two >&2; printf 'no break'; exit 4"],
    { onLine: (line, from) => lines.push([from, line]) },
  );
  expect(result).toEqual({ exitCode: 4, stdout: "", stderr: "" });
  expect(lines.filter(([from]) => from === "stdout").map(([, line]) => line)).toEqual(["one", "no break"]);
  expect(lines.filter(([from]) => from === "stderr").map(([, line]) => line)).toEqual(["two"]);
});

test("a streamed line arrives before the program ends", async () => {
  const started = Date.now();
  let firstAt = -1;
  await systemRunner().stream(["sh", "-c", "echo early; sleep 0.6"], {
    onLine: () => {
      if (firstAt < 0) firstAt = Date.now() - started;
    },
  });
  expect(firstAt).toBeGreaterThanOrEqual(0);
  expect(firstAt).toBeLessThan(500);
});

test("a streamed line break of Windows kind is cut off", async () => {
  const lines: string[] = [];
  await systemRunner().stream(["printf", "a\\r\\nb\\r\\n"], { onLine: (line) => lines.push(line) });
  expect(lines).toEqual(["a", "b"]);
});

test("a streamed program that is not installed gives 127", async () => {
  const result = await systemRunner().stream(["aidm-no-such-program-7"], { onLine: () => {} });
  expect(result.exitCode).toBe(EXIT_NOT_FOUND);
});

test("a streamed program stops when its signal fires", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const started = Date.now();
  const result = await systemRunner().stream(["sleep", "30"], { onLine: () => {}, signal: controller.signal });
  expect(result.exitCode).not.toBe(0);
  expect(Date.now() - started).toBeLessThan(5000);
});

test("a streamed program with a signal that has already fired never starts", async () => {
  const lines: string[] = [];
  const result = await systemRunner().stream(["echo", "hello"], {
    onLine: (line) => lines.push(line),
    signal: AbortSignal.abort(),
  });
  expect(result.exitCode).not.toBe(0);
  expect(lines).toEqual([]);
});

test("a streamed program that outlives its time is killed and gives 124", async () => {
  const result = await systemRunner().stream(["sleep", "30"], { onLine: () => {}, timeoutMs: 100 });
  expect(result.exitCode).toBe(EXIT_TIMED_OUT);
});

test("a command line for a log hides the token", () => {
  expect(describeCommand(["podman", "run", "img", "--token", "secret", "--port", "3000"])).toBe(
    "podman run img --token *** --port 3000",
  );
  expect(describeCommand(["run", "--token=secret"])).toBe("run --token=***");
});
