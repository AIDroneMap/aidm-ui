# Result map

A ready run offers Open the map. The map reads only the retained results archive through the local server. It uses bundled map code, styles and a same-origin worker. There is no basemap, glyph service or external tile request. The orthophoto opens first; elevation layers are selectable controls.

`GET /api/runs/:id/map` returns available layers and their validated bounds, zoom range and tile scheme. Orthophoto, surface and ground layers each need both tiles and their own georeferenced raster. Deleting local results makes map metadata unavailable. Opening the map does not contact the engine or extract files.

The GeoTIFF reader supports classic TIFF and BigTIFF in either byte order. It reads pixel scale and tiepoints or an affine transform. Coordinates come from the raster's CRS and transform, never from photo GPS. Supported systems are WGS84 longitude/latitude, Web Mercator and WGS84 UTM. UTM rasters must be axis-aligned and stay on one side of their zone's central meridian and the equator. Unsupported or ambiguous coordinates remain unavailable.

Stored raster metadata uses bounded random reads at archive offsets. Deflated metadata must fit in a 1 MiB prefix, with compressed input also capped at 1 MiB. Neither path allocates or extracts a whole raster. Metadata outside those limits remains unavailable.

The server compares tile paths with raster bounds to select XYZ or TMS numbering. Both occur in existing results: the pinned task API fixture uses TMS, while a real public-sample result uses XYZ. The TileMap XML's bounds do not determine placement. If both schemes could place the files differently within the raster, the layer stays unavailable. Scale and map-center coordinates appear only within the validated result bounds.

## Evidence

- `server/results/georeference.test.ts` checks stored and deflated TIFF, BigTIFF, pixel point semantics, known geographic and projected coordinates, malformed metadata and bounded reads.
- `server/results/map-routes.test.ts` checks absent results, local operation with the engine stopped, XYZ and TMS, layer availability, result bounds and deletion.
- `web/src/map/MapView.browser.test.ts` renders the bundled map and worker in Chromium. It captures requests, rejects external origins, activates the map and a layer with the keyboard, pans, zooms both ways, and checks stale replies and reloads.
- `web/src/pages/RunPage.browser.test.ts` covers the existing project-to-run navigation after adding the map entry point.
- `server/packages/real-task-api.test.ts` checks map metadata and independently projected bounds from the pinned test-mode archive through the existing hosted acceptance entry point.

Test depth is unit. This change reads retained result metadata and adds a viewer. It does not change job preparation, installation, signing or updates. Hosted executable builds check the production worker asset mapping.
