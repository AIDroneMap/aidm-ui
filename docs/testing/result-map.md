# Result map

A ready run whose archive holds an orthophoto offers Open the map, in the Results section, as its own address with the whole content area and one toolbar. The map reads only the retained results archive through the local server. It uses bundled map code, styles and a same-origin worker. There is no basemap, glyph service or external tile request. The orthophoto opens first; elevation layers are selectable controls.

`GET /api/runs/:id/map` returns available layers and their validated bounds. A tiles layer also carries its zoom range and tile scheme. Orthophoto, surface and ground layers each need their own georeferenced raster; the elevation layers also need their tiles.

## The orthophoto without tiles

When the archive has no usable orthophoto tiles, the orthophoto is a GeoTIFF layer with the raster's four corners (ADR 0013). The task API turns the cloud-optimised GeoTIFF on for every task, so the file has internal tiles and overviews. The browser reads it with the bundled `geotiff` library through `GET /api/runs/:id/outputs/orthophoto`, which answers byte ranges into the stored archive entry. A whole-file read is refused. The map first draws the whole raster from an overview with a side of at least 1024 pixels. After each move it reads only the part in view, from the coarsest image that is still as sharp as the screen, at most 2048 pixels a side. Both images lie on the raster's corners; over the few kilometres of a flight the corners are a parallelogram to well under a pixel. A deflated archive entry cannot answer ranges, so it gives no GeoTIFF layer.

The map draws 8-bit colour or grey orthophotos compressed with none, LZW, JPEG, deflate or PackBits: every choice the engine offers except LZMA. For LZMA, or for any other kind of image, it reads the header only and says why it cannot draw the orthophoto. The library's other decoders are never started, and it starts no worker. The sample job asks for tiles like every other run, so its orthophoto and surface model come from tiles. Deleting local results makes map metadata unavailable. Opening the map does not contact the engine or extract files.

The GeoTIFF reader supports classic TIFF and BigTIFF in either byte order. It reads pixel scale and tiepoints or an affine transform. Coordinates come from the raster's CRS and transform, never from photo GPS. Supported systems are WGS84 longitude/latitude, Web Mercator and WGS84 UTM. UTM rasters must be axis-aligned and stay on one side of their zone's central meridian and the equator. Unsupported or ambiguous coordinates remain unavailable.

Stored raster metadata uses bounded random reads at archive offsets. Deflated metadata must fit in a 1 MiB prefix, with compressed input also capped at 1 MiB. Neither path allocates or extracts a whole raster. Metadata outside those limits remains unavailable.

The server compares tile paths with raster bounds to select XYZ or TMS numbering. Both occur in existing results: the pinned task API fixture uses TMS, while a real public-sample result uses XYZ. The TileMap XML's bounds do not determine placement. If both schemes could place the files differently within the raster, the layer stays unavailable. Scale and map-center coordinates appear only within the validated result bounds.

## Evidence

- `server/results/georeference.test.ts` checks stored and deflated TIFF, BigTIFF, pixel point semantics, known geographic and projected coordinates, malformed metadata and bounded reads.
- `server/results/map-routes.test.ts` checks absent results, local operation with the engine stopped, XYZ and TMS, layer availability, result bounds and deletion. It also checks that a tile-less orthophoto is a GeoTIFF layer and that its output route answers the range requests a GeoTIFF reader makes, read back through that reader.
- `server/results/map-metadata.test.ts` checks the GeoTIFF layer and its corners, tiles winning over it, and a deflated entry giving none.
- `web/src/map/orthophoto-reader.test.ts` checks the window under a view, the choice of image, the refusal of LZMA and of other images, and range-only reads of synthetic GeoTIFFs from `test-support/geotiff-fixture.ts`.
- `web/src/sections/results/ResultsViewers.browser.test.ts` opens a tile-less orthophoto from Results on the production routes, checks its four coloured quarters drawn in place, zooms in for a sharper read through ranges, and checks that no request leaves the origin with the basemap off.
- `web/src/map/MapView.browser.test.ts` renders the bundled map and worker in Chromium. It captures requests, rejects external origins, activates the map and a layer with the keyboard, pans, zooms both ways, and checks stale replies and reloads.
- `web/src/pages/RunPage.browser.test.ts` covers the existing project-to-run navigation after adding the map entry point.
- `server/packages/real-task-api.test.ts` checks map metadata and independently projected bounds from the pinned test-mode archive through the existing hosted acceptance entry point.

Test depth is unit. This change reads retained result metadata and adds a viewer. It does not change job preparation, installation, signing or updates. Hosted executable builds check the production worker asset mapping.
