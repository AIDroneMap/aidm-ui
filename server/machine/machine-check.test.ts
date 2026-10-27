import { afterEach, expect, test } from "bun:test";
import type { CheckLine, MachineCheckView, WizardView } from "../../shared/api-types.ts";
import {
  NVIDIA_RULE,
  appleRules,
  dockerRules,
  linuxInputs,
  podmanRules,
  recordedMachine,
  type MachineInputs,
  type RecordedMachine,
} from "../../test-support/recorded-machine.ts";
import { recorded, recordedText } from "../../test-support/scripted-runner.ts";
import { eventually, openHarness, type Harness } from "../testing/harness.ts";
import { RAM_REFUSE_BELOW, RAM_WARN_BELOW, RUN_FREE_DISK } from "./thresholds.ts";

const GiB = 1024 ** 3;

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

function open(inputs: MachineInputs): { h: Harness; machine: RecordedMachine } {
  const machine = recordedMachine(inputs);
  harness = openHarness({ machine });
  return { h: harness, machine };
}

async function check(h: Harness, method: "GET" | "POST" = "GET"): Promise<MachineCheckView> {
  const response = await fetch(`${h.base}/api/machine-check`, { method });
  expect(response.status).toBe(200);
  return (await response.json()) as MachineCheckView;
}

function lineOf(view: MachineCheckView, id: CheckLine["id"]): CheckLine {
  const found = view.lines.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`No ${id} line in ${JSON.stringify(view.lines)}`);
  return found;
}

const withRuntime = podmanRules("info-rootless");

test("recorded CPU information without avx2 fails the cpu line and the local engine is not offered", async () => {
  const { h } = open(linuxInputs({ cpuInfo: recordedText("cpuinfo", "x86-64-no-avx2"), rules: withRuntime }));
  const view = await check(h);
  expect(lineOf(view, "cpu")).toEqual({
    id: "cpu",
    result: "fail",
    message: { code: "machine.cpu_missing", data: { missing: "avx2, fma" } },
  });
  expect(view.localEngine.offered).toBe(false);
  expect(view.localEngine.reason?.code).toBe("machine.cpu_missing");
});

test("recorded arm64 information without atomics fails the cpu line and the local engine is not offered", async () => {
  const arm = linuxInputs({ arch: "arm64", cpuInfo: recordedText("cpuinfo", "arm64-v8-0"), rules: withRuntime });
  const { h } = open(arm);
  const view = await check(h);
  expect(lineOf(view, "cpu").message).toEqual({
    code: "machine.cpu_missing",
    data: { missing: "atomics, asimdrdm" },
  });
  expect(view.localEngine.offered).toBe(false);
});

test("recorded CPU information with the full flags passes on both architectures", async () => {
  const x86 = open(linuxInputs({ rules: withRuntime }));
  expect(lineOf(await check(x86.h), "cpu").result).toBe("pass");
  await harness?.stop();

  const arm = open(
    linuxInputs({ arch: "arm64", cpuInfo: recordedText("cpuinfo", "arm64-v8-2"), rules: withRuntime }),
  );
  const view = await check(arm.h);
  expect(lineOf(view, "cpu")).toEqual({ id: "cpu", result: "pass", message: { code: "machine.cpu_ok", data: {} } });
  expect(view.localEngine).toEqual({ offered: true, reason: null });
});

test("CPU information that cannot be read is a warning and the local engine is still offered", async () => {
  const { h } = open(linuxInputs({ cpuInfo: null, rules: withRuntime }));
  const view = await check(h);
  expect(lineOf(view, "cpu").message.code).toBe("machine.cpu_unknown");
  expect(lineOf(view, "cpu").result).toBe("warn");
  expect(view.localEngine.offered).toBe(true);
});

test("12 GiB of RAM warns, 6 GiB fails and 32 GiB is quiet", async () => {
  const warn = open(linuxInputs({ totalMemory: RAM_WARN_BELOW - 4 * GiB, rules: withRuntime }));
  const warned = await check(warn.h);
  expect(lineOf(warned, "ram")).toEqual({
    id: "ram",
    result: "warn",
    message: { code: "machine.ram_low", data: { total: 12 * GiB, recommended: RAM_WARN_BELOW } },
  });
  expect(warned.localEngine.offered).toBe(true);
  await harness?.stop();

  const fail = open(linuxInputs({ totalMemory: RAM_REFUSE_BELOW - 2 * GiB, rules: withRuntime }));
  const failed = await check(fail.h);
  expect(lineOf(failed, "ram")).toEqual({
    id: "ram",
    result: "fail",
    message: { code: "machine.ram_too_low", data: { total: 6 * GiB, minimum: RAM_REFUSE_BELOW } },
  });
  expect(failed.localEngine.offered).toBe(false);
  expect(failed.localEngine.reason?.code).toBe("machine.ram_too_low");
  await harness?.stop();

  const quiet = open(linuxInputs({ totalMemory: RAM_WARN_BELOW * 2, rules: withRuntime }));
  const passed = await check(quiet.h);
  expect(lineOf(passed, "ram").message).toEqual({ code: "machine.ram_ok", data: { total: 32 * GiB } });
  expect(passed.lines.map((line) => line.result)).toEqual(["pass", "pass", "pass", "pass", "pass", "pass"]);
});

test("RAM exactly at a threshold is on the better side of it", async () => {
  const atRefuse = open(linuxInputs({ totalMemory: RAM_REFUSE_BELOW, rules: withRuntime }));
  expect(lineOf(await check(atRefuse.h), "ram").message.code).toBe("machine.ram_low");
  await harness?.stop();
  const atWarn = open(linuxInputs({ totalMemory: RAM_WARN_BELOW, rules: withRuntime }));
  expect(lineOf(await check(atWarn.h), "ram").message.code).toBe("machine.ram_ok");
});

test("free disk below what a run needs warns and does not stop the local engine", async () => {
  const low = open(linuxInputs({ freeDisk: RUN_FREE_DISK - 1, rules: withRuntime }));
  const view = await check(low.h);
  expect(lineOf(view, "disk")).toEqual({
    id: "disk",
    result: "warn",
    message: { code: "machine.disk_low", data: { free: RUN_FREE_DISK - 1, needed: RUN_FREE_DISK } },
  });
  expect(view.localEngine.offered).toBe(true);
  await harness?.stop();

  const enough = open(linuxInputs({ freeDisk: RUN_FREE_DISK, rules: withRuntime }));
  expect(lineOf(await check(enough.h), "disk").message.code).toBe("machine.disk_ok");
});

test("the gpu line counts the cards when the NVIDIA driver answers and passes quietly when it does not", async () => {
  const withCard = open(linuxInputs({ rules: [...withRuntime, NVIDIA_RULE] }));
  expect(lineOf(await check(withCard.h), "gpu").message).toEqual({ code: "machine.gpu_nvidia", data: { count: 1 } });
  await harness?.stop();

  const without = open(linuxInputs({ rules: withRuntime }));
  expect(lineOf(await check(without.h), "gpu")).toEqual({
    id: "gpu",
    result: "pass",
    message: { code: "machine.gpu_none", data: {} },
  });
});

test("on Linux with an Arm processor there is no gpu line, even when a driver would answer", async () => {
  const arm = open(linuxInputs({ arch: "arm64", cpuInfo: recordedText("cpuinfo", "arm64-v8-2"), rules: [...withRuntime, NVIDIA_RULE] }));
  expect((await check(arm.h)).lines.map((candidate) => candidate.id)).not.toContain("gpu");
});

test("with no runtime detected the runtime line says so in one code and the install is still offered", async () => {
  const { h, machine } = open(linuxInputs({ rules: [] }));
  const view = await check(h);
  expect(lineOf(view, "runtime")).toEqual({
    id: "runtime",
    result: "warn",
    message: { code: "machine.runtime_none", data: {} },
  });
  expect(view.localEngine).toEqual({ offered: true, reason: null });
  // Every runtime was asked, and none was there.
  expect(machine.calls.map((call) => call[0])).toContain("podman");
  expect(machine.calls.map((call) => call[0])).toContain("docker");
});

test("a runtime that is installed but cannot be used says so with its own problem code and data", async () => {
  const { h } = open(linuxInputs({ rules: dockerRules("version-no-daemon") }));
  const view = await check(h);
  expect(lineOf(view, "runtime")).toEqual({
    id: "runtime",
    result: "warn",
    message: { code: "runtime.docker_daemon_unreachable", data: { runtime: "docker" } },
  });
  expect(view.localEngine.offered).toBe(true);
});

test("Docker that the user may not use says so with the permission code", async () => {
  const { h } = open(linuxInputs({ rules: dockerRules("version-permission-denied") }));
  expect(lineOf(await check(h), "runtime").message).toEqual({
    code: "runtime.docker_permission_denied",
    data: { runtime: "docker" },
  });
});

test("Apple's container tool that is not started says so, and nothing installed is still runtime_none", async () => {
  const mac = open(macInputs("26", { rules: [...macInputs("26").rules, ...appleRules(false)] }));
  expect(lineOf(await check(mac.h), "runtime").message).toEqual({
    code: "runtime.apple_not_started",
    data: {},
  });
  await harness?.stop();

  const bare = open(macInputs("26"));
  expect(lineOf(await check(bare.h), "runtime").message.code).toBe("machine.runtime_none");
});

test("the runtime line names the preferred runtime and its version", async () => {
  const { h } = open(linuxInputs({ rules: [...dockerRules("version"), ...podmanRules("info-rootless")] }));
  const view = await check(h);
  expect(lineOf(view, "runtime")).toEqual({
    id: "runtime",
    result: "pass",
    message: { code: "machine.runtime_found_podman", data: { runtime: "podman", version: "5.8.9" } },
  });
});

test("on a Mac with Apple's container tool running, the runtime line names the tool and its version", async () => {
  const mac = open(macInputs("26", { rules: [...macInputs("26").rules, ...appleRules(true)] }));
  expect(lineOf(await check(mac.h), "runtime")).toEqual({
    id: "runtime",
    result: "pass",
    message: { code: "machine.runtime_found_apple_container", data: { runtime: "apple-container", version: "1.6.1" } },
  });
});

test("the runtime the operator chose in settings wins over Podman", async () => {
  const { h } = open(linuxInputs({ rules: [...dockerRules("version"), ...podmanRules("info-rootless")] }));
  h.settings.set("runtime.preferred", "docker");
  const view = await check(h);
  expect(lineOf(view, "runtime").message).toEqual({
    code: "machine.runtime_found_docker",
    data: { runtime: "docker", version: "29.9.2" },
  });
});

test("rootless Podman without the memory controller warns that a memory cap cannot be enforced", async () => {
  const { h } = open(linuxInputs({ rules: podmanRules("info-rootless-no-memory") }));
  const view = await check(h);
  expect(lineOf(view, "runtime")).toEqual({
    id: "runtime",
    result: "warn",
    message: { code: "machine.runtime_no_memory_cap", data: { runtime: "podman" } },
  });
  expect(view.localEngine.offered).toBe(true);
});

test("Check again after changing the recorded inputs returns the new lines; a read keeps the last result", async () => {
  const { h, machine } = open(linuxInputs({ rules: withRuntime }));
  const first = await check(h);
  expect(lineOf(first, "ram").result).toBe("pass");

  machine.inputs = linuxInputs({ totalMemory: 6 * GiB, rules: [] });
  const stillFirst = await check(h);
  expect(stillFirst).toEqual(first);

  const again = await check(h, "POST");
  expect(lineOf(again, "ram").result).toBe("fail");
  expect(lineOf(again, "runtime").message.code).toBe("machine.runtime_none");
  expect(again.localEngine.offered).toBe(false);
  expect(await check(h)).toEqual(again);
});

test("a read after 60 seconds runs the check again and a read within 60 seconds does not", async () => {
  const { h, machine } = open(linuxInputs({ rules: withRuntime }));
  h.clock.now = Date.parse("2026-10-26T12:00:00Z");
  const first = await check(h);
  expect(lineOf(first, "ram").result).toBe("pass");

  machine.inputs = linuxInputs({ totalMemory: 6 * GiB, rules: withRuntime });
  h.clock.now += 60_000;
  expect(await check(h)).toEqual(first);

  h.clock.now += 1;
  const later = await check(h);
  expect(lineOf(later, "ram").result).toBe("fail");
  expect(later.checkedAt).toBe("2026-10-26T12:01:00.001Z");
});

/** A computer whose answers wait until the test lets them through, one call at a time. */
function gatedMachine(inner: RecordedMachine) {
  const waiting: Array<() => void> = [];
  return {
    inputs: inner.inputs,
    get calls() {
      return waiting.length;
    },
    release(index: number) {
      waiting[index]?.();
    },
    gather: () => {
      // What the computer is like is read when the call starts.
      const facts = inner.gather();
      return new Promise<Awaited<typeof facts>>((resolve) => {
        waiting.push(() => resolve(facts));
      });
    },
  };
}

test("a new check never joins one in flight: it runs after that one finishes and sees the computer as it is then", async () => {
  const inner = recordedMachine(linuxInputs({ rules: withRuntime }));
  const gated = gatedMachine(inner);
  harness = openHarness({ machine: gated });
  const h = harness;
  const post = () => fetch(`${h.base}/api/machine-check`, { method: "POST" }).then((r) => r.json() as Promise<MachineCheckView>);

  const reading = fetch(`${h.base}/api/machine-check`).then((r) => r.json() as Promise<MachineCheckView>);
  await eventually(async () => gated.calls === 1);

  inner.inputs = linuxInputs({ totalMemory: 6 * GiB, rules: withRuntime });
  const again = post();
  // The new check waits for the one in flight.
  await Bun.sleep(50);
  expect(gated.calls).toBe(1);

  gated.release(0);
  const first = await reading;
  expect(lineOf(first, "ram").result).toBe("pass");
  await eventually(async () => gated.calls === 2);
  gated.release(1);
  const second = await again;
  expect(lineOf(second, "ram").result).toBe("fail");
});

test("the check reports when it ran", async () => {
  const { h } = open(linuxInputs());
  h.clock.now = Date.parse("2026-10-26T12:00:00Z");
  const view = await check(h, "POST");
  expect(view.checkedAt).toBe("2026-10-26T12:00:00.000Z");
});

test("on recorded Windows inputs the local engine is not available yet and no program is run", async () => {
  const { h, machine } = open(
    linuxInputs({ platform: "win32", cpuInfo: null, rules: [...withRuntime, ...dockerRules("version"), NVIDIA_RULE] }),
  );
  const view = await check(h);
  expect(lineOf(view, "platform")).toEqual({
    id: "platform",
    result: "fail",
    message: { code: "machine.windows_not_yet", data: {} },
  });
  expect(view.localEngine.offered).toBe(false);
  expect(view.localEngine.reason?.code).toBe("machine.windows_not_yet");
  expect(view.lines.map((line) => line.id)).toEqual(["platform", "ram", "disk"]);
  expect(machine.calls).toEqual([]);
});

test("a platform the engine is not built for fails with its own code", async () => {
  const { h } = open(linuxInputs({ arch: "ia32" }));
  const view = await check(h);
  expect(lineOf(view, "platform").message.code).toBe("machine.platform_unsupported");
  expect(view.localEngine.offered).toBe(false);
});

function macInputs(version: "26" | "15", extra: Partial<MachineInputs> = {}): MachineInputs {
  return linuxInputs({
    platform: "darwin",
    arch: "arm64",
    cpuInfo: null,
    rules: [{ argv: ["sw_vers", "-productVersion"], result: recorded("macos", `sw-vers-${version}`) }],
    ...extra,
  });
}

test("Apple silicon on macOS 26 passes the platform and cpu lines, and the platform line names the version it found", async () => {
  const { h } = open(macInputs("26"));
  const view = await check(h);
  expect(lineOf(view, "platform").message).toEqual({ code: "machine.platform_ok_macos", data: { version: "26.0.1" } });
  expect(lineOf(view, "cpu").message.code).toBe("machine.cpu_ok");
  expect(view.lines.map((line) => line.id)).toEqual(["platform", "cpu", "ram", "disk", "runtime"]);
  expect(view.localEngine.offered).toBe(true);
});

test("macOS before 26 fails with the version it found and the one it needs", async () => {
  const { h } = open(macInputs("15"));
  const view = await check(h);
  expect(lineOf(view, "platform").message).toEqual({
    code: "machine.macos_too_old",
    data: { version: "15.6.1", minimumVersion: 26 },
  });
  expect(view.localEngine.offered).toBe(false);
});

test("an Intel Mac fails with its own code", async () => {
  const { h } = open(macInputs("26", { arch: "x64" }));
  const view = await check(h);
  expect(lineOf(view, "platform").message.code).toBe("machine.mac_intel");
  expect(view.localEngine.offered).toBe(false);
});

test("the wizard starts open, PUT true finishes it and PUT false reopens it", async () => {
  harness = openHarness();
  const read = async () => (await (await fetch(`${harness!.base}/api/wizard`)).json()) as WizardView;
  const put = (body: unknown) => fetch(`${harness!.base}/api/wizard`, { method: "PUT", body: JSON.stringify(body) });

  expect(await read()).toEqual({ completed: false });
  const done = await put({ completed: true });
  expect(done.status).toBe(200);
  expect(await done.json()).toEqual({ completed: true });
  expect(await read()).toEqual({ completed: true });
  expect(harness.settings.get("wizard.completed")).toBe(true);

  await put({ completed: false });
  expect(await read()).toEqual({ completed: false });
});

test("the wizard refuses a body that is not a yes or a no", async () => {
  harness = openHarness();
  for (const body of [{}, { completed: "yes" }, { completed: 1 }, [], "true"]) {
    const response = await fetch(`${harness.base}/api/wizard`, { method: "PUT", body: JSON.stringify(body) });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "api.invalid_body", data: {} } });
  }
  expect(harness.settings.get("wizard.completed")).toBe(false);
});

test("on Linux the platform line names the system it found in os-release, and says nothing made up when there is none", async () => {
  const named = await check(open(linuxInputs()).h);
  expect(lineOf(named, "platform").message).toEqual({ code: "machine.platform_ok_linux", data: { name: "Ubuntu 24.04.4 LTS" } });
  const unnamed = await check(open(linuxInputs({ osRelease: null })).h);
  expect(lineOf(unnamed, "platform").message).toEqual({ code: "machine.platform_ok", data: {} });
});
