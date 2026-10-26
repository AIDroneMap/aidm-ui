import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { LocalEngineView } from "../../../shared/api-types.ts";
import en from "../i18n/en.json";
import { fresh } from "../localEngine.fixtures.ts";
import { untranslatedText } from "../test-helpers.ts";
import { LocalInstallStatus } from "./LocalInstall.tsx";

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

const pulling: LocalEngineView = {
  ...fresh,
  state: "installing",
  install: { phase: "pulling", size: 683 * MIB, layersDone: 3, layersTotal: 9, attempt: 2, maxAttempts: 5 },
};

const render = (view: LocalEngineView | null) => renderToStaticMarkup(<LocalInstallStatus view={view} />);

test("during the download the size, the parts and the try are shown with a labelled progress bar", () => {
  const html = render(pulling);
  expect(html).toContain("Downloading the engine: 683 MiB");
  expect(html).toContain("3 of 9 parts");
  expect(html).toContain("Try 2 of 5");
  expect(html).toMatch(/<progress id="install-progress" max="9" value="3">/);
  expect(html).toContain('<label for="install-progress">Downloading the engine: 683 MiB</label>');
  expect(untranslatedText(html)).toEqual([]);
});

test("the first try is not announced as a try", () => {
  const html = render({ ...pulling, install: { ...pulling.install!, attempt: 1 } });
  expect(html).not.toContain("Try 1");
});

test("with unknown parts the progress bar has no value and no parts are claimed", () => {
  const html = render({ ...pulling, install: { ...pulling.install!, layersDone: null, layersTotal: null } });
  expect(html).toContain('<progress id="install-progress"></progress>');
  expect(html).not.toContain("parts");
  expect(html).toContain("Downloading the engine: 683 MiB");
});

test("only the step line sits in the status region, so the counts do not interrupt a screen reader", () => {
  const html = render(pulling);
  const status = /<div role="status">(.*?)<\/div>/.exec(html)?.[1] ?? "";
  expect(status).toContain("Downloading the engine");
  expect(status).not.toContain("of 9 parts");
  expect(status).not.toContain("Try 2");
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
