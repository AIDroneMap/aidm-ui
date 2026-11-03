# The app icon

`aidm-ui.svg` is the icon and the source of truth. It is the maintainer's mark, a dark square holding eight light openings, centred on a light square that fills the whole canvas. macOS masks every app icon into its own rounded shape, so the light square is what gets masked and the dark mark keeps its margin inside it.

The geometry, on a canvas of 360 units:

- the light square: the whole canvas, `#FBF9F3`;
- the dark square: `#23281E`, 234 units wide, 63 units in from every edge;
- the openings: across and down, the dark square is cut into 32 dark, 30 open, 32 dark, 46 open, 32 dark, 30 open and 32 dark units. The openings are the eight open cells around the dark centre: four of 30 by 30 at the corners, two of 46 by 30 above and below the centre, and two of 30 by 46 beside it.

The files made from it:

- `aidm-ui-<size>.png`: the SVG rendered at 16, 32, 64, 128, 256, 512 and 1024 pixels. `scripts/macos-icon.ts` packs them into the Mac app's `AIDM UI.icns`.
- `web/public/apple-touch-icon.png`: the SVG rendered at 180 pixels.
- `web/public/favicon.svg`: a copy of the SVG, for the browser tab.

The PNGs were rendered once with a headless browser. Any SVG renderer will do; none is a dependency of this repository. After a change to the SVG, render every PNG again and copy the SVG to `web/public/favicon.svg`. `web/src/page-icons.test.ts` fails when the two SVGs differ, and `scripts/macos-icon.test.ts` fails when a PNG does not have the size its name says.
