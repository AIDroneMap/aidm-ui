import { expect, test } from "bun:test";
import { previewTile, previewTileUrl } from "./preview.ts";

// The bounds of the sample orthophoto in the real task API test, which spans columns 16020 and 16021 at zoom 16.
const bounds: [number, number, number, number] = [-91.99451323800885, 46.842167553856164, -91.9931045333495, 46.843133788493624];

test("the preview is the lowest zoom tile under the middle of the layer, in the archive's numbering", () => {
  expect(previewTile({ kind: "tiles", name: "orthophoto", bounds, minZoom: 16, maxZoom: 18, scheme: "tms" })).toEqual({ z: 16, x: 16021, y: 42443 });
  expect(previewTile({ kind: "tiles", name: "orthophoto", bounds, minZoom: 16, maxZoom: 18, scheme: "xyz" })).toEqual({ z: 16, x: 16021, y: 2 ** 16 - 1 - 42443 });
  expect(previewTile({ kind: "tiles", name: "orthophoto", bounds, minZoom: 0, maxZoom: 18, scheme: "xyz" })).toEqual({ z: 0, x: 0, y: 0 });
  expect(previewTileUrl(7, { kind: "tiles", name: "orthophoto", bounds, minZoom: 16, maxZoom: 18, scheme: "tms" })).toBe("/api/runs/7/tiles/orthophoto/16/16021/42443.png");
});
