# Changelog

## Unreleased

- Wait for result tile requests after a basemap failure. Evidence: the delayed request observation in `web/src/basemap/Basemap.browser.test.ts`. Closes #101.
- Wait for sample results before deleting the project in both restart fixtures. Evidence: delayed archive responses in `server/sample/sample-job.test.ts`. Closes #99.

- Add an optional raster basemap with a saved tile template, XYZ or TMS numbering, and plain-text attribution. It stays off until enabled and reports tile failures while the results remain visible. Evidence: settings and origin-policy tests plus the Chromium basemap fixture in `docs/testing/basemap.md`. Closes #76.

- Wait for both project source panels before checking them. Evidence: delayed panel responses in `web/src/links/ProjectLink.browser.test.ts`. Closes #95.
- Open retained orthophoto and elevation tiles on an offline map, with result coordinates, a scale bar and keyboard controls. Evidence: archive georeferencing and map-route tests, the real Chromium map fixture, and the existing hosted task API acceptance. See `docs/testing/result-map.md`. Closes #75.
- Projects can use a checked ZIP address that the engine fetches when a run starts. Photo details come from the retained results, without copying photos through the interface. Evidence: `docs/testing/linked-photos.md` and its route, archive and browser tests.

- Review a project with one of six presets, check the chosen engine and photo limit, and start a run from uploaded photos or an imported folder. Evidence: preset, input, route and browser tests, plus the existing hosted task API run-flow acceptance. See `docs/testing/project-runs.md`. Closes #68.
- Wait for each run state in the queued-restart lifecycle test. Evidence: the delayed task-info regression in `server/local-engine/lifecycle.test.ts`. Closes #90.
- Wait for the photo-facts document before reading its body. Evidence: the delayed-document regression in `web/src/photos/PhotoFacts.browser.test.ts`. Closes #88.
- Fetch completed runs' archives into local project storage, serve outputs and tiles without disk extraction, show sizes, and delete results while retaining settings and logs. Evidence: results route, ZIP64, downloader and browser tests, plus the existing hosted task API acceptance test. See `docs/testing/results-archive.md`. Closes #64.

- Share the run page and follow logic, show translated engine stages, and retain run metadata. Run store, sample job, stage and page tests cover the change.
- Import a folder from a loopback browser, read photo facts in place and copy chosen files to the engine without changing the originals. Missing or changed sources offer relinking. Evidence: route tests for remote refusal, source snapshots, restarts and version 7 upgrades; copy tests for drift, duplicate names and mask choices; the folder browser fixture; and the imported-folder case in the hosted task API test. Closes #72.

- Show recorded photo facts and detected flights on the project page, with saved choices to leave photos out of a run. Evidence: synthesized metadata tests in `server/photos/metadata.test.ts`, flight boundary tests, project-route tests for duplicate content, persistence and version 6 upgrades, and keyboard and refresh regressions in `web/src/photos/PhotoFacts.browser.test.ts`. Closes #67.

- Add file, folder and drop uploads to projects, with worker checksums, chunk resume, duplicate storage, arrived counts, transfer speed, skipped-file details and cancellation. Evidence: route tests in `server/projects/uploads.test.ts`, checksum and queue tests in `web/src/upload/`, and the Chromium panel test covering a cut connection, reload, verified reselection, damaged-chunk retry and keyboard use. Closes #65.

- Keep deleted run IDs reserved so a later run retains all of its engine log. Evidence: the deletion regression in `server/projects/routes.test.ts` and legacy database reopening test in `server/runs/run-store.test.ts`.

- Add the 90-argument catalogue, reconcile settings against each engine and validate values before task creation. Evidence: `shared/option-catalogue.test.ts`, the option-route tests in `server/engines/routes.test.ts`, and the pre-creation validation tests in `server/task-api/task-client.test.ts`. The real task API test checks drift in CI with the exact API 2.6.1 compatibility baseline documented in `docs/notes/0061-option-sources.md`. Closes #61.
- Add project list, names, notes and deletion. Project route and sample-job tests cover task cleanup, retry and keeping imported files. Page tests cover project facts and labels.

- Add shared native controls and design tokens, and use them on existing pages. Component, browser keyboard, contrast and page tests are in `web/src/controls/` and `web/src/pages/`.
