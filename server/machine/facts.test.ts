import { expect, test } from "bun:test";
import { ScriptedRunner, recorded } from "../../test-support/scripted-runner.ts";
import { gatherMachineFacts, type MachineFactsDeps } from "./facts.ts";

function deps(runner: ScriptedRunner, overrides: Partial<MachineFactsDeps> = {}): MachineFactsDeps {
  return {
    platform: "linux",
    arch: "x64",
    runner,
    readFile: () => null,
    totalMemory: () => 1000,
    freeBytes: (path) => (path === "/data" ? 2000 : 0),
    dataFolder: "/data",
    ...overrides,
  };
}

test("on Linux the facts hold the CPU text, the memory, the free disk and the NVIDIA cards", async () => {
  const runner = new ScriptedRunner([{ argv: ["nvidia-smi", "-L"], result: recorded("nvidia", "smi-l") }]);
  const facts = await gatherMachineFacts(
    deps(runner, { readFile: (path) => (path === "/proc/cpuinfo" ? "flags : avx2\n" : null) }),
  );
  expect(facts.cpuInfo).toBe("flags : avx2\n");
  expect(facts.totalMemory).toBe(1000);
  expect(facts.freeDisk).toBe(2000);
  expect(facts.nvidia.driverAnswers).toBe(true);
  expect(facts.nvidia.gpus).toHaveLength(1);
  expect(facts.nvidia.gpus[0]).toStartWith("GPU 0: NVIDIA GeForce RTX 4070");
  expect(facts.runtimes.map((runtime) => runtime.id)).toEqual(["podman", "docker"]);
  expect(facts.macosVersion).toBeNull();
});

test("an NVIDIA driver that does not answer means no cards", async () => {
  const facts = await gatherMachineFacts(deps(new ScriptedRunner([])));
  expect(facts.nvidia).toEqual({ driverAnswers: false, gpus: [] });
});

test("on Linux with an Arm processor the NVIDIA driver is not asked, because there is no graphics card package", async () => {
  const runner = new ScriptedRunner([{ argv: ["nvidia-smi", "-L"], result: recorded("nvidia", "smi-l") }]);
  const facts = await gatherMachineFacts(deps(runner, { arch: "arm64" }));
  expect(facts.nvidia).toEqual({ driverAnswers: false, gpus: [] });
  expect(runner.calls.map((call) => call[0])).not.toContain("nvidia-smi");
});

test("on macOS the facts hold the system version and no CPU text", async () => {
  const runner = new ScriptedRunner([
    { argv: ["sw_vers", "-productVersion"], result: recorded("macos", "sw-vers-26") },
  ]);
  const facts = await gatherMachineFacts(deps(runner, { platform: "darwin", arch: "arm64", readFile: () => "x" }));
  expect(facts.macosVersion).toBe("26.0.1");
  expect(facts.cpuInfo).toBeNull();
  expect(facts.runtimes.map((runtime) => runtime.id)).toEqual(["apple-container"]);
  expect(runner.calls.map((call) => call[0])).not.toContain("nvidia-smi");
});

test("on Windows no program is run", async () => {
  const runner = new ScriptedRunner([]);
  const facts = await gatherMachineFacts(deps(runner, { platform: "win32" }));
  expect(runner.calls).toEqual([]);
  expect(facts.runtimes).toEqual([]);
});
