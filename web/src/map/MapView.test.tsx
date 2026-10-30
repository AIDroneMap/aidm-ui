import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MapPanel, sameOriginRequest } from "./MapView.tsx";

test("opens the map on demand without geographic data", () => {
  const html = renderToStaticMarkup(<MapPanel runId="7" />);
  expect(html).toContain("Open the map");
  expect(html).not.toContain("Latitude");
  expect(html).not.toContain("maplibregl-canvas");
});

test("only permits same-origin map requests", () => {
  expect(sameOriginRequest("/api/runs/7/tiles/orthophoto/0/0/0.png", "http://example.test").url).toBe("http://example.test/api/runs/7/tiles/orthophoto/0/0/0.png");
  expect(() => sameOriginRequest("https://other.test/tile.png", "http://example.test")).toThrow();
  expect(() => sameOriginRequest("data:image/png;base64,AA", "http://example.test")).toThrow();
});
