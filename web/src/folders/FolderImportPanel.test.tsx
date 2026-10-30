import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FolderImportViewContent } from "./FolderImportPanel.tsx";

const view = { available: true, state: "changed" as const, path: "/photos", acceptedCount: 1, skippedCount: 2, groundControlCount: 1, files: [{ name: "a.jpg", size: 12, kind: "photo" as const }], nextOffset: 50 };
test("shows the source state and only offers a path when the server permits it", () => {
  const render = (available: boolean) => renderToStaticMarkup(<FolderImportViewContent view={{ ...view, available }} path="/photos" working={false} offset={0} onPath={() => {}} onSubmit={() => {}} onPage={() => {}} />);
  const local = render(true);
  expect(local).toContain('id="import-path"');
  expect(local).toContain("changed");
  expect(local).toContain("a.jpg");
  expect(local).toContain("Skipped files: 2");
  expect(render(false)).not.toContain('id="import-path"');
  expect(render(false)).not.toContain("/photos");
});
