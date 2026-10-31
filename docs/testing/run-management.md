# Run history and repeat processing

Issue #71 adds a paged, newest-first run list with each run's name, engine, preset, state and date. Retry creates another run with the original submitted options. Run again opens those values in the settings editor, selects the original engine where available, and returns through the review. A same-engine repeat uses `POST /task/restart` with the replacement options and no photo upload. A different engine receives a new task.

Each attempt has its own run identity, options, log and archive. Before reusing a completed engine task, the original archive must be saved or explicitly deleted. A reused task belongs to the new attempt. Older runs retain their cached archives, but cannot download a newer attempt's results into their own history. Deleting an older run leaves a newer run's task alone. Deletion is refused while that task is active or a related operation is preparing it.

## Recovery inputs

Migration 13 records each run's original input selection in the private server database. Uploads retain their selected file names, content hashes and server storage references. Imported runs retain the original folder and selected file signatures and hashes. Linked runs retain the checked ZIP address. None of these private records is exposed by the run routes.

A confirmed task-not-found response recreates the task using that saved selection. Changes to the project's later photos, exclusions, folder selection or ZIP address do not replace the original inputs. Upload and imported reads stay bounded and verify the files around copying. Missing or changed originals fail visibly and leave no committed replacement task. Imported files remain unchanged. A linked run can reuse its saved address, but the server cannot guarantee that the remote ZIP still exists or has unchanged contents.

Active runs recover after three consecutive task-not-found responses. Network, authentication and malformed-response failures do not count as missing tasks. A lost restart response leaves the new attempt following the existing task. It must observe a queued or processing state before accepting completion. An immediate finished response cannot establish that the restart happened, so it reports an unconfirmed restart without copying the previous log or archive. A timeout cannot create a duplicate. Older runs created before migration 13 can still restart an existing task. They cannot recreate missing photos that were never recorded for them.

## Queue and deletion

The released API's `GET /info.taskQueueCount` counts running and queued tasks together. It does not report a task's position. The maintainer approved the wording "Waiting. The engine reports N running or waiting runs" for this issue. The displayed value is unchanged from the engine. No local run count or subtraction supplies it.

Deletion asks the owning engine to remove the task before removing the run's archive, log and database rows. A failed engine removal retains the local run for retry. An already missing task counts as removed. Project photos and other runs remain. Runs can be active on different engines at the same time. A project has at most one active preparation or run per engine.

## Verification

- `server/task-api/restart.test.ts` checks the documented restart body, replacement options, image reuse and missing-task versus authentication responses.
- `server/runs/management.test.ts` counts uploads for retry, changed-settings rerun and recreation. It covers different engines, active recovery, original uploads after project changes, imported and linked inputs, server restart, retained archives and logs, engine queue provenance, deletion, authentication failure and a lost restart response.
- `web/src/runs/RunManagement.browser.test.ts` uses the application and production routes in Chromium. It checks the run list, original settings and engine, keyboard edits, retry, the engine's queue total, cross-engine execution, deletion confirmation and keeping a run.
- The hosted native task API test repeats the uploaded-photo run with new settings, confirms reuse of its task, removes that task, checks automatic recreation with the original photos, and deletes the new run. The previous archive remains byte-identical.

Test depth is full because the job preparation and recovery paths change. The exact-head runtime diagnostic and its limits are linked from the pull request. CI remains separate from disposable diagnostics and benchmark evidence.
