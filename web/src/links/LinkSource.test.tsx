import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LinkSourceContent } from "./LinkSource.tsx";

test("linked archives show checked size and available facts", () => {
  const html = renderToStaticMarkup(<LinkSourceContent view={{ url: "https://example.test/photos.zip", size: 1024, factsRunId: 3, facts: { photoCount: 2, withoutGps: 1, cameras: [{ make: "Camera", model: "One", photoCount: 2 }], dimensions: [{ width: 4000, height: 3000, photoCount: 2 }] } }} url="https://example.test/photos.zip" working={false} onUrl={() => {}} onCheck={() => {}} onRemove={() => {}} />);
  expect(html).toContain("Camera One");
  expect(html).toContain("4000");
  expect(html).toContain("1 KiB");
  expect(html).toContain("Remove link");
});
