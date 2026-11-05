import { expect, test } from "bun:test";
import { ScriptedRunner, recorded } from "../../test-support/scripted-runner.ts";
import { gatherMachineFacts, windowsBuild, type MachineFactsDeps } from "./facts.ts";
import { NVIDIA_QUERY_ARGV } from "./gpu.ts";

function deps(runner: ScriptedRunner, overrides: Partial<MachineFactsDeps> = {}): MachineFactsDeps {
  return {
    platform: "linux",
    arch: "x64",
    runner,
    readFile: () => null,
    totalMemory: () => 1000,
    freeBytes: (path) => (path === "/data" ? 2000 : 0),
    dataFolder: "/data",
    osRelease: () => "6.8.0-generic",
    windowsHasAvx2: () => {
      throw new Error("asked for AVX2 outside Windows");
    },
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
  expect(facts.nvidia).toEqual({ driverAnswers: false, gpus: [], driverVersion: null });
});

test("on Linux with an Arm processor the NVIDIA driver is not asked, because there is no graphics card package", async () => {
  const runner = new ScriptedRunner([{ argv: ["nvidia-smi", "-L"], result: recorded("nvidia", "smi-l") }]);
  const facts = await gatherMachineFacts(deps(runner, { arch: "arm64" }));
  expect(facts.nvidia).toEqual({ driverAnswers: false, gpus: [], driverVersion: null });
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

function windows(overrides: Partial<MachineFactsDeps> = {}): Partial<MachineFactsDeps> {
  return { platform: "win32", osRelease: () => "10.0.26100", windowsHasAvx2: () => true, ...overrides };
}

test("on Windows x86-64 the facts hold the build, the AVX2 answer and the cards with their driver version, from one query", async () => {
  const runner = new ScriptedRunner([{ argv: NVIDIA_QUERY_ARGV, result: recorded("nvidia", "smi-query-two") }]);
  const facts = await gatherMachineFacts(deps(runner, windows()));
  expect(facts.windowsBuild).toBe(26100);
  expect(facts.avx2).toBe(true);
  expect(facts.cpuInfo).toBeNull();
  expect(facts.nvidia).toEqual({
    driverAnswers: true,
    gpus: ["NVIDIA GeForce RTX 4070", "NVIDIA RTX A2000 12GB"],
    driverVersion: "566.36",
  });
  // No container tool is asked, for the card or for anything else.
  expect(runner.calls).toEqual([NVIDIA_QUERY_ARGV]);
  expect(facts.runtimes).toEqual([]);
});

test("on Windows a driver that fails and a driver that is not installed both mean no card", async () => {
  const failing = new ScriptedRunner([{ argv: NVIDIA_QUERY_ARGV, result: recorded("nvidia", "smi-query-no-driver") }]);
  expect((await gatherMachineFacts(deps(failing, windows()))).nvidia).toEqual({ driverAnswers: false, gpus: [], driverVersion: null });
  const missing = new ScriptedRunner([]);
  expect((await gatherMachineFacts(deps(missing, windows()))).nvidia).toEqual({ driverAnswers: false, gpus: [], driverVersion: null });
  expect(missing.calls).toEqual([NVIDIA_QUERY_ARGV]);
});

test("on Windows an AVX2 call that cannot be made is kept as unknown", async () => {
  const facts = await gatherMachineFacts(deps(new ScriptedRunner([]), windows({ windowsHasAvx2: () => null })));
  expect(facts.avx2).toBeNull();
});

test("on Windows on ARM neither the driver nor the processor is asked, and no program is run", async () => {
  const runner = new ScriptedRunner([{ argv: NVIDIA_QUERY_ARGV, result: recorded("nvidia", "smi-query") }]);
  const facts = await gatherMachineFacts(
    deps(runner, windows({ arch: "arm64", windowsHasAvx2: () => { throw new Error("asked for AVX2 on ARM"); } })),
  );
  expect(runner.calls).toEqual([]);
  expect(facts.avx2).toBeNull();
  expect(facts.windowsBuild).toBe(26100);
  expect(facts.nvidia.driverAnswers).toBe(false);
});

test("the Windows build is the third part of the release, and anything else is unreadable", () => {
  expect(windowsBuild("10.0.22000")).toBe(22000);
  expect(windowsBuild("10.0.19045")).toBe(19045);
  expect(windowsBuild("10.0.26100.4061")).toBe(26100);
  expect(windowsBuild("")).toBeNull();
  expect(windowsBuild("10.0")).toBeNull();
});

test("outside Windows no build is read", async () => {
  const facts = await gatherMachineFacts(deps(new ScriptedRunner([]), { osRelease: () => "10.0.26100" }));
  expect(facts.windowsBuild).toBeNull();
  expect(facts.avx2).toBeNull();
});
