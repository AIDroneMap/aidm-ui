import { expect, test } from "bun:test";
import { ScriptedRunner, recorded, type ScriptedRule } from "../../test-support/scripted-runner.ts";
import { appleContainerRuntime } from "./apple-container.ts";
import { dockerRuntime } from "./docker.ts";
import { podmanRuntime } from "./podman.ts";
import { allRuntimes, preferredRuntime } from "./registry.ts";
import type { RuntimeDetection } from "./runtime.ts";

const podmanVersion: ScriptedRule = {
  argv: ["podman", "version", "--format", "json"],
  result: recorded("podman", "version"),
};

function podmanInfo(name: string): ScriptedRule {
  return { argv: ["podman", "info", "--format", "json"], result: recorded("podman", name) };
}

function dockerVersion(name: string): ScriptedRule {
  return { argv: ["docker", "version", "--format", "json"], result: recorded("docker", name) };
}

function dockerInfo(name: string): ScriptedRule {
  return { argv: ["docker", "info", "--format", "json"], result: recorded("docker", name) };
}

const appleVersionArgv = ["container", "system", "version", "--format", "json"];
const appleStatusArgv = ["container", "system", "status", "--format", "json"];

test("rootless Podman with the memory controller is available and can cap memory", async () => {
  const runner = new ScriptedRunner([podmanVersion, podmanInfo("info-rootless")]);
  expect(await podmanRuntime(runner).detect()).toEqual({
    id: "podman",
    available: true,
    version: "5.8.9",
    rootless: true,
    memoryCapEnforced: true,
    problem: null,
  });
});

test("rootless Podman without the memory controller cannot cap memory", async () => {
  const runner = new ScriptedRunner([podmanVersion, podmanInfo("info-rootless-no-memory")]);
  const detection = await podmanRuntime(runner).detect();
  expect(detection.available).toBe(true);
  expect(detection.rootless).toBe(true);
  expect(detection.memoryCapEnforced).toBe(false);
});

test("rootful Podman owns its cgroup, with or without the memory controller listed", async () => {
  for (const name of ["info-rootful", "info-rootful-no-memory"]) {
    const detection = await podmanRuntime(new ScriptedRunner([podmanVersion, podmanInfo(name)])).detect();
    expect(detection.rootless).toBe(false);
    expect(detection.memoryCapEnforced).toBe(true);
  }
});

test("a computer without Podman gives runtime.not_installed", async () => {
  expect(await podmanRuntime(new ScriptedRunner([])).detect()).toEqual({
    id: "podman",
    available: false,
    version: null,
    rootless: null,
    memoryCapEnforced: null,
    problem: { code: "runtime.not_installed", data: { runtime: "podman" } },
  });
});

test("Podman that fails or answers something else is unusable", async () => {
  const failing = new ScriptedRunner([
    { argv: podmanVersion.argv, result: { exitCode: 125, stdout: "", stderr: "Error: boom" } },
  ]);
  expect((await podmanRuntime(failing).detect()).problem?.code).toBe("runtime.unusable");
  const nonsense = new ScriptedRunner([
    podmanVersion,
    { argv: podmanInfo("info-rootless").argv, result: { exitCode: 0, stdout: "{}", stderr: "" } },
  ]);
  expect((await podmanRuntime(nonsense).detect()).problem?.code).toBe("runtime.unusable");
});

test("Docker with a reachable daemon gives the server version", async () => {
  const runner = new ScriptedRunner([dockerVersion("version"), dockerInfo("info")]);
  expect(await dockerRuntime(runner).detect()).toEqual({
    id: "docker",
    available: true,
    version: "29.9.2",
    rootless: false,
    memoryCapEnforced: true,
    problem: null,
  });
});

test("rootless Docker is told apart by its security options", async () => {
  const runner = new ScriptedRunner([dockerVersion("version"), dockerInfo("info-rootless")]);
  expect((await dockerRuntime(runner).detect()).rootless).toBe(true);
});

test("Docker whose info fails is still available, with what is unknown left null", async () => {
  const runner = new ScriptedRunner([dockerVersion("version")]);
  const detection = await dockerRuntime(runner).detect();
  expect(detection.available).toBe(true);
  expect(detection.rootless).toBeNull();
  expect(detection.memoryCapEnforced).toBeNull();
});

test("Docker with no daemon to talk to gives runtime.docker_daemon_unreachable", async () => {
  const detection = await dockerRuntime(new ScriptedRunner([dockerVersion("version-no-daemon")])).detect();
  expect(detection.available).toBe(false);
  expect(detection.problem).toEqual({ code: "runtime.docker_daemon_unreachable", data: { runtime: "docker" } });
});

test("Docker that the operator is not allowed to use gives runtime.docker_permission_denied", async () => {
  const detection = await dockerRuntime(new ScriptedRunner([dockerVersion("version-permission-denied")])).detect();
  expect(detection.available).toBe(false);
  expect(detection.problem).toEqual({ code: "runtime.docker_permission_denied", data: { runtime: "docker" } });
});

test("a computer without Docker gives runtime.not_installed", async () => {
  const detection = await dockerRuntime(new ScriptedRunner([])).detect();
  expect(detection.problem).toEqual({ code: "runtime.not_installed", data: { runtime: "docker" } });
});

test("Apple's container with its service running is available", async () => {
  const runner = new ScriptedRunner([
    { argv: appleVersionArgv, result: recorded("apple-container", "system-version") },
    { argv: appleStatusArgv, result: recorded("apple-container", "system-status-running") },
  ]);
  expect(await appleContainerRuntime(runner).detect()).toEqual({
    id: "apple-container",
    available: true,
    version: "1.6.1",
    rootless: null,
    memoryCapEnforced: true,
    problem: null,
  });
});

test("Apple's container not started, or never registered, gives runtime.apple_not_started", async () => {
  for (const status of ["system-status-not-running", "system-status-unregistered"]) {
    const runner = new ScriptedRunner([
      { argv: appleVersionArgv, result: recorded("apple-container", "system-version-not-started") },
      { argv: appleStatusArgv, result: recorded("apple-container", status) },
    ]);
    const detection = await appleContainerRuntime(runner).detect();
    expect(detection.available).toBe(false);
    expect(detection.version).toBe("1.6.1");
    expect(detection.problem).toEqual({ code: "runtime.apple_not_started", data: {} });
  }
});

test("a Mac without Apple's container gives runtime.not_installed", async () => {
  const detection = await appleContainerRuntime(new ScriptedRunner([])).detect();
  expect(detection.problem).toEqual({ code: "runtime.not_installed", data: { runtime: "apple-container" } });
});

test("each platform asks about its own runtimes", () => {
  const runner = new ScriptedRunner([]);
  expect(allRuntimes(runner, "linux").map((runtime) => runtime.id)).toEqual(["podman", "docker"]);
  expect(allRuntimes(runner, "darwin").map((runtime) => runtime.id)).toEqual(["apple-container"]);
  expect(allRuntimes(runner, "win32")).toEqual([]);
});

function detection(id: RuntimeDetection["id"], available = true): RuntimeDetection {
  return { id, available, version: "1", rootless: null, memoryCapEnforced: null, problem: null };
}

test("Podman is preferred over Docker when both answer", () => {
  expect(preferredRuntime([detection("docker"), detection("podman")])?.id).toBe("podman");
});

test("Docker is used when Podman does not answer", () => {
  expect(preferredRuntime([detection("podman", false), detection("docker")])?.id).toBe("docker");
});

test("the runtime the operator chose overrides the order, but only while it answers", () => {
  const both = [detection("podman"), detection("docker")];
  expect(preferredRuntime(both, "docker")?.id).toBe("docker");
  expect(preferredRuntime([detection("podman"), detection("docker", false)], "docker")?.id).toBe("podman");
});

test("no runtime that answers means no preferred runtime", () => {
  expect(preferredRuntime([detection("podman", false)])).toBeNull();
  expect(preferredRuntime([])).toBeNull();
});
