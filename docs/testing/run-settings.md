# Run settings

Issue #69 adds an options editor to the project run flow. Edits stay in the active run draft. They are stored with the run when it starts. Saved operator presets and settings files are described in [settings-files.md](settings-files.md).

The editor uses the selected engine's reconciled option types, domains and defaults. Known options use the reviewed catalogue text. New engine options appear in the unexplained group with the engine's help. Hidden options and server-owned output settings remain outside the editor.

The shared value validator is used by both the editor and the server. Invalid numeric text remains visible with a row error and cannot be applied. Dependencies explain why a control is disabled. Missing photo facts remain unknown, including for linked ZIPs before processing. Values already chosen for an inactive dependent remain in the draft because the engine decides when they apply.

Applying settings requests a fresh review from the server. The review revision includes the effective options and the engine schema. Start recomputes the review before creating a task. An invalid value, a hidden setting or a changed revision cannot create a task.

Changing engines first fetches a fresh reconciled schema. Valid edits are retained. Unavailable or invalid edits are removed and listed, along with changes to types, allowed values, defaults and effective values. The browser sends only the edits accepted by the new schema. The hamming warning quotes engine help only when the local engine is known to be using the CPU.

## Source checks

- `shared/option-validation.test.ts`, `shared/run-settings.test.ts` and the existing server validation tests cover shared domain rules, incomplete numeric text, preset baselines, dependencies, unknown facts and engine changes.
- `server/projects/project-runs.test.ts` covers edited review and start, exact settings in the task, revision changes, hidden settings, invalid values, schema changes and local CPU warning conditions.
- `web/src/run-settings/SettingsEditor.test.tsx` and `SettingsEditor.browser.test.ts` cover all 63 option rows, search across the five texts, disclosure controls, resets, validation, dependencies, unknown options, labels, keyboard focus and tablet width.
- `web/src/run-start/RunSettings.browser.test.ts` covers editor-to-review navigation, preserving valid edits when engines change, dropping an incompatible edit, submitting the retained settings and browser requests staying on the interface server.
- Folder and upload browser fixtures retain separate JavaScript and CSS outputs when they include the editor. Their focused build checks reproduced the fixed filename collision.
- The existing hosted real task API test reviews and starts an uploaded-photo run with an edited orthophoto resolution, then verifies completion and archived orthophoto bytes.

## Runtime diagnostic

Test depth is full because edited settings now pass through job preparation. The disposable runtime diagnostic and its limits are recorded on the pull request for the exact pushed commit. CI results remain separate from that diagnostic. No performance or benchmark result is claimed.
