# Project preset and start flow

A project run uses the project's uploaded files or its imported folder. The browser asks the server for a review of the chosen preset and engine. The server reads the engine's current options and facts through the task API. It reconciles those options with the catalogue and validates the values it will submit.

The review revision covers the photo inventory, saved exclusions, preset, engine version, image limit and submitted settings. Start checks them again. An outdated revision is refused before task creation. The operator can reload the review and keep the edited run name.

Photo metadata is read in bounded batches. Start waits until the flight list is complete. A finite image limit blocks counts above the limit; equality is allowed. Missing and invalid limits remain unreported. A reported null means no limit.

The server requests supported EPT, cloud-optimised GeoTIFF, GLB and tile options. These are requested formats. They do not guarantee a file exists: Quick map bypasses dense reconstruction, for example. The conditional output list follows the effective preset and engine defaults. Available downloads come from the completed archive.

For a local engine, the installed package and CPU-only setting determine GPU use. Remote GPU capability remains unreported. Server-owned options and file paths cannot be supplied in the start request.

Preparation holds the project's deletion guard. It checks file size and SHA-256, sends selected content to an uncommitted task, and commits only after copying succeeds. Imported originals stay in place. Preparation detects source or exclusion drift and discards the uncommitted task. A cancellation during task creation waits for its bounded response so cleanup has the task identity. Once committed, the existing tracker follows the task and retains its archive.

## Evidence

- `shared/run-plan.test.ts` checks literal output lists and departures for all six presets, changed engine defaults, missing options and suppression flags.
- `server/projects/project-runs.test.ts` exercises review and start through HTTP, image limits, stale inputs and defaults, unsupported presets and versions, engine changes, duplicate starts, cancellation, deletion coordination, imported exclusions and local GPU settings.
- `server/projects/run-inputs.test.ts` checks content selection, paired masks, duplicate filenames, checksum verification, cancellation and drift at the copy boundary.
- `web/src/run-start/RunStart.browser.test.ts` checks keyboard entry, stale responses, bounded metadata refresh, image-limit blocking, review reload and run navigation.
- The existing `server/packages/real-task-api.test.ts` entry point also runs a project upload, Quick map review and start, completion, retained archive and orthophoto download against the task API in test mode. CI invokes this file without a workflow change.

Test depth is full because this change adds project job preparation. The pull request links checks for its head and a separate disposable-machine functional diagnostic. That diagnostic is not a benchmark.
