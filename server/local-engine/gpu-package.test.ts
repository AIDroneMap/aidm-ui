import { afterEach, expect, test } from "bun:test";
import type { ApiError } from "../../shared/api-error.ts";
import type { LocalEngineView, PackagesView } from "../../shared/api-types.ts";
import { FakeRuntime } from "../../test-support/fake-runtime.ts";
import { linuxInputs, recordedMachine } from "../../test-support/recorded-machine.ts";
import { ScriptedRunner, recorded, type ScriptedRule } from "../../test-support/scripted-runner.ts";
import { NVIDIA_TOOLKIT_GUIDE_URL } from "../machine/gpu.ts";
import type { RuntimeId } from "../runtimes/runtime.ts";
import { eventually, openHarness, type Harness } from "../testing/harness.ts";

// Criteria of ticket #13. The three checks answer through recorded outputs; the container tool is the fake.

const CPU_IMAGE = "ghcr.io/aidronemap/aidm-api@sha256:a58c2a633f0f7c1df2a1a441321b1404bad98ece8896ef01ca9b18dfeb2e035e";
const GPU_IMAGE = "ghcr.io/aidronemap/aidm-api@sha256:58889cfff9ae903737a38b5a38cb0b019a2a3d869399e0633a26c8cb6ca7f920";
const GPU_FLAGS = { podman: ["--device", "nvidia.com/gpu=all"], docker: ["--gpus", "all"] } as const;

const open: Harness[] = [];
afterEach(async () => {
  for (const harness of open.splice(0)) await harness.stop();
});

type Tool = "podman" | "docker";

/** What the computer answers to the driver and toolkit commands (checks a and b). */
function gpuRules(tool: Tool, answers: { driver: boolean; passthrough: boolean }): ScriptedRule[] {
  const rules: ScriptedRule[] = [];
  rules.push({
    argv: ["nvidia-smi", "-L"],
    result: recorded("nvidia", answers.driver ? "smi-l" : "smi-l-no-driver"),
  });
  if (tool === "docker") {
    rules.push({
      argv: ["docker", "info", "--format", "json"],
      result: recorded("docker", answers.passthrough ? "info-nvidia-runtime" : "info"),
    });
  } else {
    rules.push({
      argv: ["nvidia-ctk", "cdi", "list"],
      result: recorded("nvidia-ctk", answers.passthrough ? "cdi-list" : "cdi-list-none"),
    });
  }
  return rules;
}

function start(tool: Tool, rules: ScriptedRule[], options: Parameters<typeof openHarness>[0] = {}) {
  const runtime = new FakeRuntime({ id: tool });
  const runner = new ScriptedRunner(rules);
  const h = openHarness({
    enginePollMs: 50,
    runtimes: { [tool]: runtime } as Partial<Record<RuntimeId, FakeRuntime>>,
    gpuRunner: runner,
    ...options,
  });
  open.push(h);
  return { h, runtime, runner };
}

const send = (h: Harness, method: string, path: string, body?: unknown) =>
  fetch(`${h.base}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });

const packages = async (h: Harness) => (await (await send(h, "GET", "/api/packages")).json()) as PackagesView;
const localView = async (h: Harness) => (await (await send(h, "GET", "/api/local-engine")).json()) as LocalEngineView;

async function installAndWaitReady(h: Harness): Promise<LocalEngineView> {
  expect((await send(h, "POST", "/api/local-engine/install")).status).toBe(202);
  await eventually(async () => (await localView(h)).state === "ready");
  return localView(h);
}

/** The flags between the other options and the image name. */
function flagsBeforeImage(argv: string[], image: string): string[] {
  return argv.slice(argv.indexOf(image) - 2, argv.indexOf(image));
}

for (const tool of ["docker", "podman"] as const) {
  test(`with all three checks passing, ${tool} gets the GPU image and the start command carries the passthrough flag`, async () => {
    const { h, runtime } = start(tool, gpuRules(tool, { driver: true, passthrough: true }));
    expect((await packages(h)).gpu).toEqual({ state: "used", reason: null, guideUrl: null });
    expect((await packages(h)).offer).toMatchObject({ variant: "linux-amd64-gpu", size: 5_678_958_647 });

    const view = await installAndWaitReady(h);
    expect(runtime.pulls).toEqual([GPU_IMAGE]);
    // Check c ran in the pulled image with the same flag, and the image stayed.
    expect(runtime.oneOffs).toHaveLength(1);
    expect(runtime.oneOffs[0]?.argv).toEqual([
      tool, "run", "--rm", "--pull=never", "--entrypoint", "nvidia-smi", ...GPU_FLAGS[tool], GPU_IMAGE, "-L",
    ]);
    expect(runtime.removedImages).toEqual([]);
    expect(view.installed).toMatchObject({ variant: "linux-amd64-gpu", runtime: tool });
    expect(view.warnings).toEqual([]);

    expect(runtime.starts).toHaveLength(1);
    expect(flagsBeforeImage(runtime.starts[0]?.argv ?? [], GPU_IMAGE)).toEqual([...GPU_FLAGS[tool]]);
  });

  test(`with the driver present but no passthrough, ${tool} gets the CPU image and the toolkit reason with the link`, async () => {
    const { h, runtime } = start(tool, gpuRules(tool, { driver: true, passthrough: false }));
    const reason: ApiError = { code: "gpu.no_passthrough", data: { runtime: tool, guideUrl: NVIDIA_TOOLKIT_GUIDE_URL } };
    expect(await packages(h)).toMatchObject({
      offer: { variant: "linux-amd64-cpu" },
      gpu: { state: "not_used", reason, guideUrl: NVIDIA_TOOLKIT_GUIDE_URL },
    });

    const view = await installAndWaitReady(h);
    expect(runtime.pulls).toEqual([CPU_IMAGE]);
    expect(runtime.oneOffs).toEqual([]);
    expect(view.installed?.variant).toBe("linux-amd64-cpu");
    expect(view.warnings).toEqual([reason]);
    const argv = runtime.starts[0]?.argv ?? [];
    expect(argv).not.toContain("--gpus");
    expect(argv).not.toContain("--device");
  });

  test(`with passthrough but a failing listing inside the image, ${tool} gets the CPU image, the reason, and the GPU image is removed`, async () => {
    const { h, runtime } = start(tool, gpuRules(tool, { driver: true, passthrough: true }));
    runtime.answerOneOffs({ ok: true, value: recorded("nvidia", "smi-l-no-driver") });
    // Offered as the graphics card package: only the test run inside the image can tell otherwise.
    expect((await packages(h)).gpu.state).toBe("used");

    const view = await installAndWaitReady(h);
    expect(runtime.pulls).toEqual([GPU_IMAGE, CPU_IMAGE]);
    expect(runtime.removedImages).toEqual([GPU_IMAGE]);
    expect(runtime.images.has(GPU_IMAGE)).toBe(false);
    expect(runtime.images.has(CPU_IMAGE)).toBe(true);
    expect(view.installed).toMatchObject({ variant: "linux-amd64-cpu", packageVersion: "2.5.0" });
    expect(view.warnings).toEqual([{ code: "gpu.in_image_failed", data: { guideUrl: NVIDIA_TOOLKIT_GUIDE_URL } }]);
    const argv = runtime.starts[0]?.argv ?? [];
    expect(argv).toContain(CPU_IMAGE);
    expect(argv).not.toContain("--gpus");
    expect(argv).not.toContain("--device");
    // The reason stays with the installed package after the page loads again.
    expect((await localView(h)).warnings.map((warning) => warning.code)).toEqual(["gpu.in_image_failed"]);
  });

  test(`Force CPU gives ${tool} the CPU image although all checks pass, and no check runs inside an image`, async () => {
    const { h, runtime } = start(tool, gpuRules(tool, { driver: true, passthrough: true }));
    const answer = await send(h, "PUT", "/api/local-engine/force-cpu", { forceCpu: true });
    expect(answer.status).toBe(200);
    expect(((await answer.json()) as LocalEngineView).forceCpu).toBe(true);
    expect(await packages(h)).toMatchObject({
      offer: { variant: "linux-amd64-cpu" },
      gpu: { state: "not_used", reason: { code: "gpu.forced_cpu", data: {} }, guideUrl: null },
    });

    const view = await installAndWaitReady(h);
    expect(runtime.pulls).toEqual([CPU_IMAGE]);
    expect(runtime.oneOffs).toEqual([]);
    expect(runtime.removedImages).toEqual([]);
    expect(view.installed?.variant).toBe("linux-amd64-cpu");
    // The operator's own choice is not repeated as a warning.
    expect(view.warnings).toEqual([]);
    expect(runtime.starts[0]?.argv).not.toContain("--gpus");
    expect(runtime.starts[0]?.argv).not.toContain("--device");
  });
}

test("on arm64 the GPU checks are skipped and the CPU image is chosen without a GPU message", async () => {
  const { h, runtime, runner } = start("podman", gpuRules("podman", { driver: true, passthrough: true }), {
    localMachine: { platform: "linux", arch: "arm64", totalMemory: 32 * 1024 ** 3, cpuCount: 8 },
    machine: recordedMachine(linuxInputs({ arch: "arm64" })),
  });
  const offered = await packages(h);
  expect(offered.offer?.variant).toBe("linux-arm64-cpu");
  expect(offered.gpu).toEqual({ state: "not_checked", reason: null, guideUrl: null });

  const view = await installAndWaitReady(h);
  expect(view.installed?.variant).toBe("linux-arm64-cpu");
  expect(view.warnings).toEqual([]);
  expect(runtime.oneOffs).toEqual([]);
  expect(runner.calls).toEqual([]);
});

test("a computer with no NVIDIA driver gets the CPU image and no GPU message at all", async () => {
  const { h, runtime, runner } = start("podman", gpuRules("podman", { driver: false, passthrough: false }));
  expect(await packages(h)).toMatchObject({
    offer: { variant: "linux-amd64-cpu" },
    gpu: { state: "not_used", reason: null, guideUrl: null },
  });
  const view = await installAndWaitReady(h);
  expect(view.warnings).toEqual([]);
  expect(runtime.pulls).toEqual([CPU_IMAGE]);
  // The toolkit was never asked about a card that is not there.
  expect(runner.calls.every((call) => call[0] === "nvidia-smi")).toBe(true);
});

test("forcing the processor after the GPU image is installed starts it without the passthrough flag", async () => {
  const { h, runtime } = start("podman", gpuRules("podman", { driver: true, passthrough: true }));
  await installAndWaitReady(h);
  expect(runtime.starts[0]?.argv).toContain("--device");

  await send(h, "PUT", "/api/local-engine/force-cpu", { forceCpu: true });
  expect((await h.localEngine.stop()).ok).toBe(true);
  expect((await h.localEngine.start()).ok).toBe(true);
  expect(runtime.starts[1]?.argv).not.toContain("--device");
  expect(runtime.starts[1]?.argv).toContain(GPU_IMAGE);
});

test("the force CPU setting rejects anything but a yes or a no, and defaults to off", async () => {
  const { h } = start("podman", []);
  expect((await localView(h)).forceCpu).toBe(false);
  expect((await send(h, "PUT", "/api/local-engine/force-cpu", { forceCpu: "yes" })).status).toBe(400);
  expect((await localView(h)).forceCpu).toBe(false);
});
