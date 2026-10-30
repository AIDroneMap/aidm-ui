import { expect, test } from "bun:test";
import { mapRequest } from "./map-request.ts";

test("a configured basemap only permits its tile addresses", () => {
  const value = { enabled: true, url: "https://example.test/maps/{z}/{x}/{y}.png", scheme: "xyz" as const, attribution: "Map author" };
  expect(mapRequest("https://example.test/maps/3/2/4.png", "http://127.0.0.1:8080", value, "Tile")).toMatchObject({ url: "https://example.test/maps/3/2/4.png", credentials: "same-origin", referrerPolicy: "no-referrer" });
  expect(() => mapRequest("https://example.test/other/3/2/4.png", "http://127.0.0.1:8080", value, "Tile")).toThrow();
  expect(() => mapRequest("https://example.test/maps/3/2/4.png", "http://127.0.0.1:8080", { ...value, enabled: false }, "Tile")).toThrow();
  expect(() => mapRequest("https://example.test/maps/3/2/4.png", "http://127.0.0.1:8080", value, "Style")).toThrow();
  expect(mapRequest("/api/runs/1/tiles/orthophoto/3/2/4.png", "http://127.0.0.1:8080", null, "Tile").url).toBe("http://127.0.0.1:8080/api/runs/1/tiles/orthophoto/3/2/4.png");
});
