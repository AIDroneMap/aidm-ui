import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { LocalEngineView } from "../../../shared/api-types.ts";
import en from "../i18n/en.json";
import { engineInstall, fresh, macInstall, macPlan, macStoppedPlan } from "../localEngine.fixtures.ts";
import { untranslatedText } from "../test-helpers.ts";
import { LocalInstallStatus } from "./LocalInstall.tsx";

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

const pulling: LocalEngineView = {
  ...fresh,
  state: "installing",
  install: engineInstall({ size: 683 * MIB, stepReceived: 200 * MIB, speed: 3 * MIB, layersDone: 3, layersTotal: 9, retries: 2, lastRetry: { code: "download.connection_interrupted", data: {} } }),
};

const render = (view: LocalEngineView | null) => renderToStaticMarkup(<LocalInstallStatus view={view} />);

test("during the download the size, the bytes, the speed, the parts and why it went on are shown with a labelled progress bar", () => {
  const html = render(pulling);
  expect(html).toContain("Downloading the engine: 683 MiB");
  expect(html).toContain("200 MiB of 683 MiB, 3 MiB per second");
  expect(html).toContain("3 of 9 parts");
  expect(html).toContain("The connection was interrupted. The download continues from where it stopped. Interruptions so far: 2.");
  expect(html).toContain(`<progress id="install-progress" max="${683 * MIB}" value="${200 * MIB}">`);
  expect(html).toContain('<label for="install-progress">Downloading the engine: 683 MiB</label>');
  expect(untranslatedText(html)).toEqual([]);
});

test("a download that never broke says nothing about interruptions, and no speed is claimed before there is one", () => {
  const html = render({ ...pulling, install: { ...pulling.install!, retries: 0, lastRetry: null, speed: null } });
  expect(html).not.toContain("Interruptions");
  expect(html).not.toContain("per second");
  expect(html).toContain("200 MiB of 683 MiB");
});

test("with unknown parts the progress bar has no value and no parts are claimed", () => {
  const html = render({ ...pulling, install: { ...pulling.install!, stepReceived: null, layersDone: null, layersTotal: null } });
  expect(html).toContain('<progress id="install-progress"></progress>');
  expect(html).not.toContain("parts");
  expect(html).toContain("Downloading the engine: 683 MiB");
});

test("only the step line sits in the status region, so the counts do not interrupt a screen reader", () => {
  const html = render(pulling);
  // A download has one status line, the first of its block; the counts below it are silent.
  expect(html.match(/role="status"/g)).toHaveLength(1);
  const status = /<p role="status">(.*?)<\/p>/.exec(html)?.[1] ?? "";
  expect(status).toContain("Downloading the engine");
  expect(status).not.toContain("of 9 parts");
  expect(status).not.toContain("Interruptions");
});

test("then the engine starts, then it is ready", () => {
  const starting = render({ ...pulling, state: "starting", install: { ...pulling.install!, phase: "starting" } });
  expect(starting).toContain("Starting the engine");
  expect(starting).not.toContain("<progress");
  const installed = { packageVersion: "2.5.0", variant: "linux-amd64-cpu", kind: "container", runtime: "podman" } as const;
  const ready = render({ ...pulling, state: "ready", installed, install: { ...pulling.install!, phase: "done" } });
  expect(ready).toContain("The engine is ready");
  expect(ready).not.toContain("<progress");
});

test("a failed install says why, in words", () => {
  const html = render({
    ...fresh,
    state: "failed",
    install: { ...pulling.install!, phase: "failed" },
    problem: { code: "install.not_enough_space", data: { needed: 8 * GIB, free: 2.5 * GIB } },
  });
  expect(html).toContain("The engine needs 8.0 GiB and this computer has 2.5 GiB free.");
  expect(untranslatedText(html)).toEqual([]);
  const generic = render({ ...fresh, state: "failed", install: { ...pulling.install!, phase: "failed" } });
  expect(generic).toContain(en["local.install.failed"]);
});

test("a warning from the server shows next to the progress", () => {
  const html = render({
    ...pulling,
    warnings: [{ code: "local.memory_cap_not_enforced", data: {} }],
  });
  expect(html).toContain('class="warning"');
  expect(html).toContain(en["local.memory_cap_not_enforced"]);
});

test("the warning that the test run could not use the graphics card carries a plain link to the guide", () => {
  const guideUrl = "https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html";
  const html = render({ ...pulling, warnings: [{ code: "gpu.in_image_failed", data: { guideUrl } }] });
  expect(html).toContain(en["gpu.in_image_failed"]);
  expect(html).toContain(`<a href="${guideUrl}" target="_blank" rel="noreferrer noopener">`);
  expect(untranslatedText(html, ["2.5.0"])).toEqual([]);
});

const gpuPulling: LocalEngineView = {
  ...pulling,
  install: engineInstall({ variant: "linux-amd64-gpu", size: 5_678_958_647 }),
};

test("the download of the graphics card package says so, with its size", () => {
  const html = render(gpuPulling);
  expect(html).toContain("Downloading the graphics card package: 5.3 GiB");
  expect(html).not.toContain("Downloading the engine");
  expect(untranslatedText(html)).toEqual([]);
});

test("the test run inside the package has its own line in the status region, without a progress bar", () => {
  const html = render({ ...gpuPulling, install: { ...gpuPulling.install!, phase: "checking_gpu" } });
  expect(html).toContain(en["local.install.checking_gpu"]);
  expect(/<div role="status">(.*?)<\/div>/.exec(html)?.[1]).toContain(en["local.install.checking_gpu"]);
  expect(html).not.toContain("<progress");
  expect(untranslatedText(html)).toEqual([]);
});

// The Mac path: Apple's container tool is set up before the engine.

const mac = (step: Parameters<typeof macInstall>[0], overrides: Partial<LocalEngineView> & { install?: LocalEngineView["install"] } = {}): LocalEngineView => ({
  ...fresh,
  state: "installing",
  install: macInstall(step),
  ...overrides,
});

test("before the click a Mac lists every step in order with its size, all waiting", () => {
  const html = render({ ...fresh, plan: macPlan });
  const items = [...html.matchAll(/<li[^>]*><span>(.*?)<\/span><span class="install-step-state">(.*?)<\/span><\/li>/g)].map(
    (match) => [match[1], match[2]],
  );
  expect(items).toEqual([
    ["Apple&#x27;s container tool, 149 MiB", "Waiting"],
    ["Your approval: macOS asks for your password once", "Waiting"],
    ["Starting Apple&#x27;s container tool", "Waiting"],
    ["Linux system for Apple&#x27;s container tool, 664 MiB, downloaded once", "Waiting"],
    ["Startup files, 66 MiB", "Waiting"],
    ["AIDM engine, 594 MiB", "Waiting"],
  ]);
  expect(html).toContain('aria-label="Steps of the install"');
  expect(html).not.toContain("<progress");
  expect(untranslatedText(html)).toEqual([]);
});

test("when the package is being deleted the line gives its size", () => {
  const html = render({ ...gpuPulling, install: { ...gpuPulling.install!, phase: "removing_gpu_package" } });
  expect(html).toContain("The test run failed. Deleting the graphics card package (5.3 GiB) and downloading the processor package instead.");
  expect(html).not.toContain("<progress");
  expect(untranslatedText(html)).toEqual([]);
});

test("a graphics card package that could not be deleted is a warning with the space it takes", () => {
  const html = render({
    ...pulling,
    warnings: [{ code: "gpu.package_not_removed", data: { size: 5_678_958_647 } }],
  });
  expect(html).toContain('class="warning"');
  expect(html).toContain("takes 5.3 GiB");
  expect(untranslatedText(html)).toEqual([]);
});

test("a Linux computer, with the engine alone, shows no list of steps", () => {
  expect(render({ ...fresh, plan: null })).not.toContain("install-steps");
  expect(render(pulling)).not.toContain("install-steps");
});

test("while the installer downloads, its step is the current one, with a progress bar in bytes, and the rest wait", () => {
  const html = render(mac("installer", { install: macInstall("installer", { stepReceived: 50_000_000 }) }));
  expect(html).toContain('<li aria-current="step" class="install-step-current"><span>Apple&#x27;s container tool, 149 MiB</span><span class="install-step-state">Under way</span>');
  expect(html).toMatch(/<progress id="install-progress" max="155965213" value="50000000">/);
  expect(html).toContain("Downloading Apple&#x27;s container tool: 149 MiB");
  expect(html.match(/Waiting<\/span>/g)).toHaveLength(5);
  expect(untranslatedText(html)).toEqual([]);
});

test("the approval step asks for the password in words and has no progress bar", () => {
  const html = render(mac("approve"));
  expect(html).toContain("Waiting for your approval. macOS asks for your administrator password once.");
  expect(html).not.toContain("<progress");
  expect(html.match(/Done<\/span>/g)).toHaveLength(1);
});

test("the service step says that Apple's container tool is starting, with no size and no progress bar", () => {
  const html = render(mac("service"));
  const status = /<div role="status">(.*?)<\/div>/.exec(html)?.[1] ?? "";
  expect(status).toContain("Starting Apple&#x27;s container tool");
  expect(html).toContain('<li aria-current="step" class="install-step-current"><span>Starting Apple&#x27;s container tool</span>');
  expect(html).not.toContain("<progress");
  expect(html.match(/Done<\/span>/g)).toHaveLength(2);
  expect(untranslatedText(html)).toEqual([]);
});

test("the kernel step says its size and that it continues from where it stopped, with a bar that has no value before the first byte", () => {
  const html = render(mac("kernel"));
  expect(html).toContain("Downloading the Linux system for Apple&#x27;s container tool: 664 MiB. If it stops, it continues from where it stopped.");
  expect(html).not.toContain("starts again from the beginning");
  expect(html).toContain('<progress id="install-progress"></progress>');
  expect(html.match(/Done<\/span>/g)).toHaveLength(3);
  expect(untranslatedText(html)).toEqual([]);
});

test("when the tool was there already, the kernel step says its size is not known and makes none up", () => {
  const plan = render({ ...fresh, plan: macStoppedPlan });
  expect(plan).toContain("<span>Linux system for Apple&#x27;s container tool, size not known, downloaded once</span>");
  expect(plan).not.toContain("664 MiB");
  expect(plan).not.toContain("0 B");

  const html = render(mac("kernel", { install: macInstall("kernel", { steps: macStoppedPlan }) }));
  expect(html).toContain("Downloading the Linux system for Apple&#x27;s container tool. If it stops, it starts again from the beginning.");
  expect(html).not.toContain("0 B");
  expect(html).not.toContain("664 MiB");
  expect(html).toContain('<progress id="install-progress"></progress>');
  expect(untranslatedText(html)).toEqual([]);
});

test("the startup files step says the size aidm-ui downloads", () => {
  const html = render(mac("init"));
  const status = /<p role="status">(.*?)<\/p>/.exec(html)?.[1] ?? "";
  expect(status).toContain("Downloading the startup files: 66 MiB");
  expect(html).toContain("<span>Startup files, 66 MiB</span>");
  expect(html).not.toContain("Getting the startup files");
  expect(html).not.toContain("size not known</span>");
  expect(html.match(/Done<\/span>/g)).toHaveLength(4);
  expect(untranslatedText(html)).toEqual([]);
});

test("the engine step is the engine's own download, with the Mac steps behind it", () => {
  const html = render(mac("engine", { install: macInstall("engine", { layersDone: 3, layersTotal: 9 }) }));
  expect(html).toContain("Downloading the engine: 594 MiB");
  expect(html).toContain("3 of 9 parts");
  expect(html.match(/Done<\/span>/g)).toHaveLength(5);
});

test("a step that failed is marked Failed with the reason in words, and nothing after it is shown as under way", () => {
  const html = render(
    mac("approve", {
      state: "failed",
      install: macInstall("approve", { phase: "failed" }),
      problem: { code: "mac.install_not_finished", data: { reason: "timeout" } },
    }),
  );
  expect(html).toContain('class="install-step-failed"');
  expect(html).toContain("Failed</span>");
  expect(html).not.toContain('aria-current="step"');
  expect(html).toContain("Apple&#x27;s container tool was not installed.");
  expect(untranslatedText(html)).toEqual([]);
});

// After the second Mac test.

test("the startup files show their bytes and speed in the same words as the engine", () => {
  const html = render(mac("init", { install: macInstall("init", { stepReceived: 20 * 1024 * 1024, speed: 1024 * 1024 }) }));
  expect(html).toContain("20 MiB of 66 MiB, 1 MiB per second");
  const engine = render({ ...fresh, state: "installing", install: engineInstall({ size: 683 * 1024 * 1024, stepReceived: 20 * 1024 * 1024, speed: 1024 * 1024 }) });
  expect(engine).toContain("20 MiB of 683 MiB, 1 MiB per second");
});

test("a failed step says which step stopped, and its message is only its own", () => {
  const html = render(
    mac("init", {
      state: "failed",
      install: macInstall("init", { phase: "failed" }),
      problem: { code: "mac.init_load_failed", data: { exitCode: 1 } },
    }),
  );
  expect(html).toContain("Apple&#x27;s container tool could not load its startup files (exit code 1).");
  expect(html).toContain("The step that stopped: Startup files.");
  expect(html).not.toContain("engine, but it does not hold");
  expect(untranslatedText(html)).toEqual([]);
});
