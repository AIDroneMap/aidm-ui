import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { UploadPanel } from "./UploadPanel.tsx";

test("upload controls have labels and a folder picker", () => {
  const html = renderToStaticMarkup(<UploadPanel projectId={1} onChange={() => {}} onAuthRequired={() => {}} />);
  expect(html).toContain('for="upload-files"');
  expect(html).toContain('for="upload-folder"');
  expect(html).toContain("webkitdirectory");
});
