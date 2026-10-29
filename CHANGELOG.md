# Changelog

## Unreleased

- Add the 90-argument catalogue, reconcile settings against each engine and validate values before task creation. Evidence: `shared/option-catalogue.test.ts`, the option-route tests in `server/engines/routes.test.ts`, and the pre-creation validation tests in `server/task-api/task-client.test.ts`. The real task API test checks drift in CI with the exact API 2.6.1 compatibility baseline documented in `docs/notes/0061-option-sources.md`. Closes #61.
