import { describe, expect, test } from "bun:test";
import { ScriptedRunner, recorded, recordedText, type ScriptedRule } from "../../test-support/scripted-runner.ts";
import { applePullParser, appleContainerRuntime, runArgv } from "./apple-container.ts";
import type { ContainerSpec, PullProgress, RuntimeDetection } from "./runtime.ts";

const IMAGE = "ghcr.io/aidronemap/aidm-api@sha256:107b6ef1049699b3bdcc055b4ecc704eaf0a9380202294a944e9eeff6c44e7fd";
const NAME = "aidm-engine";
const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
/** What the engine manager would give on a computer with 32 GiB and 8 cores. */
const DEFAULTS = { memoryBytes: 25 * GIB, cpus: 8 };

const detection: RuntimeDetection = {
  id: "apple-container",
  available: true,
  version: "1.6.1",
  memoryCapEnforced: true,
  cpuCapEnforced: true,
  storagePath: null,
  problem: null,
};

function spec(patch: Partial<ContainerSpec> = {}): ContainerSpec {
  return {
    name: NAME,
    image: IMAGE,
    platform: null,
    publish: { hostAddress: "127.0.0.1", hostPort: 41823, containerPort: 3000 },
    mounts: [{ hostPath: "/Users/operator/engine-data", containerPath: "/var/www/data" }],
    memoryBytes: 8 * GIB,
    cpus: 4,
    gpu: false,
    args: ["--port", "3000", "--token", "s3cret-token", "--parallel_queue_processing", "1"],
    ...patch,
  };
}

const rec = (name: string) => recorded("apple-container", name);

const argv = {
  run: runArgv(spec(), detection, DEFAULTS),
  pull: ["container", "image", "pull", "--platform", "linux/arm64", "--progress", "plain", IMAGE],
  inspect: ["container", "inspect", NAME],
  stop: ["container", "stop", NAME],
  delete: ["container", "delete", "--force", NAME],
  imageDelete: ["container", "image", "delete", IMAGE],
  logs: ["container", "logs", NAME],
};

function make(rules: ScriptedRule[]) {
  const runner = new ScriptedRunner(rules);
  return { runner, runtime: appleContainerRuntime(runner, { defaults: () => DEFAULTS }) };
}

describe("the command line that starts the container", () => {
  test("it carries the fixed name, the platform, the memory and CPU caps, the loopback publish, the bind mount and the arguments after the image", () => {
    expect(runArgv(spec(), detection, DEFAULTS)).toEqual([
      "container", "run", "-d", "--name", NAME,
      "--platform", "linux/arm64",
      "--memory", "8192M", "--cpus", "4",
      "-p", "127.0.0.1:41823:3000",
      "-v", "/Users/operator/engine-data:/var/www/data",
      IMAGE, "--port", "3000", "--token", "s3cret-token", "--parallel_queue_processing", "1",
    ]);
  });

  test("a spec without caps still sends both, filled from the defaults, because the tool's own VM gets 1 GiB", () => {
    const line = runArgv(spec({ memoryBytes: null, cpus: null }), detection, DEFAULTS);
    expect(line[line.indexOf("--memory") + 1]).toBe(`${(25 * GIB) / MIB}M`);
    expect(line[line.indexOf("--cpus") + 1]).toBe("8");
  });

  test("the caps are sent even if a detection says they would not be enforced", () => {
    const line = runArgv(spec(), { ...detection, memoryCapEnforced: false, cpuCapEnforced: false }, DEFAULTS);
    expect(line).toContain("--memory");
    expect(line).toContain("--cpus");
  });

  test("the memory is whole MiB, rounded up", () => {
    const line = runArgv(spec({ memoryBytes: 3 * GIB + 1 }), detection, DEFAULTS);
    expect(line[line.indexOf("--memory") + 1]).toBe("3073M");
  });

  test("there is no restart flag, no pull flag, and the publish is on loopback once", () => {
    const line = runArgv(spec({ gpu: true }), detection, DEFAULTS);
    expect(line.some((part) => part.startsWith("--restart") || part === "--pull=never")).toBe(false);
    expect(line.filter((part) => part === "-p")).toEqual(["-p"]);
    expect(line[line.indexOf("-p") + 1]?.startsWith("127.0.0.1:")).toBe(true);
  });

  test("every mount is a -v and the platform of the spec wins when it names one", () => {
    const line = runArgv(
      spec({ platform: "linux/arm64/v8", mounts: [{ hostPath: "/a", containerPath: "/x" }, { hostPath: "/b", containerPath: "/y" }] }),
      detection,
      DEFAULTS,
    );
    expect(line).toContain("/a:/x");
    expect(line).toContain("/b:/y");
    expect(line[line.indexOf("--platform") + 1]).toBe("linux/arm64/v8");
  });
});

describe("start", () => {
  test("it runs the recorded command and gives the ID the tool prints", async () => {
    const { runtime, runner } = make([{ argv: argv.run, result: rec("run") }]);
    expect(await runtime.start(spec())).toEqual({ ok: true, value: { containerId: "aidm-engine" } });
    expect(runner.calls).toEqual([argv.run]);
  });

  test("a name that is in use gives runtime.name_in_use and leaves that container alone", async () => {
    const { runtime, runner } = make([{ argv: argv.run, result: rec("run-name-in-use") }]);
    expect(await runtime.start(spec())).toEqual({ ok: false, error: { code: "runtime.name_in_use", data: { name: NAME } } });
    expect(runner.calls).not.toContainEqual(argv.delete);
  });

  test("a port that is in use gives runtime.port_in_use and clears the half-made container", async () => {
    const { runtime, runner } = make([
      { argv: argv.run, result: rec("run-port-in-use") },
      { argv: argv.delete, result: rec("delete") },
    ]);
    expect(await runtime.start(spec())).toEqual({ ok: false, error: { code: "runtime.port_in_use", data: { port: 41823 } } });
    expect(runner.calls).toContainEqual(argv.delete);
  });

  test("an image that is not stored gives runtime.image_not_found", async () => {
    const { runtime } = make([
      { argv: argv.run, result: rec("run-image-not-found") },
      { argv: argv.delete, result: rec("delete") },
    ]);
    expect(await runtime.start(spec())).toEqual({ ok: false, error: { code: "runtime.image_not_found", data: {} } });
  });

  test("a system service that is off gives runtime.apple_not_started", async () => {
    const { runtime } = make([{ argv: argv.run, result: rec("run-service-down") }]);
    expect(await runtime.start(spec())).toEqual({ ok: false, error: { code: "runtime.apple_not_started", data: {} } });
  });

  test("any other failure gives runtime.start_failed with the exit code and clears the container", async () => {
    const { runtime, runner } = make([
      { argv: argv.run, result: { exitCode: 3, stdout: "", stderr: "Error: something odd\n" } },
      { argv: argv.delete, result: rec("delete") },
    ]);
    expect(await runtime.start(spec())).toEqual({ ok: false, error: { code: "runtime.start_failed", data: { exitCode: 3 } } });
    expect(runner.calls).toContainEqual(argv.delete);
  });

  test("a success that prints no ID counts as failed and clears the container", async () => {
    const { runtime, runner } = make([
      { argv: argv.run, result: { exitCode: 0, stdout: "", stderr: "" } },
      { argv: argv.delete, result: rec("delete") },
    ]);
    expect(await runtime.start(spec())).toEqual({ ok: false, error: { code: "runtime.start_failed", data: { exitCode: 0 } } });
    expect(runner.calls).toContainEqual(argv.delete);
  });

  test("it asks for the defaults of the manager when the spec has no caps", async () => {
    const wanted = runArgv(spec({ memoryBytes: null, cpus: null }), detection, DEFAULTS);
    const { runtime, runner } = make([{ argv: wanted, result: rec("run") }]);
    expect((await runtime.start(spec({ memoryBytes: null, cpus: null }))).ok).toBe(true);
    expect(runner.calls[0]).toContain("--memory");
    expect(runner.calls[0]).toContain("--cpus");
  });
});

describe("pull", () => {
  test("the recorded plain output gives layer counts, then the writing phase", async () => {
    const { runtime, runner } = make([{ argv: argv.pull, result: rec("pull") }]);
    const progress: PullProgress[] = [];
    expect(await runtime.pull(IMAGE, { onProgress: (step) => progress.push(step) })).toEqual({ ok: true, value: undefined });
    expect(runner.calls).toEqual([argv.pull]);
    expect(progress).toEqual([
      { layersDone: 0, layersTotal: 7, phase: "downloading" },
      { layersDone: 2, layersTotal: 7, phase: "downloading" },
      { layersDone: 4, layersTotal: 7, phase: "downloading" },
      { layersDone: 7, layersTotal: 7, phase: "downloading" },
      { layersDone: 7, layersTotal: 7, phase: "writing" },
    ]);
  });

  test("the platform of the call replaces the default", async () => {
    const other = ["container", "image", "pull", "--platform", "linux/arm64/v8", "--progress", "plain", IMAGE];
    const { runtime, runner } = make([{ argv: other, result: rec("pull") }]);
    await runtime.pull(IMAGE, { platform: "linux/arm64/v8" });
    expect(runner.calls).toEqual([other]);
  });

  test("an image that is not at the registry gives runtime.image_not_found", async () => {
    const { runtime } = make([{ argv: argv.pull, result: rec("pull-not-found") }]);
    expect(await runtime.pull(IMAGE)).toEqual({ ok: false, error: { code: "runtime.image_not_found", data: {} } });
  });

  test("a system service that is off gives runtime.apple_not_started", async () => {
    const { runtime } = make([{ argv: argv.pull, result: rec("pull-service-down") }]);
    expect(await runtime.pull(IMAGE)).toEqual({ ok: false, error: { code: "runtime.apple_not_started", data: {} } });
  });

  test("any other failure gives runtime.pull_failed with the exit code", async () => {
    const { runtime } = make([{ argv: argv.pull, result: { exitCode: 1, stdout: "", stderr: "Error: the connection was reset\n" } }]);
    expect(await runtime.pull(IMAGE)).toEqual({ ok: false, error: { code: "runtime.pull_failed", data: { exitCode: 1 } } });
  });

  test("the parser ignores lines that are not progress and repeats nothing", () => {
    const parse = applePullParser();
    expect(parse("Error: something")).toBeNull();
    expect(parse("")).toBeNull();
    const first = "[1/2] Fetching image 31% (2 of 7 blobs, 190.1/610.4 MB, 38.0 MB/s) [5s]";
    expect(parse(first)).toEqual({ layersDone: 2, layersTotal: 7, phase: "downloading" });
    expect(parse(first.replace("[5s]", "[6s]"))).toBeNull();
  });

  test("a line without counts says the phase and keeps what it knew", () => {
    const parse = applePullParser();
    expect(parse("[1/2] Fetching image 0%")).toEqual({ layersDone: null, layersTotal: null, phase: "downloading" });
    expect(parse("[2/2] Unpacking image 10% (3 of 30 entries)")).toEqual({ layersDone: null, layersTotal: null, phase: "writing" });
  });
});

describe("status", () => {
  const states = [
    ["inspect-running", { state: "running", exitCode: null, oomKilled: null }],
    ["inspect-stopped", { state: "stopped", exitCode: null, oomKilled: null }],
    ["inspect-stopping", { state: "stopped", exitCode: null, oomKilled: null }],
    ["inspect-unknown", { state: "stopped", exitCode: null, oomKilled: null }],
    ["inspect-running-flat", { state: "running", exitCode: null, oomKilled: null }],
  ] as const;
  for (const [recording, expected] of states) {
    test(`${recording} reads as ${expected.state}`, async () => {
      const { runtime } = make([{ argv: argv.inspect, result: rec(recording) }]);
      expect(await runtime.status(NAME)).toEqual({ ok: true, value: expected });
    });
  }

  test("a stopped container reports an exit code when the tool gives one", async () => {
    const text = recordedText("apple-container", "inspect-stopped").replace('"state": "stopped"', '"state": "stopped",\n      "exitCode": 137');
    const { runtime } = make([{ argv: argv.inspect, result: { exitCode: 0, stdout: text, stderr: "" } }]);
    expect(await runtime.status(NAME)).toEqual({ ok: true, value: { state: "stopped", exitCode: 137, oomKilled: null } });
  });

  test("a container that is not found is missing, not an error", async () => {
    const { runtime } = make([{ argv: argv.inspect, result: rec("inspect-missing") }]);
    expect(await runtime.status(NAME)).toEqual({ ok: true, value: { state: "missing", exitCode: null, oomKilled: null } });
  });

  test("an empty list is missing too", async () => {
    const { runtime } = make([{ argv: argv.inspect, result: { exitCode: 0, stdout: "[]\n", stderr: "" } }]);
    expect(await runtime.status(NAME)).toEqual({ ok: true, value: { state: "missing", exitCode: null, oomKilled: null } });
  });

  test("a service that is off gives runtime.apple_not_started", async () => {
    const { runtime } = make([{ argv: argv.inspect, result: rec("inspect-service-down") }]);
    expect(await runtime.status(NAME)).toEqual({ ok: false, error: { code: "runtime.apple_not_started", data: {} } });
  });

  test("an answer that makes no sense, or another failure, gives runtime.command_failed", async () => {
    const odd = make([{ argv: argv.inspect, result: { exitCode: 0, stdout: '[{"status":{"state":"flying"}}]', stderr: "" } }]);
    expect(await odd.runtime.status(NAME)).toEqual({
      ok: false,
      error: { code: "runtime.command_failed", data: { operation: "status", exitCode: 0 } },
    });
    const broken = make([{ argv: argv.inspect, result: { exitCode: 2, stdout: "", stderr: "Error: boom\n" } }]);
    expect(await broken.runtime.status(NAME)).toEqual({
      ok: false,
      error: { code: "runtime.command_failed", data: { operation: "status", exitCode: 2 } },
    });
  });
});

describe("logs", () => {
  test("the recorded lines reach the caller, with -f and -n when asked", async () => {
    const followed = ["container", "logs", "-f", "-n", "50", NAME];
    const { runtime, runner } = make([{ argv: followed, result: rec("logs") }]);
    const lines: string[] = [];
    expect(await runtime.logs(NAME, { follow: true, tail: 50, onLine: (line) => lines.push(line) })).toEqual({ ok: true, value: undefined });
    expect(runner.calls).toEqual([followed]);
    expect(lines).toEqual(["AIDM API 2.5.0 listening on port 3000", "queue: 0 tasks"]);
  });

  test("a plain read has no flags", async () => {
    const { runtime, runner } = make([{ argv: argv.logs, result: rec("logs") }]);
    await runtime.logs(NAME, { follow: false, onLine: () => {} });
    expect(runner.calls).toEqual([argv.logs]);
  });

  test("a container that is gone ends the log quietly and its message is not a log line", async () => {
    const { runtime } = make([{ argv: argv.logs, result: rec("logs-missing") }]);
    const lines: string[] = [];
    expect(await runtime.logs(NAME, { follow: false, onLine: (line) => lines.push(line) })).toEqual({ ok: true, value: undefined });
    expect(lines).toEqual([]);
  });

  test("another failure gives runtime.command_failed", async () => {
    const { runtime } = make([{ argv: argv.logs, result: { exitCode: 4, stdout: "", stderr: "Error: boom\n" } }]);
    expect(await runtime.logs(NAME, { follow: false, onLine: () => {} })).toEqual({
      ok: false,
      error: { code: "runtime.command_failed", data: { operation: "logs", exitCode: 4 } },
    });
  });
});

describe("stop, remove and removeImage", () => {
  test("stop gives the container the time asked for, and the tool's default otherwise", async () => {
    const timed = ["container", "stop", "-t", "30", NAME];
    const { runtime, runner } = make([
      { argv: argv.stop, result: rec("stop") },
      { argv: timed, result: rec("stop") },
    ]);
    expect((await runtime.stop(NAME)).ok).toBe(true);
    expect((await runtime.stop(NAME, 30)).ok).toBe(true);
    expect(runner.calls).toEqual([argv.stop, timed]);
  });

  test("stopping a container that is not running, or is gone, or whose service is off, is fine", async () => {
    for (const recording of ["stop-not-running", "stop-missing", "run-service-down"]) {
      const { runtime } = make([{ argv: argv.stop, result: rec(recording) }]);
      expect(await runtime.stop(NAME), recording).toEqual({ ok: true, value: undefined });
    }
  });

  test("another stop failure gives runtime.command_failed", async () => {
    const { runtime } = make([{ argv: argv.stop, result: { exitCode: 1, stdout: "", stderr: "Error: boom\n" } }]);
    expect(await runtime.stop(NAME)).toEqual({
      ok: false,
      error: { code: "runtime.command_failed", data: { operation: "stop", exitCode: 1 } },
    });
  });

  test("remove forces the delete, and a missing container is fine", async () => {
    const found = make([{ argv: argv.delete, result: rec("delete") }]);
    expect(await found.runtime.remove(NAME)).toEqual({ ok: true, value: undefined });
    expect(found.runner.calls).toEqual([argv.delete]);
    const missing = make([{ argv: argv.delete, result: rec("delete-missing") }]);
    expect(await missing.runtime.remove(NAME)).toEqual({ ok: true, value: undefined });
  });

  test("a delete that fails for another reason gives runtime.command_failed, and a service that is off its own code", async () => {
    const refused = make([
      { argv: argv.delete, result: { exitCode: 1, stdout: "", stderr: 'Error: invalidState: "container aidm-engine is running and can not be deleted"\n' } },
    ]);
    expect(await refused.runtime.remove(NAME)).toEqual({
      ok: false,
      error: { code: "runtime.command_failed", data: { operation: "remove", exitCode: 1 } },
    });
    const down = make([{ argv: argv.delete, result: rec("run-service-down") }]);
    expect(await down.runtime.remove(NAME)).toEqual({ ok: false, error: { code: "runtime.apple_not_started", data: {} } });
  });

  test("removeImage deletes by reference, and an image that is gone is fine", async () => {
    const found = make([{ argv: argv.imageDelete, result: rec("image-delete") }]);
    expect(await found.runtime.removeImage(IMAGE)).toEqual({ ok: true, value: undefined });
    expect(found.runner.calls).toEqual([argv.imageDelete]);
    const missing = make([{ argv: argv.imageDelete, result: rec("image-delete-missing") }]);
    expect(await missing.runtime.removeImage(IMAGE)).toEqual({ ok: true, value: undefined });
  });

  test("an image that is in use stays, with runtime.command_failed", async () => {
    const { runtime } = make([{ argv: argv.imageDelete, result: rec("image-delete-in-use") }]);
    expect(await runtime.removeImage(IMAGE)).toEqual({
      ok: false,
      error: { code: "runtime.command_failed", data: { operation: "removeImage", exitCode: 1 } },
    });
  });
});

test("the version the tool prints on its own is the recorded line", () => {
  expect(recordedText("apple-container", "cli-version")).toMatch(/^container CLI version 1\.6\.1 \(build: release, commit: [0-9a-f]{7}\)\n$/);
});
