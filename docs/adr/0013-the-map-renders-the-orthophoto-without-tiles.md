---
status: accepted
date: 2026-11-02
supersedes-in-part: 0010
---

# The map renders the orthophoto from the archive when the engine made no tiles

ADR 0010 feeds the map from the engine's static tiles and rejected rendering the GeoTIFF in the browser. The map therefore needs the tiles option on every run. The sample job never set it, so a finished sample run with a fifteen megabyte orthophoto reported that no map was available. The corrective brief of 1 November 2026 asks that the map open for any run that produced an orthophoto, whether or not tiles were requested.

The task API turns on the cloud-optimised GeoTIFF for every task, so the orthophoto in every archive has internal tiles and overviews, and the server already serves an output from the archive in place with range requests. We decided that the map reads the orthophoto itself when the archive has no orthophoto tiles: the browser fetches only the internal tiles the current view needs, through the output route, and hands them to the map as a raster source. One runtime dependency does the reading, `geotiff`, under the MIT licence, bundled in the build, making no call of its own. Where the engine made tiles, the map keeps using them, and the elevation models keep coming from their tiles as before. An orthophoto compressed with LZMA, which the reader does not decode, leaves the map showing why. The sample job requests tiles like every other run, so its surface model appears on the map too.

## Considered options

- Only setting the tiles option on the sample job. Rejected: a run from an engine that did not make tiles, or a run where the operator turned tiles off, would still have no map.
- Tiling the GeoTIFF on the server. Rejected: it needs raster decoding and PNG encoding in the server for every compression the engine offers, which is the heavy GIS dependency ADR 0010 refused.

## Consequences

- `geotiff` is the third runtime dependency beyond React, after MapLibre GL and three.js, with the reason recorded here.
- The output route for the orthophoto must keep serving range requests; a test guards it.
- The map view reports two layer kinds, tiles and a cloud-optimised GeoTIFF, and the interface chooses by what the archive holds.
