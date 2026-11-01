import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ImportChoice, OptionList } from "./RunStart.tsx";

test("unknown options show their engine name and help", () => {
  const html = renderToStaticMarkup(<OptionList options={[{ name: "new-option", value: 4, defaultValue: 2, help: "Engine help", unexplained: true }]} />);
  expect(html).toContain("new-option");
  expect(html).toContain("Engine help");
  expect(html).toContain("Unexplained");
  expect(html).toContain("4");
});


test("import review offers both choices and tells the operator about an idle restart", () => {
  const html = renderToStaticMarkup(<ImportChoice value={{ selected: "in-place", available: true, restartRequired: true, selectionRequiresCopy: false }} onChange={() => {}} />);
  expect(html).toContain("Let the engine read the photos where they are");
  expect(html).toContain("Copy the photos to the engine");
  expect(html).toContain("restart");
  expect(html).toContain('value="in-place"');
  expect(html).toContain('checked=""');
});

test("an engine without the capability shows only the copy, without a missing-feature hint", () => {
  const html = renderToStaticMarkup(<ImportChoice value={{ selected: "copy", available: false, restartRequired: false, selectionRequiresCopy: false }} onChange={() => {}} />);
  expect(html).toContain("Copy the photos to the engine");
  expect(html).not.toContain("where they are");
  expect(html).not.toContain('type="radio"');
});
