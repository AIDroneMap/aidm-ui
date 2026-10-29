---
status: accepted
date: 2026-10-29
---

# The viewers show only what the engine produced, and the map has no basemap unless the operator adds one

The engine can write its orthophoto, surface model and ground model as static map tiles in Web Mercator, and the task API asks for a GLB file of the textured model on every run that builds one, and puts both in the archive. The interface must work offline, make no network call the operator did not ask for, and never show a value the engine did not produce. Its map must be open source and need no key or token of any kind.

We decided that the 2D view is a MapLibre GL map fed from the engine's tiles, served by the server out of the archive, and the 3D view is a three.js viewer of the engine's GLB. Every run sets the engine's tile option so the 2D view always has its layers. Coordinates and the scale bar come from the result's own georeferencing. The map has no basemap by default: the orthophoto lies on a plain background. In the settings the operator may add one raster tile source, a URL template with the usual placeholders, XYZ or TMS numbering, and an attribution line they type themselves. No key field exists, no address is suggested or filled in, and the source loads only while a map is open and the setting is on. The point cloud viewer belongs to a later specification.

## Considered options

- A default public tile server. Rejected: it points every installation at a server the project does not run, on every map open, and it is a network call nobody asked for.
- Rendering the GeoTIFF in the browser or tiling it on the server. Rejected: the engine already produces the tiles, and a server-side GIS library would be a heavy dependency that computes what the engine has computed.
- Hand-written viewers. Rejected: a tile map and a GLB viewer are what these libraries are for, and writing them again would be the largest ticket of the specification for no gain.

## Consequences

- MapLibre GL and three.js are the first runtime dependencies beyond React. Each is bundled in the build and makes no call of its own.
- A basemap misconfigured by the operator fails visibly on the map with the configured address shown, and the orthophoto still draws.
