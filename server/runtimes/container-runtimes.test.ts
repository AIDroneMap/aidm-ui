import { describe, expect, test } from "bun:test";
import { ScriptedRunner, recorded, recordedText, type ScriptedRule } from "../../test-support/scripted-runner.ts";
import { dockerPullParser, dockerRuntime, runArgv as dockerRunArgv } from "./docker.ts";
import { podmanPullParser, podmanRuntime, runArgv as podmanRunArgv } from "./podman.ts";
import type { ContainerRuntime, ContainerSpec, PullProgress, RuntimeDetection } from "./runtime.ts";

const IMAGE = "docker.io/library/busybox@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e";
const NAME = "aidm-engine";
const GIB = 1024 ** 3;

function spec(patch: Partial<ContainerSpec> = {}): ContainerSpec {
  return {
    name: NAME,
    image: IMAGE,
    platform: null,
    publish: { hostAddress: "127.0.0.1", hostPort: 41823, containerPort: 3000 },
    mounts: [{ hostPath: "/home/operator/engine-data", containerPath: "/var/www/data" }],
    memoryBytes: 8 * GIB,
    cpus: 4,
    gpu: false,
    args: ["--token", "s3cret-token", "--port", "3000"],
    ...patch,
  };
}

function detection(id: "podman" | "docker", memoryCapEnforced: boolean | null = true): RuntimeDetection {
  return { id, available: true, version: "1", rootless: true, memoryCapEnforced, problem: null };
}

const tools = [
  {
    id: "podman" as const,
    make: (runner: ScriptedRunner, log?: (line: string) => void): ContainerRuntime => podmanRuntime(runner, log),
    runArgv: podmanRunArgv,
    mountSuffix: ":Z",
    detectRules: [
      { argv: ["podman", "version", "--format", "json"], result: recorded("podman", "version") },
      { argv: ["podman", "info", "--format", "json"], result: recorded("podman", "info-rootless") },
    ] as ScriptedRule[],
    pull: "pull",
    pullNotFound: "pull-not-found",
  },
  {
    id: "docker" as const,
    make: (runner: ScriptedRunner, log?: (line: string) => void): ContainerRuntime => dockerRuntime(runner, log),
    runArgv: dockerRunArgv,
    mountSuffix: "",
    detectRules: [
      { argv: ["docker", "version", "--format", "json"], result: recorded("docker", "version") },
      { argv: ["docker", "info", "--format", "json"], result: recorded("docker", "info") },
    ] as ScriptedRule[],
    pull: "pull-busybox",
    pullNotFound: "pull-not-found",
  },
];

describe("the command line that starts the container", () => {
  test("Podman publishes on loopback, labels the mount, caps memory and CPUs, and puts the arguments after the image", () => {
    expect(podmanRunArgv(spec({ platform: "linux/amd64" }), detection("podman"))).toEqual([
      "podman", "run", "-d", "--name", NAME,
      "-p", "127.0.0.1:41823:3000",
      "-v", "/home/operator/engine-data:/var/www/data:Z",
      "--memory", "8589934592b", "--cpus", "4",
      "--platform", "linux/amd64",
      IMAGE, "--token", "s3cret-token", "--port", "3000",
    ]);
  });

  test("Docker is the same without the mount label", () => {
    expect(dockerRunArgv(spec(), detection("docker"))).toEqual([
      "docker", "run", "-d", "--name", NAME,
      "-p", "127.0.0.1:41823:3000",
      "-v", "/home/operator/engine-data:/var/www/data",
      "--memory", "8589934592b", "--cpus", "4",
      IMAGE, "--token", "s3cret-token", "--port", "3000",
    ]);
  });

  for (const tool of tools) {
    test(`${tool.id} leaves the caps out when the memory cap would not be enforced`, () => {
      const argv = tool.runArgv(spec(), detection(tool.id, false));
      expect(argv).not.toContain("--memory");
      expect(argv).not.toContain("--cpus");
      expect(argv).toContain(IMAGE);
    });

    test(`${tool.id} keeps the caps when it cannot tell whether they are enforced`, () => {
      expect(tool.runArgv(spec(), detection(tool.id, null))).toContain("--memory");
    });

    test(`${tool.id} sends no cap that the spec leaves out`, () => {
      const argv = tool.runArgv(spec({ memoryBytes: null, cpus: null }), detection(tool.id));
      expect(argv).not.toContain("--memory");
      expect(argv).not.toContain("--cpus");
    });

    test(`${tool.id} never sets a restart policy and publishes on loopback only`, () => {
      const argv = tool.runArgv(spec({ platform: "linux/arm64", gpu: true }), detection(tool.id));
      expect(argv.some((part) => part.startsWith("--restart"))).toBe(false);
      const publish = argv[argv.indexOf("-p") + 1];
      expect(publish?.startsWith("127.0.0.1:")).toBe(true);
      expect(argv.filter((part) => part === "-p")).toHaveLength(1);
    });

    test(`${tool.id} mounts every folder the spec lists`, () => {
      const argv = tool.runArgv(
        spec({ mounts: [{ hostPath: "/a", containerPath: "/x" }, { hostPath: "/b", containerPath: "/y" }] }),
        detection(tool.id),
      );
      expect(argv.filter((part) => part === "-v")).toHaveLength(2);
      expect(argv).toContain(`/a:/x${tool.mountSuffix}`);
      expect(argv).toContain(`/b:/y${tool.mountSuffix}`);
    });
  }
});

for (const tool of tools) {
  describe(`${tool.id} through recorded outputs`, () => {
    const binary = tool.id;
    const cases = (name: string): ScriptedRule["result"] => recorded(binary, name);
    const argv = {
      run: tool.runArgv(spec(), detection(tool.id)),
      rm: [binary, "rm", "-f", NAME],
      inspect: [binary, "inspect", "--format", "json", NAME],
    };

    async function started(runCase: string, extra: ScriptedRule[] = []) {
      const runner = new ScriptedRunner([...tool.detectRules, { argv: argv.run, result: cases(runCase) }, ...extra]);
      return { runner, result: await tool.make(runner).start(spec()) };
    }

    test("a start gives the container ID the tool prints", async () => {
      const { result, runner } = await started("run");
      expect(result).toEqual({ ok: true, value: { containerId: recordedText(binary, "run").trim() } });
      expect(runner.calls).toContainEqual(argv.run);
    });

    test("a name that is in use gives runtime.name_in_use and leaves that container alone", async () => {
      const { result, runner } = await started("run-name-in-use");
      expect(result).toEqual({ ok: false, error: { code: "runtime.name_in_use", data: { name: NAME } } });
      expect(runner.calls).not.toContainEqual(argv.rm);
    });

    test("a port that is in use gives runtime.port_in_use and clears the half-made container", async () => {
      const { result, runner } = await started("run-port-in-use", [{ argv: argv.rm, result: cases("rm") }]);
      expect(result).toEqual({ ok: false, error: { code: "runtime.port_in_use", data: { port: 41823 } } });
      expect(runner.calls).toContainEqual(argv.rm);
    });

    test("any other failure gives runtime.start_failed with the exit code", async () => {
      const runner = new ScriptedRunner([
        ...tool.detectRules,
        { argv: argv.run, result: { exitCode: 125, stdout: "", stderr: "Error: something odd\n" } },
        { argv: argv.rm, result: cases("rm") },
      ]);
      expect(await tool.make(runner).start(spec())).toEqual({
        ok: false,
        error: { code: "runtime.start_failed", data: { exitCode: 125 } },
      });
      expect(runner.calls).toContainEqual(argv.rm);
    });

    test("a program missing inside the image is a failed start, not a missing image", async () => {
      const runner = new ScriptedRunner([
        ...tool.detectRules,
        {
          argv: argv.run,
          result: { exitCode: 127, stdout: "", stderr: 'exec: "aidm-api": executable file not found in $PATH\n' },
        },
      ]);
      const result = await tool.make(runner).start(spec());
      expect(result).toEqual({ ok: false, error: { code: "runtime.start_failed", data: { exitCode: 127 } } });
    });

    test("a start that prints no container ID is a failed start", async () => {
      const runner = new ScriptedRunner([...tool.detectRules, { argv: argv.run, result: { exitCode: 0, stdout: "", stderr: "" } }]);
      expect(await tool.make(runner).start(spec())).toEqual({
        ok: false,
        error: { code: "runtime.start_failed", data: { exitCode: 0 } },
      });
    });

    test("a pull passes the image, and the platform when there is one", async () => {
      const runner = new ScriptedRunner([
        { argv: [binary, "pull", "--platform", "linux/arm64", IMAGE], result: cases(tool.pull) },
      ]);
      expect(await tool.make(runner).pull(IMAGE, { platform: "linux/arm64" })).toEqual({ ok: true, value: undefined });
    });

    test("a pull gives progress from the plain output", async () => {
      const runner = new ScriptedRunner([{ argv: [binary, "pull", IMAGE], result: cases(tool.pull) }]);
      const seen: PullProgress[] = [];
      const result = await tool.make(runner).pull(IMAGE, { onProgress: (progress) => seen.push(progress) });
      expect(result).toEqual({ ok: true, value: undefined });
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.at(-1)?.phase).toBe("writing");
    });

    test("an image the registry does not have gives runtime.image_not_found", async () => {
      const runner = new ScriptedRunner([{ argv: [binary, "pull", IMAGE], result: cases(tool.pullNotFound) }]);
      expect(await tool.make(runner).pull(IMAGE)).toEqual({ ok: false, error: { code: "runtime.image_not_found", data: {} } });
    });

    test("any other failed pull gives runtime.pull_failed with the exit code", async () => {
      const runner = new ScriptedRunner([
        { argv: [binary, "pull", IMAGE], result: { exitCode: 1, stdout: "", stderr: "dial tcp: i/o timeout\n" } },
      ]);
      expect(await tool.make(runner).pull(IMAGE)).toEqual({
        ok: false,
        error: { code: "runtime.pull_failed", data: { exitCode: 1 } },
      });
    });

    test("a pull with the tool not installed gives runtime.pull_failed, never a missing image", async () => {
      const result = await tool.make(new ScriptedRunner([])).pull(IMAGE);
      expect(result).toEqual({ ok: false, error: { code: "runtime.pull_failed", data: { exitCode: 127 } } });
    });

    test("a running container reports running, with no exit code", async () => {
      const runner = new ScriptedRunner([{ argv: argv.inspect, result: cases("inspect-running") }]);
      expect(await tool.make(runner).status(NAME)).toEqual({
        ok: true,
        value: { state: "running", exitCode: null, oomKilled: false },
      });
    });

    test("a container that was killed reports stopped with exit code 137", async () => {
      const runner = new ScriptedRunner([{ argv: argv.inspect, result: cases("inspect-exited") }]);
      expect(await tool.make(runner).status(NAME)).toEqual({
        ok: true,
        value: { state: "stopped", exitCode: 137, oomKilled: false },
      });
    });

    test("a container that is not there reports missing", async () => {
      const runner = new ScriptedRunner([{ argv: argv.inspect, result: cases("inspect-missing") }]);
      expect(await tool.make(runner).status(NAME)).toEqual({
        ok: true,
        value: { state: "missing", exitCode: null, oomKilled: null },
      });
    });

    test("an inspect that says nothing useful is runtime.command_failed", async () => {
      const runner = new ScriptedRunner([{ argv: argv.inspect, result: { exitCode: 0, stdout: "not json", stderr: "" } }]);
      expect(await tool.make(runner).status(NAME)).toEqual({
        ok: false,
        error: { code: "runtime.command_failed", data: { operation: "status", exitCode: 0 } },
      });
    });

    test("a tool that cannot be reached is runtime.command_failed, not a missing container", async () => {
      const runner = new ScriptedRunner([
        { argv: argv.inspect, result: { exitCode: 125, stdout: "", stderr: "Error: cannot connect\n" } },
      ]);
      expect(await tool.make(runner).status(NAME)).toEqual({
        ok: false,
        error: { code: "runtime.command_failed", data: { operation: "status", exitCode: 125 } },
      });
    });

    test("logs ask for the last lines and hand over every line, from either stream", async () => {
      const runner = new ScriptedRunner([{ argv: [binary, "logs", "--tail", "50", NAME], result: cases("logs") }]);
      const lines: string[] = [];
      const result = await tool.make(runner).logs(NAME, { follow: false, tail: 50, onLine: (line) => lines.push(line) });
      expect(result).toEqual({ ok: true, value: undefined });
      expect(lines).toEqual(["[::ffff:192.0.2.1]:35504: response:200"]);
    });

    test("logs follow with -f", async () => {
      const runner = new ScriptedRunner([{ argv: [binary, "logs", "-f", NAME], result: cases("logs") }]);
      const result = await tool.make(runner).logs(NAME, { follow: true, onLine: () => {} });
      expect(result.ok).toBe(true);
    });

    test("logs of a container that is gone end quietly, without passing the tool's message on", async () => {
      const runner = new ScriptedRunner([{ argv: [binary, "logs", NAME], result: cases("logs-missing") }]);
      const lines: string[] = [];
      const result = await tool.make(runner).logs(NAME, { follow: false, onLine: (line) => lines.push(line) });
      expect(result).toEqual({ ok: true, value: undefined });
      expect(lines).toEqual([]);
    });

    test("logs that fail for another reason are runtime.command_failed", async () => {
      const runner = new ScriptedRunner([
        { argv: [binary, "logs", NAME], result: { exitCode: 1, stdout: "", stderr: "disk on fire\n" } },
      ]);
      const result = await tool.make(runner).logs(NAME, { follow: false, onLine: () => {} });
      expect(result).toEqual({
        ok: false,
        error: { code: "runtime.command_failed", data: { operation: "logs", exitCode: 1 } },
      });
    });

    test("a stop waits 30 seconds by default and takes a time of its own", async () => {
      const runner = new ScriptedRunner([
        { argv: [binary, "stop", "-t", "30", NAME], result: cases("stop") },
        { argv: [binary, "stop", "-t", "5", NAME], result: cases("stop") },
      ]);
      const runtime = tool.make(runner);
      expect(await runtime.stop(NAME)).toEqual({ ok: true, value: undefined });
      expect(await runtime.stop(NAME, 5)).toEqual({ ok: true, value: undefined });
    });

    test("stopping a container that is gone is fine, and any other failure is runtime.command_failed", async () => {
      const gone = new ScriptedRunner([{ argv: [binary, "stop", "-t", "30", NAME], result: cases("stop-missing") }]);
      expect((await tool.make(gone).stop(NAME)).ok).toBe(true);
      const broken = new ScriptedRunner([
        { argv: [binary, "stop", "-t", "30", NAME], result: { exitCode: 1, stdout: "", stderr: "denied\n" } },
      ]);
      expect(await tool.make(broken).stop(NAME)).toEqual({
        ok: false,
        error: { code: "runtime.command_failed", data: { operation: "stop", exitCode: 1 } },
      });
    });

    test("a remove is forced, and a missing container is fine", async () => {
      for (const name of ["rm", "rm-missing"]) {
        const runner = new ScriptedRunner([{ argv: argv.rm, result: cases(name) }]);
        expect(await tool.make(runner).remove(NAME)).toEqual({ ok: true, value: undefined });
      }
      const broken = new ScriptedRunner([{ argv: argv.rm, result: { exitCode: 1, stdout: "", stderr: "denied\n" } }]);
      expect(await tool.make(broken).remove(NAME)).toEqual({
        ok: false,
        error: { code: "runtime.command_failed", data: { operation: "remove", exitCode: 1 } },
      });
    });

    test("an image removal is fine when the image is there or not", async () => {
      for (const name of ["rmi", "rmi-missing"]) {
        const runner = new ScriptedRunner([{ argv: [binary, "rmi", IMAGE], result: cases(name) }]);
        expect(await tool.make(runner).removeImage(IMAGE)).toEqual({ ok: true, value: undefined });
      }
    });

    test("the token is hidden in every command line that is logged, and absent from errors", async () => {
      const logged: string[] = [];
      const runner = new ScriptedRunner([
        ...tool.detectRules,
        { argv: argv.run, result: cases("run-port-in-use") },
        { argv: argv.rm, result: cases("rm") },
      ]);
      const result = await tool.make(runner, (line) => logged.push(line)).start(spec());
      expect(logged.length).toBeGreaterThan(0);
      expect(logged.join("\n")).not.toContain("s3cret-token");
      expect(logged.some((line) => line.includes("--token ***"))).toBe(true);
      expect(JSON.stringify(result)).not.toContain("s3cret-token");
    });
  });
}

test("Podman's pull progress counts the layers it has started, and says writing at the end", async () => {
  const runner = new ScriptedRunner([{ argv: ["podman", "pull", IMAGE], result: recorded("podman", "pull-three-layers") }]);
  const progress: PullProgress[] = [];
  await podmanRuntime(runner).pull(IMAGE, { onProgress: (step) => progress.push(step) });
  expect(progress).toEqual([
    { layersDone: null, layersTotal: 1, phase: "downloading" },
    { layersDone: null, layersTotal: 2, phase: "downloading" },
    { layersDone: null, layersTotal: 3, phase: "downloading" },
    { layersDone: null, layersTotal: 3, phase: "writing" },
  ]);
});

test("Podman's other pull lines say nothing about progress", () => {
  const parse = podmanPullParser();
  expect(parse("Trying to pull docker.io/library/busybox@sha256:abc...")).toBeNull();
  expect(parse("Getting image source signatures")).toBeNull();
});

test("Podman without the memory controller starts the container without the caps", async () => {
  const noCaps = podmanRunArgv(spec(), detection("podman", false));
  const runner = new ScriptedRunner([
    { argv: ["podman", "version", "--format", "json"], result: recorded("podman", "version") },
    { argv: ["podman", "info", "--format", "json"], result: recorded("podman", "info-rootless-no-memory") },
    { argv: noCaps, result: recorded("podman", "run") },
  ]);
  expect((await podmanRuntime(runner).start(spec())).ok).toBe(true);
  expect(runner.calls.at(-1)).toEqual(noCaps);
});

test("Podman's recorded pull of one layer gives one layer and then writing", async () => {
  const runner = new ScriptedRunner([{ argv: ["podman", "pull", IMAGE], result: recorded("podman", "pull") }]);
  const progress: PullProgress[] = [];
  await podmanRuntime(runner).pull(IMAGE, { onProgress: (step) => progress.push(step) });
  expect(progress).toEqual([
    { layersDone: null, layersTotal: 1, phase: "downloading" },
    { layersDone: null, layersTotal: 1, phase: "writing" },
  ]);
});

test("Docker's progress counts layers started and layers finished", () => {
  const parse = dockerPullParser();
  const progress = recordedText("docker", "pull-no-tty")
    .split("\n")
    .map((line) => parse(line))
    .filter((step): step is PullProgress => step !== null);
  expect(progress[0]).toEqual({ layersDone: 0, layersTotal: 1, phase: "downloading" });
  expect(progress.at(-1)).toEqual({ layersDone: 10, layersTotal: 10, phase: "writing" });
  // Never goes backwards, and finished never passes the total.
  for (const step of progress) expect(step.layersDone ?? 0).toBeLessThanOrEqual(step.layersTotal ?? 0);
  expect(progress.map((step) => step.layersDone)).toEqual([...progress.map((step) => step.layersDone)].sort((a, b) => (a ?? 0) - (b ?? 0)));
});

test("Docker's newer pull output, with the image ID on the first line, gives one layer", async () => {
  const runner = new ScriptedRunner([{ argv: ["docker", "pull", IMAGE], result: recorded("docker", "pull-busybox") }]);
  const progress: PullProgress[] = [];
  await dockerRuntime(runner).pull(IMAGE, { onProgress: (step) => progress.push(step) });
  expect(progress).toEqual([
    { layersDone: 0, layersTotal: 1, phase: "downloading" },
    { layersDone: 0, layersTotal: 1, phase: "writing" },
    { layersDone: 1, layersTotal: 1, phase: "writing" },
  ]);
});

test("a layer that Docker already has counts as done", () => {
  const parse = dockerPullParser();
  expect(parse("aaaaaaaaaaaa: Already exists")).toEqual({ layersDone: 1, layersTotal: 1, phase: "writing" });
});
