import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import pkg from "../../../package.json";
import config from "../../../vite.config.ts";
import { App } from "../App.tsx";
import { untranslatedText } from "../test-helpers.ts";
import { PAGE_VERSION } from "../version.ts";
import { VersionBanner } from "./VersionBanner.tsx";

const build = (version: string, entry: string | null = null) => ({ version, entry });
const render = (page: ReturnType<typeof build>, server: ReturnType<typeof build> | null) =>
  renderToStaticMarkup(<VersionBanner page={page} server={server} onReload={() => {}} />);

test("when the server is another version than the page, the page asks for a reload", () => {
  const html = render(build("0.1.0"), build("0.2.0"));
  expect(html).toContain('role="alert"');
  expect(html).toContain("AIDM UI was updated since this page was opened. Reload the page to use the new version.");
  expect(html).toContain('<button type="button">Reload the page</button>');
  expect(untranslatedText(html)).toEqual([]);
});

test("the same version, or a version the server has not told yet, shows nothing", () => {
  expect(render(build("0.1.0"), build("0.1.0"))).toBe("");
  expect(render(build("0.1.0"), null)).toBe("");
});

test("another build under the same version, told by its entry script, asks for a reload too", () => {
  expect(render(build("0.1.0", "/assets/index-old.js"), build("0.1.0", "/assets/index-new.js"))).toContain("Reload the page");
  expect(render(build("0.1.0", "/assets/index-same.js"), build("0.1.0", "/assets/index-same.js"))).toBe("");
  // Without a built page on one side the entry says nothing.
  expect(render(build("0.1.0", null), build("0.1.0", "/assets/index-new.js"))).toBe("");
});

test("the build puts the version of package.json in the page", () => {
  expect(config.define).toEqual({ __APP_VERSION__: JSON.stringify(pkg.version) });
});

test("in tests, which run without the build, the page has a fixed version", () => {
  expect(PAGE_VERSION).toBe("0.0.0-test");
});

test("the app shows no banner before the server has said its version", () => {
  expect(renderToStaticMarkup(<App />)).not.toContain("version-banner");
});
