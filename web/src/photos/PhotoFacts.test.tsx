import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PhotoFactsView } from "./PhotoFacts.tsx";

test("shows recorded facts and honest partial flight selection", () => {
  const html = renderToStaticMarkup(<PhotoFactsView facts={{ photoCount: 3, photoBytes: 123, duplicates: 1, videoCount: 2, withoutGps: 1, cameras: [{ make: "<Make>", model: "Model", photoCount: 3 }], bands: [{ name: "Red", photoCount: 2 }], dateSpans: [{ clock: "camera", first: "2024-01-01T10:00:00", last: "2024-01-01T11:00:00" }, { clock: "offset", first: "2024-01-01T12:00:00+02:00", last: "2024-01-01T13:00:00+02:00" }], flights: [{ id: "a", make: "<Make>", model: "Model", clock: "camera", first: "2024-01-01T10:00:00", last: "2024-01-01T11:00:00", photoCount: 3, excludedPhotoCount: 1 }], flightCount: 1, unassignedCount: 1, pendingMetadata: 0, nextOffset: null }} offset={0} busy={false} onPage={() => {}} onSelect={() => {}} />);
  for (const text of ["123 B", "&lt;Make&gt;", "Red", "2024-01-01T10:00:00", "2024-01-01T12:00:00+02:00", "1 of 3 photos left out", "Include all", "Leave all out", "Unassigned photos: 1"]) expect(html).toContain(text);
  expect(html).not.toContain("2024-01-01T10:00:00Z");
});
