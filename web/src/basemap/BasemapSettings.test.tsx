import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsPage } from "../pages/SettingsPage.tsx";
import { BasemapForm } from "./BasemapSettings.tsx";

test("basemap settings start empty and label the optional source", () => {
  const html = renderToStaticMarkup(<BasemapForm value={{ enabled: false, url: "", scheme: "xyz", attribution: "" }} working={false} onChange={() => {}} onSubmit={() => {}} />);
  expect(html).toContain('id="basemap-url"');
  expect(html).toContain('for="basemap-url"');
  expect(html).toContain('id="basemap-scheme"');
  expect(html).toContain('id="basemap-attribution"');
  expect(html).not.toContain("https://");
  expect(html).not.toContain('type="password"');
  expect(html).not.toContain("checked=");
});

test("the settings page includes the basemap section", () => {
  const html = renderToStaticMarkup(<SettingsPage onAuthRequired={() => {}} onWizardReopened={() => {}} />);
  expect(html).toContain('id="basemap-title"');
});
