# Operator presets and settings files

Issue #70 adds named operator presets beside the six built-in presets. The operator can save the current valid settings while choosing a preset, editing values or reviewing a run. Saving stores a full snapshot of editable option values. The editor resets to that saved snapshot. The review continues to show departures from the chosen engine's defaults.

Saved presets live in the server database. Names are trimmed, have at most 200 characters and are unique with case-sensitive comparison. Rename changes the saved name only. Delete removes the saved preset while keeping the active run draft. Past runs retain their own preset label and option list. Migration 12 adds the preset table and a nullable run label without changing old run options, uploads or imported folders. Lists contain at most 50 summaries per page; a preset's option values are read when it is selected.

## File contents

The JSON document contains exactly three fields:

```json
{
  "options": [{ "name": "orthophoto-resolution", "value": 8 }],
  "preset": "Vineyard",
  "engineVersion": "0.1.0"
}
```

Options use the task API's name/value shape and scalar types. Export includes all editable effective values, including values equal to the engine defaults. Server-owned output and process flags stay outside the file and are derived by the server when the run starts. The file contains no project metadata, photos, results, engine address or token. An engine version the engine did not report is represented by `null`.

Files are limited to 1 MiB, with at most 256 distinct option names and bounded strings. Additional fields, duplicate option names, non-scalar values and non-finite numbers are rejected. Export uses the fixed filename `aidm-settings.json`.

## Import and reconciliation

Import fills the active draft. It does not create a saved preset until the operator chooses Save preset. The selected engine's reconciled types and domains decide which values remain valid. Unsupported, hidden or invalid values are shown as dropped with a reason. Version differences are displayed; matching version text is not treated as a compatibility guarantee. Engine changes repeat this reconciliation and show moved values.

The six built-in presets remain read-only. Operator preset names are separate from built-in identifiers. A run stores its named preset label independently of the saved row, and the review revision includes that label along with the effective options and engine schema.

## Source verification

- `shared/settings-file.test.ts` checks the exact three-field document, scalar round trips, malformed files, explicit dropped values and saved reset baselines across engine changes.
- `server/presets/routes.test.ts` checks create, rename, delete, exact values across a server/database reopen, duplicate names, built-in protection and bounded summary pages.
- `server/projects/project-runs.test.ts` checks that a named preset label is bound to its review and retained on the run. Existing run-store migration tests retain their upload, folder and run preservation assertions through migration 12.
- `web/src/run-settings/Presets.browser.test.ts` uses production server routes and a controlled task API. It saves directly from the editor, tests reset and rename, downloads the actual three-field file, restarts the server, restores the saved preset, imports and exports the same file, reports an unsupported option, switches engines, deletes a saved preset, and starts with the exact exported option values.

The hosted real task API test also saves and reads a named preset, starts the uploaded-photo run with its values and label, and checks that deleting the preset leaves the run label intact. This guarded test is verified by its CI job.

Test depth is full because a named preset label now passes through job preparation. The exact-head runtime record is linked from the pull request. Runtime diagnostics and their limits remain separate from CI and benchmark evidence.
