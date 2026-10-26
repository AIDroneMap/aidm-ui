import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT_CANNOT_RUN, EXIT_NOT_FOUND, EXIT_TIMED_OUT, OUTPUT_CAP_BYTES, systemRunner } from "./command-runner.ts";

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
