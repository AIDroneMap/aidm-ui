import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelPanel } from "./ModelPanel.tsx";

test("the model starts closed with an open button", () => {
  const html = renderToStaticMarkup(<ModelPanel runId="7" size={512} />);
  expect(html).toContain("Open the 3D model");
  expect(html).not.toContain("<canvas");
});
