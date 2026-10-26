import { expect, test } from "bun:test";
import { EXIT_NOT_FOUND, EXIT_TIMED_OUT, systemRunner } from "./command-runner.ts";

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
