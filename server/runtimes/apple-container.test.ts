import { describe, expect, test } from "bun:test";
import { ScriptedRunner, recorded, recordedText, type ScriptedRule } from "../../test-support/scripted-runner.ts";
import { applePullParser, appleContainerRuntime, runArgv } from "./apple-container.ts";
import type { ContainerSpec, PullProgress } from "./runtime.ts";

const IMAGE = "ghcr.io/aidronemap/aidm-api@sha256:107b6ef1049699b3bdcc055b4ecc704eaf0a9380202294a944e9eeff6c44e7fd";
const NAME = "aidm-engine";
const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
/** What the engine manager would give on a computer with 32 GiB and 8 cores. */
const DEFAULTS = { memoryBytes: 25 * GIB, cpus: 8 };

/** Spelled out here on purpose: the tool is always called by this path (section C of the runtime facts). */
const TOOL = "/usr/local/bin/container";

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
  run: runArgv(spec(), DEFAULTS),
  pull: [TOOL, "image", "pull", "--platform", "linux/arm64", "--progress", "plain", IMAGE],
  inspect: [TOOL, "inspect", NAME],
  stop: [TOOL, "stop", NAME],
  delete: [TOOL, "delete", "--force", NAME],
  imageDelete: [TOOL, "image", "delete", IMAGE],
  logs: [TOOL, "logs", NAME],
  version: [TOOL, "--version"],
  status: [TOOL, "system", "status", "--format", "json"],
};

function make(rules: ScriptedRule[]) {
  const runner = new ScriptedRunner(rules);
  return { runner, runtime: appleContainerRuntime(runner, { defaults: () => DEFAULTS }) };
}

describe("the command line that starts the container", () => {
  test("it carries the tool's path, the fixed name, the memory and CPU caps, the loopback publish, the bind mount and the arguments after the image", () => {
    expect(runArgv(spec(), DEFAULTS)).toEqual([
      TOOL, "run", "-d", "--name", NAME,
      "--memory", "8192M", "--cpus", "4",
      "-p", "127.0.0.1:41823:3000",
      "-v", "/Users/operator/engine-data:/var/www/data",
      IMAGE, "--port", "3000", "--token", "s3cret-token", "--parallel_queue_processing", "1",
    ]);
  });

  test("a spec without caps still sends both, filled from the defaults, because the tool's own VM gets 1 GiB", () => {
    const line = runArgv(spec({ memoryBytes: null, cpus: null }), DEFAULTS);
    expect(line[line.indexOf("--memory") + 1]).toBe(`${(25 * GIB) / MIB}M`);
    expect(line[line.indexOf("--cpus") + 1]).toBe("8");
  });

  test("the memory is whole MiB, rounded up", () => {
    const line = runArgv(spec({ memoryBytes: 3 * GIB + 1 }), DEFAULTS);
    expect(line[line.indexOf("--memory") + 1]).toBe("3073M");
  });

  test("there is no restart flag, no pull flag, and the publish is on loopback once", () => {
    const line = runArgv(spec({ gpu: true }), DEFAULTS);
    expect(line.some((part) => part.startsWith("--restart") || part === "--pull=never")).toBe(false);
    expect(line.filter((part) => part === "-p")).toEqual(["-p"]);
    expect(line[line.indexOf("-p") + 1]?.startsWith("127.0.0.1:")).toBe(true);
  });

  test("every mount is a -v", () => {
    const line = runArgv(spec({ mounts: [{ hostPath: "/a", containerPath: "/x" }, { hostPath: "/b", containerPath: "/y" }] }), DEFAULTS);
    expect(line).toContain("/a:/x");
    expect(line).toContain("/b:/y");
  });

  // The flags the tool lists for run name no platform: the image is pulled for linux/arm64, and run uses that copy.
  test("run has no platform flag, even when the spec names a platform", () => {
    expect(runArgv(spec(), DEFAULTS)).not.toContain("--platform");
    expect(runArgv(spec({ platform: "linux/arm64/v8" }), DEFAULTS)).not.toContain("--platform");
  });
});

describe("detect", () => {
  const versionRule = (): ScriptedRule => ({ argv: argv.version, result: rec("cli-version") });
  const statusRule = (name: string): ScriptedRule => ({ argv: argv.status, result: rec(name) });

  test("the tool is asked by its path with --version first, and then for the state of its service", async () => {
    const { runtime, runner } = make([versionRule(), statusRule("system-status-running")]);
    expect(await runtime.detect()).toEqual({
      id: "apple-container",
      available: true,
      version: "1.6.1",
      memoryCapEnforced: true,
      cpuCapEnforced: true,
      storagePath: null,
      problem: null,
    });
    expect(runner.calls).toEqual([argv.version, argv.status]);
  });

  // The status output is reconstructed from the tool's source, not captured, so the answer leans on --version.
  test("a tool that answers --version while its service is not running is apple_not_started, with its version", async () => {
    for (const status of ["system-status-not-running", "system-status-unregistered"]) {
      const { runtime } = make([versionRule(), statusRule(status)]);
      const found = await runtime.detect();
      expect(found.available, status).toBe(false);
      expect(found.version, status).toBe("1.6.1");
      expect(found.problem, status).toEqual({ code: "runtime.apple_not_started", data: {} });
    }
  });

  test("a status the code cannot read, from a tool that answered --version, is still apple_not_started and never unusable", async () => {
    for (const result of [
      { exitCode: 1, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "something new\n", stderr: "" },
      { exitCode: 124, stdout: "", stderr: "" },
    ]) {
      const { runtime } = make([versionRule(), { argv: argv.status, result }]);
      expect((await runtime.detect()).problem).toEqual({ code: "runtime.apple_not_started", data: {} });
    }
  });

  test("no tool at the path is runtime.not_installed, and no status is asked", async () => {
    const { runtime, runner } = make([]);
    expect((await runtime.detect()).problem).toEqual({ code: "runtime.not_installed", data: { runtime: "apple-container" } });
    expect(runner.calls).toEqual([argv.version]);
  });

  test("a file that does not run, or prints something other than the version line, is runtime.unusable", async () => {
    for (const result of [
      { exitCode: 126, stdout: "", stderr: "permission denied" },
      { exitCode: 0, stdout: "hello\n", stderr: "" },
      { exitCode: 1, stdout: "container CLI version 1.6.1 (build: release, commit: 804209b)\n", stderr: "" },
    ]) {
      const { runtime } = make([{ argv: argv.version, result }]);
      expect((await runtime.detect()).problem, JSON.stringify(result)).toEqual({ code: "runtime.unusable", data: { runtime: "apple-container" } });
    }
  });

  test("a container tool elsewhere on the search path is never run", async () => {
    const { runtime, runner } = make([
      { argv: ["container", "--version"], result: rec("cli-version") },
      { argv: ["container", "system", "status", "--format", "json"], result: rec("system-status-running") },
      { argv: ["container", "image", "pull", "--platform", "linux/arm64", "--progress", "plain", IMAGE], result: rec("pull") },
      { argv: ["container", "inspect", NAME], result: rec("inspect-running") },
    ]);
    expect((await runtime.detect()).problem?.code).toBe("runtime.not_installed");
    expect((await runtime.pull(IMAGE)).ok).toBe(false);
    expect((await runtime.status(NAME)).ok).toBe(false);
    await runtime.start(spec());
    await runtime.stop(NAME);
    await runtime.remove(NAME);
    await runtime.removeImage(IMAGE);
    await runtime.logs(NAME, { follow: false, onLine: () => {} });
    expect(runner.calls.length).toBeGreaterThan(0);
    expect(runner.calls.every((call) => call[0] === TOOL)).toBe(true);
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

  // A failed run says nothing that shows it made the container, so start never deletes one it cannot be sure it made.
  test("a port that is in use gives runtime.port_in_use and deletes nothing", async () => {
    const { runtime, runner } = make([{ argv: argv.run, result: rec("run-port-in-use") }]);
    expect(await runtime.start(spec())).toEqual({ ok: false, error: { code: "runtime.port_in_use", data: { port: 41823 } } });
    expect(runner.calls.some((call) => call.includes("delete"))).toBe(false);
  });

  test("an image that is not stored gives runtime.image_not_found", async () => {
    const { runtime, runner } = make([{ argv: argv.run, result: rec("run-image-not-found") }]);
    expect(await runtime.start(spec())).toEqual({ ok: false, error: { code: "runtime.image_not_found", data: {} } });
    expect(runner.calls.some((call) => call.includes("delete"))).toBe(false);
  });

  // The text is made up for the test: only the shape matters, a not-found error that is not about the image.
  test("a missing kernel is not a missing image: it gives runtime.start_failed with the exit code", async () => {
    const { runtime, runner } = make([
      { argv: argv.run, result: { exitCode: 1, stdout: "", stderr: 'Error: notFound: "default kernel not found"\n' } },
    ]);
    expect(await runtime.start(spec())).toEqual({ ok: false, error: { code: "runtime.start_failed", data: { exitCode: 1 } } });
    expect(runner.calls.some((call) => call.includes("delete"))).toBe(false);
  });

  test("an access error that does not name the image is runtime.start_failed too", async () => {
    const { runtime } = make([
      { argv: argv.run, result: { exitCode: 1, stdout: "", stderr: 'Error: internalError: "permission denied on the mounted folder"\n' } },
    ]);
    expect(await runtime.start(spec())).toEqual({ ok: false, error: { code: "runtime.start_failed", data: { exitCode: 1 } } });
  });

  test("a system service that is off gives runtime.apple_not_started", async () => {
    const { runtime } = make([{ argv: argv.run, result: rec("run-service-down") }]);
    expect(await runtime.start(spec())).toEqual({ ok: false, error: { code: "runtime.apple_not_started", data: {} } });
  });

  test("any other failure gives runtime.start_failed with the exit code and deletes nothing", async () => {
    const { runtime, runner } = make([{ argv: argv.run, result: { exitCode: 3, stdout: "", stderr: "Error: something odd\n" } }]);
    expect(await runtime.start(spec())).toEqual({ ok: false, error: { code: "runtime.start_failed", data: { exitCode: 3 } } });
    expect(runner.calls).toEqual([argv.run]);
  });

  // Exit 0 means the tool made the container in this call (a taken name fails with "container already exists"), so it is ours to remove.
  test("a success that prints no ID counts as failed and clears the container this call made", async () => {
    const { runtime, runner } = make([
      { argv: argv.run, result: { exitCode: 0, stdout: "", stderr: "" } },
      { argv: argv.delete, result: rec("delete") },
    ]);
    expect(await runtime.start(spec())).toEqual({ ok: false, error: { code: "runtime.start_failed", data: { exitCode: 0 } } });
    expect(runner.calls).toContainEqual(argv.delete);
  });

  test("it asks for the defaults of the manager when the spec has no caps", async () => {
    const wanted = runArgv(spec({ memoryBytes: null, cpus: null }), DEFAULTS);
    const { runtime, runner } = make([{ argv: wanted, result: rec("run") }]);
    expect((await runtime.start(spec({ memoryBytes: null, cpus: null }))).ok).toBe(true);
    expect(runner.calls[0]).toContain("--memory");
    expect(runner.calls[0]).toContain("--cpus");
  });
});

describe("pull", () => {
  test("the recorded plain output gives part counts, then the writing phase", async () => {
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
    const other = [TOOL, "image", "pull", "--platform", "linux/arm64/v8", "--progress", "plain", IMAGE];
    const { runtime, runner } = make([{ argv: other, result: rec("pull") }]);
    await runtime.pull(IMAGE, { platform: "linux/arm64/v8" });
    expect(runner.calls).toEqual([other]);
  });

  test("an image that is not at the registry gives runtime.image_not_found", async () => {
    const { runtime } = make([{ argv: argv.pull, result: rec("pull-not-found") }]);
    expect(await runtime.pull(IMAGE)).toEqual({ ok: false, error: { code: "runtime.image_not_found", data: {} } });
  });

  // The texts are made up for the test: a bare "denied" or "notFound" is not proof that the image is missing.
  test("an access refusal, or a not-found error about something else, is runtime.pull_failed", async () => {
    for (const stderr of [
      "Error: internalError: \"denied: requested access to the resource is denied\"\n",
      "Error: notFound: \"default kernel not found\"\n",
      "Error: unauthorized: authentication required\n",
    ]) {
      const { runtime } = make([{ argv: argv.pull, result: { exitCode: 1, stdout: "", stderr } }]);
      expect(await runtime.pull(IMAGE), stderr).toEqual({ ok: false, error: { code: "runtime.pull_failed", data: { exitCode: 1 } } });
    }
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
  ] as const;
  for (const [recording, expected] of states) {
    test(`${recording} reads as ${expected.state}`, async () => {
      const { runtime } = make([{ argv: argv.inspect, result: rec(recording) }]);
      expect(await runtime.status(NAME)).toEqual({ ok: true, value: expected });
    });
  }

  test("a plain string in status is not a state the tool prints, so it is runtime.command_failed", async () => {
    const flat = '[{"id":"aidm-engine","status":"running"}]';
    const { runtime } = make([{ argv: argv.inspect, result: { exitCode: 0, stdout: flat, stderr: "" } }]);
    expect(await runtime.status(NAME)).toEqual({
      ok: false,
      error: { code: "runtime.command_failed", data: { operation: "status", exitCode: 0 } },
    });
  });

  // The text is made up for the test.
  test("a not-found error about something else is not a missing container", async () => {
    const { runtime } = make([
      { argv: argv.inspect, result: { exitCode: 1, stdout: "", stderr: 'Error: notFound: "default kernel not found"\n' } },
    ]);
    expect(await runtime.status(NAME)).toEqual({
      ok: false,
      error: { code: "runtime.command_failed", data: { operation: "status", exitCode: 1 } },
    });
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
    const followed = [TOOL, "logs", "-f", "-n", "50", NAME];
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
    const timed = [TOOL, "stop", "-t", "30", NAME];
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
