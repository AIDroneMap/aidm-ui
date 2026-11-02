# Proposal: a desktop-class interface for AIDM UI

Status: approved by the maintainer on 2 November 2026, question by question (section 10). No code until the specification issue carries the `ready-for-agent` label.
Date: 1 November 2026, decisions recorded 2 November 2026.
Replaces: the interface Sprint 2 delivered (specification #58, milestone `docs/milestones/0002-own-flight.md`).
Keeps: the aidm-api contract, the data model, the six presets, the three ways in, the sample project. No feature is removed; some move.

The corrective brief of 1 November 2026 found that the first release shows one centred column of forms, buries the photo intake under five sections, hides most engine options behind presets, opens a run on a hundred thousand characters of log, reports no map for a run that produced an orthophoto, and gives Delete the same weight as Save. This proposal answers the brief's deliverable list: screen inventory, navigation map, option grouping with the schema count, design system outline, open questions.

Facts quoted below were read on 1 November 2026 from aidm-ui `main` at 9e5b392, the engine `aidm` at 242d4dd4 (version 0.2.0, `modules/config.py`) and the task API `aidm-api` at tag v2.7.0 (`libs/odmInfo.js`, `libs/Task.js`).

## 1. The standard in one paragraph

AIDM UI is one application with a persistent sidebar, a handful of screens that each do one thing, and one component system built on tokens. A project is a workspace with four sections (Photos, Settings, Runs, Results). Every screen has a defined empty state that says what to do next, and a defined state for each stage of a run. Destructive actions sit apart, in a danger style, behind a confirmation that names what goes and how big it is. A pilot who has never heard the word photogrammetry gets from a folder of photos to a map by following the screen. An advanced operator reaches every option the engine exposes without leaving the Settings section.

## 2. Screen inventory

One line per screen. "Section" means a screen inside the project workspace.

| Screen | Purpose |
| --- | --- |
| Projects | List every project with photo count, runs, latest run state and last change; start a new project. |
| New project (dialog) | Ask for a name, create the project and land on its Photos section. |
| Project: Photos | Bring photos in by drop, folder or ZIP address, then see what arrived as thumbnails, positions on a map, a capture timeline and camera models. |
| Project: Settings | Choose a preset, then see and change every engine option, each explained; save, load, import and export presets; go to Review. |
| Project: Review | Confirm what will be processed, on which engine, with which changed options, and what comes out; name the run; start it. |
| Project: Runs | List the project's runs newest first with state, engine, preset, date and results size; open, retry, run again or delete one. |
| Run | Follow one run stage by stage with elapsed time; when finished, open results and viewers first; when failed, read the failing stage and its log lines. |
| Project: Results | Open the outputs of any finished run: downloads by name with sizes, the map and the 3D model, full width. |
| Map viewer | Pan and zoom the orthophoto, surface model and ground model with scale bar, coordinates and an optional basemap. |
| 3D viewer | Orbit, pan and zoom the textured model, framed to fill the view on open. |
| Project: Details | Rename, write notes, see what the project takes on disk, and delete the project in a separated danger area. |
| Engines | See the local engine and every attached engine with its state and facts; install, update, roll back, start, stop; add or remove a remote engine. |
| Preferences | Change the server port, LAN access and passphrase, container runtime, update check, basemap and data folder. |
| Wizard | First run only: check the machine, install or attach an engine, offer the sample job, in five steps without the sidebar. |
| Login | Enter the LAN passphrase. |

Fifteen screens. The current top-level "Sample job" page goes away as a destination: the sample project is a project like any other, its run lives in its Runs section, and the wizard still offers the sample job. The sample job is not removed, it moves (spec #58, stories 5 and 70).

## 3. Navigation

### Decision: a left sidebar

A persistent sidebar on the left, 15 rem wide, collapsing to icons with labels on hover and focus below 64 rem of viewport width. Not a top bar. Reasons:

- The navigation has two levels (application, then project sections). A top bar holds one level well and the second poorly.
- Laptop screens are wide and short. A sidebar costs width, which the map and the 3D view have to spare at 1280 pixels and above; a top bar costs height, which they do not.
- The project name and its state sit in the sidebar while the operator moves between sections, so the question "which project am I in" never arises.
- Desktop applications pilots already use (file managers, mail, photo tools) put this structure on the left.

### Sidebar contents

```
AIDM UI                      (application name, version on hover)
  Projects
  Engines                    (state dot: ready, busy, unreachable, not installed)
  Preferences
------------------------------------------------------------------
Vineyard north               (current project, only when inside one)
  Photos                     (count badge: 312)
  Settings
  Runs                       (badge while a run is active: spinner)
  Results                    (badge: number of finished runs with results)
  Details                    (smaller, after a gap)
```

Below 64 rem the sidebar collapses to icons. On a tablet in portrait it slides over the content from a menu button. Keyboard: the sidebar is a `nav` with a list of links, `aria-current="page"` on the active one, reachable with Tab, no custom key handling.

### Route map

Hash routing stays (the interface is static files, ADR 0002 and the "static build" rule).

| Address | Screen |
| --- | --- |
| `#/` | Projects |
| `#/projects/:id/photos` | Photos (default when a project opens) |
| `#/projects/:id/settings` | Settings |
| `#/projects/:id/review` | Review |
| `#/projects/:id/runs` | Runs |
| `#/runs/:id` | Run (unchanged address, so saved links keep working) |
| `#/projects/:id/results` | Results, latest finished run |
| `#/projects/:id/results/:runId` | Results of one run |
| `#/projects/:id/results/:runId/map` | Map viewer |
| `#/projects/:id/results/:runId/model` | 3D viewer |
| `#/projects/:id/details` | Details |
| `#/engines` | Engines |
| `#/preferences` | Preferences |
| `#/wizard`, `#/wizard/...` | Wizard, five steps as today |

`#/projects/:id` redirects to `/photos`. `#/settings` redirects to `#/preferences`. `#/sample` redirects to the sample project's Runs section.

### Naming

The application-level page today called Settings becomes Preferences, so that "Settings" means run settings everywhere, as `GLOSSARY.md` already defines the term. This is open question 1.

## 4. Project workspace

### Photos

Photos is the first screen of every project. Three states.

**Empty.** One large drop zone fills the content area. Its title says "Add the photos of your flight". Under it, three ways in sit side by side as cards: "Drop or choose files", "Use a folder on this computer" (only when the browser runs on the server's machine, spec story 15), "Give the address of a ZIP file". One sentence under each says when to use it. Nothing else is on the screen.

**Arriving.** The drop zone shrinks to a bar at the top: arrived count, remaining, speed, a pause and a cancel. The facts below fill in as metadata is read. Skipped files are counted with a "Show names" disclosure (story 19). A ground control file is refused with the message that ground control comes later (story 20).

**Ready.** The bar becomes a one-line summary with an "Add more photos" button. Below, the facts the server already records (`ProjectPhotoFactsView`) become visuals:

- A thumbnail grid, 160 pixels per tile, lazy, paginated by the existing `nextOffset`. Thumbnails come from the EXIF thumbnail embedded in each JPEG, read by the server from the file it already has (uploaded copy or imported folder). A photo without one shows a neutral tile with its name. No image is decoded or resized by the server. See section 8.
- A positions map. The server already stores latitude, longitude and altitude per photo (`project_photo_metadata`). A new read-only route returns them. The map is the same MapLibre canvas as the result map, with no basemap unless the operator set one (ADR 0010), one dot per photo, flights in distinct colours, photos left out hollow. Photos without GPS are counted next to the map.
- A capture timeline. One row per flight: camera make and model, first and last capture time, photo count, a toggle "Include in runs". Gaps over thirty minutes are what separate flights (`GLOSSARY.md`). The row expands to a minute-by-minute strip.
- Camera models, bands and videos as a key-value list. Duplicates as a count with a disclosure of the extra names.

For a project fed by a ZIP address the facts appear after the first run, from the archive, as today (story 27). The empty state of that project says so.

### Settings

See section 6.

### Review

A single screen, reached only from Settings by "Review and start". Two columns on a desktop: the left column lists what will be processed (photo count, flights left out, way in, the in-place or copy choice when it applies), on which engine (its name, state and reported facts), and the run name field with its default of preset and date. The right column lists what comes out, as a list of output names derived from the options (`planPreset`), and every option that differs from the engine's defaults, with plain name, engine flag and value. Warnings from section 6.5 that still apply are repeated here. "Start the run" is the one primary button. "Back to settings" is secondary. A blocked start says why in a notice above the button and nothing else changes.

### Runs

A table, newest first: run name, preset, engine, state pill, started, duration (the engine's processing time, a figure the engine reports), results size. Each row has Open; the overflow menu holds Retry (failed runs), Run again with other settings, Delete run. An active run shows a thin progress bar in its row. Empty state: "No runs yet. Choose your settings and start the first run" with a button to Settings, or a notice that photos are needed first with a button to Photos.

### Results

Results opens on the latest finished run with results, with a run switcher at the top (a select, newest first, only runs with a ready archive). Below the switcher, two large tiles, "Open the map" and "Open the 3D model", each with a preview strip (the lowest zoom tile, or a neutral placeholder when the engine made no tiles) and the output sizes. The viewer tiles are hidden, not disabled, when the run made no orthophoto or no model. Then the downloads: the whole archive with its size, and each output by name with its size (orthophoto, surface model, ground model, point cloud, textured model, GLB, report). At the bottom, apart from the rest, "Delete the results of this run" in the danger style, keeping the run's settings and log (ADR 0008). Empty state: "No results yet" with the state of the latest run and a link to it.

### Details

Name and notes in a form with one Save. Storage as a small table: uploaded photos, imported folder (path, read only), archives per run, total. Then a gap, a rule, and a danger area with a red outline titled "Delete this project". The button opens a confirmation dialog that lists exactly what goes with sizes, from the figures the server already has:

> Delete "Vineyard north"?
> This removes 312 uploaded photos (4.2 GiB), 3 result archives (750 MiB) and the runs on 2 engines.
> The imported folder /Volumes/Flights/vineyard stays as it is.
> [Keep project] [Delete project and 4.9 GiB]

The destructive button is the only red one in the application. The dialog's default focus is on Keep. The same pattern serves "Delete run" and "Delete results", each naming what goes and its size.

## 5. The run screen

One screen for every run, sample job included (story 70). Three bands, top to bottom, with the band that matters for the current state first.

**Header.** Run name, project link, engine, state pill, elapsed time. Elapsed is the engine's own processing time from `/task/:uuid/info`, which it reports in milliseconds; before processing starts, the time since the run was created. Cancel sits here, secondary, while the run is unfinished.

**Stage progress.** A vertical list of the engine's stages in order (`STAGES`, thirteen), each with its plain name from `run.stage.*.name`, a state (waiting, running, done, skipped, failed) and the time at which aidm-ui saw it start. The current stage carries the engine's progress percentage and its one-line description. Stages the engine never announced when the run completes are marked skipped. Nothing here is an estimate: the start times are observations the server already derives from the log lines "Running X stage", and the end state comes from the engine. Split and merge are shown only when the log announces them.

**Results and viewers (finished runs).** When the run completes and the archive is fetched, this band moves above the stage list: the two viewer tiles and the downloads, as in Results. During "fetching results" it shows the fetch progress.

**Failure (failed runs).** A notice names the failing stage in plain words, quotes the engine's message, and shows the last forty log lines before the failure with the first error line highlighted. "Show the whole log" expands the log. Retry and "Run again with other settings" sit under the notice.

**Log.** Collapsed by default behind "Engine log (12,431 lines)". Open, it is a fixed-height scrolling region that follows new lines unless the operator scrolled up, with the restart marker as today, and a "Copy" and a "Save as file" button.

**Uploading and queued.** The upload step shows photos sent against total with a bar, nothing else. Queued shows the engine's running-or-waiting total in its own words (story 60), never a position.

## 6. Options workspace (highest priority)

### 6.1 The schema and the count

The engine declares 90 arguments (`modules/config.py` at 242d4dd4, counting the positional `name` and `--version`). The task API's `/options` endpoint, the only way an option reaches an engine under the aidm-api contract, drops ten of them by name at v2.7.0 (`libs/odmInfo.js`): `project-path`, `name`, `rerun`, `rerun-all`, `version`, `copy-to`, `gcp`, `geo`, `align`, `split-image-groups`. The other names in its exclusion list do not exist in this engine. So an engine 0.2.0 behind API 2.7.0 exposes 80 options, and `filterOptions` discards anything else a client sends.

The schema the UI is checked against is therefore the `/options` list of the chosen engine, and the count to match is 80 for the released pair. The catalogue keeps naming all 90, with the ten unreachable ones in a bin "not offered by the task API", so a maintainer reading the catalogue against the engine source also sees a complete list.

Today the editor shows 63 of the 80. The 17 missing are the ones ADR 0009 hid by name:

| Hidden today | Why it was hidden | Proposed |
| --- | --- | --- |
| `max-concurrency`, `no-gpu` | set by the server | editable in Performance and limits, defaulting to what the server sets today (the engine's core count; GPU as the installed package reports) |
| `tiles` | set by the server so the map has layers | editable in Outputs and formats, default on; the map no longer depends on it (section 7) |
| `pc-ept`, `cog`, `gltf` | set by the server | shown locked in Outputs and formats with the text "Always on. The engine service turns this on for every run", because `Task.js` sets them on every task whatever the client sends (`autoSet`) |
| `cameras`, `boundary` | need a file | editable as JSON text fields in Expert; the engine accepts a JSON string as well as a path (`path_or_json_string`) |
| `use-exif`, `force-gps` | only matter with a ground control file | editable toggles in Photos and cameras, with the warning that they do nothing without ground control, which this version does not take |
| `split`, `split-overlap`, `sm-cluster`, `sm-no-align`, `merge` | distributed processing | editable in Expert, each with the warning from section 6.5 |
| `end-with`, `rerun-from` | steer the engine's own process | editable in Expert, with warnings |

Showing them changes ADR 0009's decision to hide options by name. The ADR is superseded in part (open question 2).

**The check.** A test in `shared/` asserts that every catalogue entry is in exactly one of the nine groups or in the "not offered" bin, has the fields of 6.3, and has its texts in `en.json`. A second test feeds the recorded `/options` response of API 2.7.0 (a new fixture next to the 2.6.1 one) through `reconcileOptions` and asserts that the number of editor rows equals the length of the response, that no row is "unexplained", and that no name is dropped. The real task API job in CI runs the same assertion against the live test-mode API. CI pins API 2.6.1, whose fixture lacks four current options and carries four retired ones (`docs/notes/0061-option-sources.md`); the pin must move to 2.7.0 for the live check to be exact (open question 3, a `.github/` change).

### 6.2 The nine groups with every option placed

Grouped by what the option affects, in the order a run proceeds. Flags are the engine's names. The count per group is in the heading. Options marked (new) are the 17 above. "Defaults" are the engine's at 0.2.0.

**Photos and cameras (16).** What the engine assumes about the camera, its position and the kind of images.
`camera-lens`, `rolling-shutter`, `rolling-shutter-readout`, `use-fixed-camera-params`, `cameras` (new), `gps-accuracy`, `gps-z-offset`, `force-gps` (new), `use-exif` (new), `radiometric-calibration`, `primary-band`, `skip-band-alignment`, `video-limit`, `video-resolution`, `sky-removal`, `bg-removal`.
Multispectral and video options are shown only when the project's photo facts report bands or videos, as today.

**Matching and reconstruction (9).** How photos are matched and camera positions solved.
`min-num-features`, `feature-type`, `feature-quality`, `matcher-type`, `matcher-neighbors`, `matcher-order`, `sfm-algorithm`, `use-hybrid-bundle-adjustment`, `sfm-no-partial`.

**Point cloud (9).** Density, cleaning and ground classification of the point cloud.
`pc-quality`, `pc-filter`, `pc-sample`, `pc-skip-geometric`, `pc-classify`, `smrf-scalar`, `smrf-slope`, `smrf-threshold`, `smrf-window`.
The four `smrf-*` options nest under `pc-classify` and are greyed with the reason when neither it nor `dtm` is on.

**Mesh and texture (7).** The 3D surface and the photo texture on it.
`mesh-size`, `mesh-octree-depth`, `use-3dmesh`, `skip-3dmodel`, `texturing-skip-global-seam-leveling`, `texturing-keep-unseen-faces`, `texturing-single-material`.

**Elevation models (6).** The surface and ground height models.
`dsm`, `dtm`, `dem-resolution`, `dem-gapfill-steps`, `dem-decimation`, `dem-euclidean-map`.
The four `dem-*` options nest under `dsm` and `dtm` and are greyed when both are off.

**Orthophoto (8).** How the map image is made and bounded.
`fast-orthophoto`, `skip-orthophoto`, `orthophoto-resolution`, `crop`, `boundary` (new), `auto-boundary`, `auto-boundary-distance`, `orthophoto-cutline`.
`crop` and `boundary` also bound the elevation models; their "affects" tags say so.

**Outputs and formats (14).** Which files land in the archive and in what format.
`orthophoto-png`, `orthophoto-kmz`, `orthophoto-compression`, `orthophoto-no-tiled`, `cog` (new, locked), `tiles` (new), `pc-las`, `pc-csv`, `pc-copc`, `pc-ept` (new, locked), `gltf` (new, locked), `3d-tiles`, `skip-report`, `report-units`.

**Performance and limits (4).** Processing time, memory and disk.
`max-concurrency` (new), `no-gpu` (new), `optimize-disk-space`, `ignore-gsd`.
The engine's memory line ("about 1 GB per thread and 2 megapixel image resolution") is quoted next to `max-concurrency` with the engine's reported core count and memory; no figure of our own.

**Expert (7).** Steering the engine's process and splitting work across machines.
`end-with`, `rerun-from` (new), `split` (new), `split-overlap` (new), `sm-cluster` (new), `sm-no-align` (new), `merge` (new).
The group opens collapsed with a one-line notice: "These change how the engine runs rather than what it makes. A wrong value here can end a run early or send work to another machine."

16 + 9 + 9 + 7 + 6 + 8 + 14 + 4 + 7 = 80. Every option the API exposes is placed once.

**Not offered by the task API (10).** `project-path`, `name`, `rerun`, `rerun-all`, `version`, `copy-to`, `gcp`, `geo`, `align`, `split-image-groups`. Listed in the catalogue, never in the editor. The three ground control files and the image groups file are the task API's own upload fields, which a later specification on ground control will cover.

The current eleven groups (`group.*` in `en.json`) are replaced by these nine. Preset contents do not change (requirement 8).

### 6.3 What every option row shows

Each row is one card in a group, always expanded enough to act on, with one disclosure for the rest. Visible without opening anything:

- Plain name (`option.<flag>.name`), the engine flag in monospace next to it, a "changed" dot when the value differs from the engine default.
- The control: toggle for booleans, select for choices, number field with unit for numbers, text field for strings and JSON.
- One sentence on what it does (`description`).
- Affects tags: a row of small chips from a fixed set, quality, time, memory, disk, and the outputs it changes (orthophoto, surface model, ground model, point cloud, 3D model, report). Facts, stored in the catalogue data file as a new `affects` field, derived from which stages read the option (the inventory in `docs/notes/0061-option-sources.md` and the engine's help where it names a cost).
- Default and range: "Default 5, from 0.1 to 100, centimetres per pixel" or "Default medium, one of ultra, high, medium, low, lowest".

Behind "More": when a pilot would change it (`when`), what it costs in the engine's words (`cost`), one concrete example (`example`), and the engine's own help text verbatim in a quiet block, labelled as the engine's words. The five texts exist for 63 options today; 17 need writing, following `docs/notes/0066-catalogue-wording-evidence.md`, and the maintainer reviews every new entry (ADR 0009).

Validation stays as today: the shared validator checks type and domain as the operator types and prints the message on the row.

### 6.4 Editor layout and tools

The Settings section is a workspace, not a form.

```
+-------------------------------------------------------------------+
| Preset: [Quick map v]  Engine: [This computer v]  [Review and start]|
| Start from a preset, then change anything. 3 options changed.      |
+------------------+------------------------------------------------+
| Search [       ] | Photos and cameras                        16   |
| [ ] Changed only |  Camera lens        auto  v   camera-lens  o   |
|                  |  Which projection model fits the camera.       |
| Photos & cameras |  [quality] [3D model] [orthophoto]             |
| Matching     (1) |  Default auto, one of auto, perspective, ...   |
| Point cloud      |  > More                                        |
| Mesh and texture |  ...                                           |
| Elevation models |                                                |
| Orthophoto   (2) |  Matching and reconstruction               9   |
| Outputs/formats  |  ...                                           |
| Performance      |                                                |
| Expert           |                                                |
|                  |                                                |
| Presets          |                                                |
|  Save as preset  |                                                |
|  Import file     |                                                |
|  Export file     |                                                |
|  Compare to defaults                                              |
+------------------+------------------------------------------------+
```

- The left rail lists the nine groups with the count of changed options per group; clicking scrolls to the group and the active group highlights while scrolling. The groups render as one long page with sticky group headings, so search filters across all of them at once.
- Search filters on plain name, flag and all five texts, as today, and shows the match count.
- "Changed only" hides every row at its default. It is a toggle, kept in the address so a reload keeps it.
- "Compare to defaults" opens a side panel with a two-column diff: option, engine default, this run's value, each row with a reset. The same panel, fed with a saved preset, is the "Compare to preset" view. The existing changed-list with per-option reset and "Back to the preset" becomes this panel.
- Presets stay at the top as the starting point (requirement 1). Choosing one replaces the draft after a confirmation if the draft has edits. Operator presets, import and export keep their current behaviour (`docs/testing/settings-files.md`), moved into the rail.
- The engine selector sits next to the preset because the option list is the engine's. Switching engines runs reconciliation again and lists what moved, as today.
- "Review and start" is the one primary button. It is disabled with the reason inline while any row has an error.

### 6.5 Warnings at the moment of setting

A warning is a notice under the row, shown the moment the combination appears, repeated on Review. Every one is taken from the engine's own post-parse rules or help text (`modules/config.py` lines 898 to 947, and the stages that read each option). The list to ship with the first version:

| When | Warning |
| --- | --- |
| `fast-orthophoto` on | No 3D model, dense point cloud or textured model will be made; `skip-3dmodel` is forced on. |
| `use-3dmesh` on with `skip-3dmodel` on | The engine will make the 3D model anyway; `skip-3dmodel` is switched off. |
| `dtm` on | The engine turns on `pc-classify`. |
| `orthophoto-cutline` on with `crop` 0 | The engine sets crop to 0.01 metres. |
| `ignore-gsd` on | Quote the engine's own warning about memory and processing time. |
| `pc-quality` or `feature-quality` raised above the default | Quote the engine's line that each step up takes roughly four times as long, and that memory grows. Both raised: say so once, for both. |
| `matcher-type` hamming on a local engine using the CPU | Needs a GPU, as today. |
| `sfm-algorithm` planar | Deprecated; the engine runs incremental instead. |
| `max-concurrency` above the engine's reported cores | More processes than cores; quote the memory line. |
| `skip-orthophoto`, `skip-3dmodel` on and `dsm`, `dtm` off | Nothing to view will be made; only the point cloud and the report. |
| `end-with` before `odm_orthophoto` | The archive will have no orthophoto; before `odm_dem`, no elevation models; and so on, derived from the stage order. |
| `rerun-from` set | Only has an effect on "Run again" of the same task; a new run ignores it. |
| `split` below the photo count | The run is split into submodels; `split-overlap` applies and all photos need GPS. |
| `sm-cluster` set | The engine contacts this address when the run starts and stops if it does not answer. |
| `optimize-disk-space` on | Intermediate files are deleted; a retry from a middle stage is not possible. |
| `dem-resolution` or `orthophoto-resolution` below the ground sampling distance | The engine caps the value at the GSD it measures; the request may not be met. |
| `use-exif` or `force-gps` on | Does nothing without a ground control file, which this version does not take. |

Warnings never block. Errors (a value outside the engine's type or domain) block.

## 7. Viewers

**The map opens for any run with an orthophoto.** Today the map needs the engine's tiles (`orthophoto_tiles/`), which the project run path requests through the server-set `tiles` option, but the sample job sends only `dsm: true` (`server/sample/sample-dataset.ts`), so its 15 MiB orthophoto has no tiles and the map says it is unavailable. The milestone recorded this ("The sample produced no tiles").

Two changes. First, the sample job requests `tiles` like every other run, so the sample's orthophoto and surface model appear on the map. Second, when an archive has an orthophoto and no tiles, the map renders the orthophoto itself. The task API forces `cog` on every task (`Task.js`), so the orthophoto in the archive is always a Cloud Optimized GeoTIFF with internal tiles and overviews, and the server already serves outputs with range requests (`206` in `server/results/routes.test.ts`). A browser-side GeoTIFF reader can fetch exactly the tiles the view needs from the archive in place and hand them to MapLibre as a raster source. This needs one dependency, `geotiff` (MIT), bundled in the build, with no network calls of its own. It decodes the compressions the engine offers except LZMA; an LZMA orthophoto falls back to "tiles needed" with the reason shown. ADR 0010 rejected rendering the GeoTIFF in the browser; this supersedes that part of it. Open question 4.

**The 3D viewer fills its view.** The current camera sits at about 2.3 times the model's extent on a 400 pixel canvas, so the model occupies under half of it. The viewer gets the full content width and height, the camera distance is computed from the bounding sphere and the field of view so the model fills 85 percent of the shorter side, and the first view looks from the south at 35 degrees above the horizon, which is how a pilot imagines a site. "Reset view" returns there. Controls stay as today.

**Both viewers get the whole content area.** They open as their own routes inside Results, with the sidebar collapsed to icons and a single toolbar: back, layers (map) or reset view (model), coordinates and scale (map), basemap toggle when one is configured.

## 8. Design system outline

The design system lands first, as a document in `docs/design/` and as `tokens.css` plus one file per component, and every screen is built from it (ADR 0011 stands: hand-written, no UI framework).

### Tokens

**Colour.** Two themes, light and dark, following `prefers-color-scheme` with an override in Preferences. Every pair is checked for 4.5:1 by the existing contrast test, extended to the dark set. No default browser blue anywhere.

| Token family | Light | Dark | Use |
| --- | --- | --- | --- |
| `--surface-0/1/2` | #FFFFFF, #F5F6F4, #EBEDE8 | #141614, #1C1F1B, #262A26 | page, panels, raised panels |
| `--text-1/2/3` | #1B1F1B, #4A514A, #6B736B | #EDEFEA, #B7BDB4, #8A918A | body, secondary, hint |
| `--border-1/2` | #D4D8D0, #A9AFA5 | #333833, #4A514A | hairlines, control borders |
| `--accent` | #2F6B3A field green | #7FC28B | primary buttons, active nav, links, focus |
| `--accent-soft` | #E3F0E5 | #22402A | selected rows, chips |
| `--ok` | #1E6E3A | #6FC48A | ready, completed |
| `--warn` | #8A5A00 on #FFF3DC | #F0B952 on #3A2E12 | warnings |
| `--danger` | #A3241C on #FBE9E7 | #F0867E on #3D1B19 | destructive actions, failed |
| `--info` | #2F5B8A on #E6EEF7 | #8FB6E6 on #1B2A3A | neutral notices |
| `--running` | #6A4FB3 | #B39DF0 | active run, progress |

Hex values are the proposal's starting point; the contrast test is the judge.

**Type.** System font stack (ships with the OS, nothing downloaded): `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`; monospace for flags and logs: `ui-monospace, "SF Mono", Menlo, Consolas, monospace`. Scale: 12, 13, 14 (body), 16, 20, 24, 32 pixels as rem; line heights 1.4 for body and 1.2 for headings; weights 400, 500, 600 only. Tabular figures for every number.

**Spacing.** A 4 pixel base: 4, 8, 12, 16, 24, 32, 48, 64. Content max width 80 rem for forms, none for viewers and tables. Control height 36 pixels, 32 in dense tables, 44 on touch screens.

**Shape and depth.** Radius 6 for controls, 10 for cards and dialogs, 999 for pills. One shadow for raised panels and dialogs; everything else flat with hairlines.

**Focus.** A 2 pixel accent ring with 2 pixel offset on `:focus-visible`, identical on every component.

**Motion.** 120 ms for state changes, 200 ms for panels, none when `prefers-reduced-motion` is set.

### Components

The ten controls that exist (Button, TextField, NumberField, Select, Toggle, Disclosure, Table, Dialog, Notice, Progress) are restyled on the tokens with `appearance: none` on selects and toggles, custom chevrons and tracks, native semantics kept. Added:

Button variants (primary, secondary, quiet, danger, icon); Checkbox and Radio group; Tabs; Sidebar and NavItem; PageHeader (title, subtitle, actions); Card; StatusPill (one per run state and engine state); Chip (affects tags); EmptyState (icon, one sentence, one action); DropZone; SearchField; SegmentedControl; Popover (click or keyboard, never hover-only, for the "More" texts on narrow screens); ConfirmDialog (danger variant with the size line); StageList; KeyValueList; ThumbnailGrid; Timeline; DiffPanel; Toolbar (viewers); Skeleton (loading rows).

Each component ships with its test for keyboard use, labels and contrast, as ADR 0011 asks, so screens inherit accessibility instead of re-proving it.

### Icons

About thirty icons on a 24 pixel grid, 1.75 stroke, one colour, inline SVG as React components so they follow the text colour and theme. Vendoring a subset of Lucide (ISC licence, compatible with AGPL-3.0) avoids drawing them by hand and adds no runtime dependency. Open question 5.

### States

Every screen defines these states in the design document and in its tests: empty, loading, ready, working (uploading, fetching, saving), running, finished, failed, offline (engine unreachable), and refused (machine not supported, which states the requirement and nothing else).

### Text

Every string stays in `en.json`. New prefixes: `nav`, `photos.visual`, `settings`, `review`, `runs`, `results`, `details`, `danger`, `affects`, `warn`. Plain words; a term of art appears only next to its plain explanation, as "orthophoto (the map image)". No em dashes in text, code or comments; the coverage test already fails on them in `en.json` and is extended to `.ts`, `.tsx`, `.css` and `.md`.

## 9. What has to change under the interface

Small server additions the design needs. None touches the aidm-api contract, the install path or the data model's tables, except where marked.

| Need | Change |
| --- | --- |
| Elapsed and per-stage times | `RunView` gains `processingTime` (the engine's figure) and `stages: [{name, startedAt, state}]`, derived from the log lines the server already parses. |
| Failing stage and log excerpt | `RunView.failure` gains the stage and the line range; the log route already pages. |
| Thumbnails | `GET /api/projects/:id/photos/:sha256/thumbnail` returns the EXIF-embedded thumbnail bytes from the stored or imported file, cached in memory. No decoding. |
| Positions and timeline | `GET /api/projects/:id/photo-positions` returns `{sha256, flightId, latitude, longitude, altitude, captureTime, excluded}` from `project_photo_metadata`, paginated. No schema change. |
| Orthophoto without tiles | `RunMapView` gains a `cog` layer kind with the output's route; the map reads it with range requests. |
| Options | `reconcileOptions` stops skipping hidden bins for the 17 options; the server keeps setting `tiles`, `max-concurrency`, `no-gpu` only when the operator did not. A new `affects` field in the catalogue data file. |
| Sample job | Its options gain `tiles: true`. |
| Sizes in confirmations | Project and run views already carry byte counts; the delete dialogs read them. |

ADR changes: 0009 (hidden bins) superseded in part by a new ADR "every option the task API offers is shown"; 0010 (viewers) superseded in part by "the map renders the orthophoto when there are no tiles"; 0011 stands. `GLOSSARY.md` gains Preferences, Section, Workspace, Danger area.

## 10. Decisions

The maintainer settled every question on 2 November 2026, one per message. Each answer below is the decision; the recommendation it accepted is in the proposal above.

1. **Preferences.** The application page is renamed Preferences; "Settings" means run settings only. `GLOSSARY.md` records the term.
2. **The 17 hidden options.** All 17 appear as in section 6.1. The three the task API forces (`pc-ept`, `cog`, `gltf`) are locked with the reason. ADR 0012 supersedes ADR 0009 in part.
3. **CI pin.** The test-mode task API in CI moves to 2.7.0 in a pull request of its own, before the options workspace; the 2.6.1 exception table goes with it.
4. **Orthophoto without tiles.** The map renders the cloud-optimised GeoTIFF from the archive with the `geotiff` dependency when no tiles exist, and the sample job requests tiles. ADR 0013 supersedes ADR 0010 in part.
5. **Icons.** A vendored subset of Lucide, committed as inline SVG components with its licence file, no runtime dependency.
6. **Accent.** Field green; the contrast test decides the exact values.
7. **Themes.** Light and dark from the tokens ticket onwards. The theme override is kept in the browser, not in the server's settings, because it belongs to the device.
8. **Delete confirmation.** The dialog with sizes and Keep focused by default; no typed name.
9. **Thumbnails.** From the EXIF-embedded image only; a neutral tile where there is none.
10. **Review.** Its own screen at `#/projects/:id/review`.
11. **Order of delivery.** CI pin; tokens, themes, icons and components; navigation shell with Projects and Preferences; options workspace; then Photos, Run screen, Results and viewers, Details and the delete dialogs in parallel; Engines, Preferences and Wizard restyled last.

## 11. Next steps

This document, ADRs 0012 and 0013 and the glossary terms land in one documentation pull request. A specification issue written from this proposal follows; the maintainer approves it with `ready-for-agent`, and it is then split into the tickets of decision 11, one pull request each, as `AGENTS.md` requires. No ticket starts before that label.
