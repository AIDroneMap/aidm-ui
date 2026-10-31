import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PresetLibrary } from "./PresetLibrary.tsx";

test("preset tools label their controls and disable saving invalid current values", () => {
  const props = { file: null, selectedId: null, onChoose() {}, onRename() {}, onDelete() {}, onAuthRequired() {} };
  const html = renderToStaticMarkup(<PresetLibrary {...props} />);
  expect(html).toContain('type="file"');
  expect(html).toContain("Import settings");
  expect(html).toContain("Preset name");
  expect(html).toMatch(/disabled=""[^>]*>Save preset/);
  expect(html).toMatch(/disabled=""[^>]*>Export settings/);
});
