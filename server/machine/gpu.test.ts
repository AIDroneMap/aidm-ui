import { expect, test } from "bun:test";
import { ScriptedRunner, recorded, type ScriptedRule } from "../../test-support/scripted-runner.ts";
import { describeGpu, NVIDIA_TOOLKIT_GUIDE_URL, precheckGpu } from "./gpu.ts";

const x64 = { platform: "linux", arch: "x64" };
const smi: ScriptedRule = { argv: ["nvidia-smi", "-L"], result: recorded("nvidia", "smi-l") };
const smiFails: ScriptedRule = { argv: ["nvidia-smi", "-L"], result: recorded("nvidia", "smi-l-no-driver") };
const dockerInfo = (name: "info" | "info-nvidia-runtime"): ScriptedRule => ({
  argv: ["docker", "info", "--format", "json"],
  result: recorded("docker", name),
});
const cdiList = (name: "cdi-list" | "cdi-list-none"): ScriptedRule => ({
  argv: ["nvidia-ctk", "cdi", "list"],
  result: recorded("nvidia-ctk", name),
});

test("the driver answering and an nvidia runtime in Docker's info are ready, and the source is recorded", async () => {
  const runner = new ScriptedRunner([smi, dockerInfo("info-nvidia-runtime")]);
  expect(await precheckGpu(runner, x64, "docker")).toEqual({
    state: "ready",
    runtime: "docker",
    gpus: 1,
    passthrough: "docker_runtimes",
  });
});

test("the driver answering and the all-cards device in Podman's device list are ready, and the source is recorded", async () => {
  const runner = new ScriptedRunner([smi, cdiList("cdi-list")]);
  expect(await precheckGpu(runner, x64, "podman")).toEqual({
    state: "ready",
    runtime: "podman",
    gpus: 1,
    passthrough: "cdi_devices",
  });
});

test("Docker's info without an nvidia runtime is no passthrough", async () => {
  const runner = new ScriptedRunner([smi, dockerInfo("info")]);
  expect(await precheckGpu(runner, x64, "docker")).toEqual({ state: "no_passthrough", runtime: "docker" });
});

test("an empty device list, and a missing nvidia-ctk, are no passthrough for Podman", async () => {
  expect(await precheckGpu(new ScriptedRunner([smi, cdiList("cdi-list-none")]), x64, "podman")).toEqual({
    state: "no_passthrough",
    runtime: "podman",
  });
  expect(await precheckGpu(new ScriptedRunner([smi]), x64, "podman")).toEqual({
    state: "no_passthrough",
    runtime: "podman",
  });
});

test("a driver that does not answer is no driver, and the toolkit is not asked", async () => {
  for (const rules of [[smiFails], []]) {
    const runner = new ScriptedRunner([...rules, dockerInfo("info-nvidia-runtime")]);
    expect(await precheckGpu(runner, x64, "docker")).toEqual({ state: "no_driver" });
    expect(runner.calls).toEqual([["nvidia-smi", "-L"]]);
  }
});

test("off Linux on an Intel or AMD processor, and with no runtime, no command runs", async () => {
  for (const [facts, runtime] of [
    [{ platform: "linux", arch: "arm64" }, "podman"],
    [{ platform: "darwin", arch: "arm64" }, "apple-container"],
    [{ platform: "win32", arch: "x64" }, null],
    [x64, null],
    [x64, "apple-container"],
  ] as const) {
    const runner = new ScriptedRunner([smi, dockerInfo("info-nvidia-runtime"), cdiList("cdi-list")]);
    expect(await precheckGpu(runner, facts, runtime)).toEqual({ state: "not_checked" });
    expect(runner.calls).toEqual([]);
  }
});

const ready = { state: "ready", runtime: "podman", gpus: 1, passthrough: "cdi_devices" } as const;

test("the view says used when the checks pass, with no reason", () => {
  expect(describeGpu(ready, { forceCpu: false, manifestHasGpuPackage: true })).toEqual({
    state: "used",
    reason: null,
    guideUrl: null,
  });
});

test("the view gives the toolkit reason and the guide link when there is no passthrough", () => {
  expect(
    describeGpu({ state: "no_passthrough", runtime: "docker" }, { forceCpu: false, manifestHasGpuPackage: true }),
  ).toEqual({
    state: "not_used",
    reason: { code: "gpu.no_passthrough", data: { runtime: "docker", guideUrl: NVIDIA_TOOLKIT_GUIDE_URL } },
    guideUrl: NVIDIA_TOOLKIT_GUIDE_URL,
  });
});

test("the view says nothing about a computer with no NVIDIA driver, even when the operator forced the processor", () => {
  for (const forceCpu of [false, true]) {
    expect(describeGpu({ state: "no_driver" }, { forceCpu, manifestHasGpuPackage: true })).toEqual({
      state: "not_used",
      reason: null,
      guideUrl: null,
    });
  }
});

test("forcing the processor gives its own reason and no link", () => {
  expect(describeGpu(ready, { forceCpu: true, manifestHasGpuPackage: true })).toEqual({
    state: "not_used",
    reason: { code: "gpu.forced_cpu", data: {} },
    guideUrl: null,
  });
});

test("a release without a graphics card package, and checks that did not run, give no reason", () => {
  expect(describeGpu(ready, { forceCpu: false, manifestHasGpuPackage: false })).toMatchObject({ state: "not_used", reason: null });
  expect(describeGpu({ state: "not_checked" }, { forceCpu: false, manifestHasGpuPackage: true })).toEqual({
    state: "not_checked",
    reason: null,
    guideUrl: null,
  });
});
