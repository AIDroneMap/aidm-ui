# Changelog

## Unreleased

- Recover upload retries after a full-file checksum failure or a temporary-file cleanup error. Evidence: the checksum reset, cleanup failure and disk-backed server restart tests in `server/projects/uploads.test.ts`.

- Add resumable project upload routes with checksum verification, stored-file deduplication and photo counts. File classification follows engine commit `68c643965349e7e0bb5e2a0595bcbeca645c70fe`. Evidence: `server/projects/uploads.test.ts`, `shared/upload-files.test.ts` and `web/src/i18n/coverage.test.ts`. Browser upload is not yet implemented.

- Keep deleted run IDs reserved so a later run retains all of its engine log. Evidence: the deletion regression in `server/projects/routes.test.ts` and legacy database reopening test in `server/runs/run-store.test.ts`.

- Add the 90-argument catalogue, reconcile settings against each engine and validate values before task creation. Evidence: `shared/option-catalogue.test.ts`, the option-route tests in `server/engines/routes.test.ts`, and the pre-creation validation tests in `server/task-api/task-client.test.ts`. The real task API test checks drift in CI with the exact API 2.6.1 compatibility baseline documented in `docs/notes/0061-option-sources.md`. Closes #61.
- Add project list, names, notes and deletion. Project route and sample-job tests cover task cleanup, retry and keeping imported files. Page tests cover project facts and labels.

- Add shared native controls and design tokens, and use them on existing pages. Component, browser keyboard, contrast and page tests are in `web/src/controls/` and `web/src/pages/`.
