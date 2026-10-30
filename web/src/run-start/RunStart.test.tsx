import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { OptionList } from "./RunStart.tsx";

test("unknown options show their engine name and help", () => {
  const html = renderToStaticMarkup(<OptionList options={[{ name: "new-option", value: 4, defaultValue: 2, help: "Engine help", unexplained: true }]} />);
  expect(html).toContain("new-option");
  expect(html).toContain("Engine help");
  expect(html).toContain("Unexplained");
  expect(html).toContain("4");
});
