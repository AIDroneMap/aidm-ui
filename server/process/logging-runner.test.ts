import { expect, test } from "bun:test";
import { ScriptedRunner } from "../../test-support/scripted-runner.ts";
import { loggingRunner } from "./logging-runner.ts";

/** A clock that moves 1.5 s at each look. */
function clock(): () => number {
  let at = 0;
  return () => (at += 1500);
}

test("a command is logged with its command line, its exit code and how long it took, and the token stays hidden", async () => {
  const lines: string[] = [];
  const inner = new ScriptedRunner([{ argv: ["aidm-api", "--token", "s3cret-token", "--port", "3000"], result: { exitCode: 2, stdout: "", stderr: "" } }]);
  await loggingRunner(inner, (line) => lines.push(line), clock()).run(["aidm-api", "--token", "s3cret-token", "--port", "3000"]);
  expect(lines).toEqual(["Command: aidm-api --token *** --port 3000 -> exit 2 after 1.5 s"]);
});

test("a streamed command gets a line when it starts and one when it ends", async () => {
  const lines: string[] = [];
  const inner = new ScriptedRunner([{ argv: ["docker", "load"], result: { exitCode: 0, stdout: "Loaded image: x\n", stderr: "" } }]);
  await loggingRunner(inner, (line) => lines.push(line), clock()).stream(["docker", "load"], { onLine: () => {}, stdin: new Response("tar").body ?? undefined });
  expect(lines).toEqual(["Command started: docker load (with input)", "Command ended: docker load -> exit 0 after 1.5 s"]);
});

test("a streamed command that aidm-ui ends itself is said to be stopped, not to have exited with the kill's code", async () => {
  const lines: string[] = [];
  const abort = new AbortController();
  const inner = new ScriptedRunner([
    {
      argv: ["container", "logs", "-f", "-n", "0", "aidm-local-engine"],
      result: () => {
        abort.abort();
        return { exitCode: 137, stdout: "", stderr: "" };
      },
    },
  ]);
  await loggingRunner(inner, (line) => lines.push(line), clock()).stream(["container", "logs", "-f", "-n", "0", "aidm-local-engine"], {
    onLine: () => {},
    signal: abort.signal,
  });
  expect(lines).toEqual([
    "Command started: container logs -f -n 0 aidm-local-engine",
    "Command stopped by aidm-ui: container logs -f -n 0 aidm-local-engine after 1.5 s",
  ]);
});
