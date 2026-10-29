# Changelog

## Unreleased

- Add explanations for 63 catalogue options, six presets and 11 groups. Coverage tests check all five option texts, preset departures and orphaned keys in `web/src/i18n/coverage.test.ts`.

- Add file, folder and drop uploads to projects, with worker checksums, chunk resume, duplicate storage, arrived counts, transfer speed, skipped-file details and cancellation. Evidence: route tests in `server/projects/uploads.test.ts`, checksum and queue tests in `web/src/upload/`, and the Chromium panel test covering a cut connection, reload, verified reselection, damaged-chunk retry and keyboard use. Closes #65.

- Keep deleted run IDs reserved so a later run retains all of its engine log. Evidence: the deletion regression in `server/projects/routes.test.ts` and legacy database reopening test in `server/runs/run-store.test.ts`.

- Add the 90-argument catalogue, reconcile settings against each engine and validate values before task creation. Evidence: `shared/option-catalogue.test.ts`, the option-route tests in `server/engines/routes.test.ts`, and the pre-creation validation tests in `server/task-api/task-client.test.ts`. The real task API test checks drift in CI with the exact API 2.6.1 compatibility baseline documented in `docs/notes/0061-option-sources.md`. Closes #61.
- Add project list, names, notes and deletion. Project route and sample-job tests cover task cleanup, retry and keeping imported files. Page tests cover project facts and labels.

- Add shared native controls and design tokens, and use them on existing pages. Component, browser keyboard, contrast and page tests are in `web/src/controls/` and `web/src/pages/`.
