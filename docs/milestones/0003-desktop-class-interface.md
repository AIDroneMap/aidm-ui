# Milestone 3: a desktop-class interface

Specification [#125](https://github.com/AIDroneMap/aidm-ui/issues/125) is implemented. It came from the maintainer's corrective brief of 1 November 2026 and the approved proposal `docs/proposals/0001-desktop-class-interface.md`. Every ticket has merged. The last one, the Review screen [#166](https://github.com/AIDroneMap/aidm-ui/pull/166), merged on 3 November 2026. Its [CI run on main](https://github.com/AIDroneMap/aidm-ui/actions/runs/41648221173) passed every job.

This milestone replaces the interface of milestone 2 (`docs/milestones/0002-own-flight.md`). The task API contract, the data model, the six presets, the three ways in and the sample project stay as they were. AIDM UI moves to version 0.2.0 with this record.

## What it delivers

- One shell with a left sidebar: Projects, Engines and Preferences, and inside a project its six sections, Photos, Settings, Review, Runs, Results and Details, with their counts. Old addresses lead to the new places. The application page is now Preferences, and "Settings" means the settings of a run.
- A design system with light and dark themes, a field green accent, vendored icons and one set of controls, written down in `docs/design/design-system.md`. Every screen uses it, the wizard included.
- Photos opens on the three ways in. Uploads show a bar with pause and cancel. Below it come thumbnails read from the photos' own previews, camera positions on a map and the capture timeline with a switch per flight.
- Settings shows every option the task API offers, 80 for API 2.7.0, in nine groups. Each row has a plain name, the engine's flag, what it changes, its default and range, and under "More" the engine's own help. The workspace has search, "Changed only" and a comparison against defaults or a preset, and 17 warnings appear as a value is set. Three options the task API forces are locked, with the reason.
- Review is its own screen. It lists what will be processed, on which engine, every changed option and the warnings. The server sets an option only while the operator leaves it at its default.
- Runs is a table, newest first, with retry, run again and delete. The run screen shows stages, the engine's own processing time, results first when finished, and the failing stage with its log lines when failed. The full log stays folded.
- Results opens on the latest run with results. The map opens for any run with an orthophoto, with or without tiles, and the 3D model opens framed from the south. The sample job now asks for tiles.
- Details holds the name, notes and storage, and a danger area. Every deletion asks in one dialog that names what goes, with sizes, and has Keep focused.

## What merged

| Ticket | Pull request | Merged | What |
| --- | --- | --- | --- |
| Proposal | [#124](https://github.com/AIDroneMap/aidm-ui/pull/124) | 2 November | The proposal, ADRs 0012 and 0013, four glossary terms |
| #126 (a), #135 | [#144](https://github.com/AIDroneMap/aidm-ui/pull/144) | 2 November | The real 2.7.0 option list as a fixture, drift keyed by list |
| #126 (b), #136 | [#146](https://github.com/AIDroneMap/aidm-ui/pull/146) | 2 November | CI's test-mode task API pinned to 2.7.0 |
| #126 (c), #137 | [#150](https://github.com/AIDroneMap/aidm-ui/pull/150) | 3 November | The 2.6.1 list retired from fixtures and the stand-in task API |
| #127 | [#145](https://github.com/AIDroneMap/aidm-ui/pull/145) | 2 November | Tokens for both themes, icons and the component set |
| #128 | [#147](https://github.com/AIDroneMap/aidm-ui/pull/147) | 2 November | The sidebar, the route map, Projects and Preferences |
| #129 (a), #138 | [#155](https://github.com/AIDroneMap/aidm-ui/pull/155) | 3 November | Nine groups, affects tags, a row for every task API option |
| #129 (b), #139 | [#157](https://github.com/AIDroneMap/aidm-ui/pull/157) | 3 November | The settings workspace |
| #129 (c), #140 | [#156](https://github.com/AIDroneMap/aidm-ui/pull/156) | 3 November | The 17 warnings at the moment of setting |
| #129 (d), #141 | [#166](https://github.com/AIDroneMap/aidm-ui/pull/166) | 3 November | The Review screen, options set only at their default |
| #130 | [#151](https://github.com/AIDroneMap/aidm-ui/pull/151) | 3 November | Photos: intake, previews, positions and timeline |
| #131 | [#148](https://github.com/AIDroneMap/aidm-ui/pull/148) | 3 November | The run screen |
| #160, from #131 | [#162](https://github.com/AIDroneMap/aidm-ui/pull/162) | 3 November | The shared results component on the run screen |
| #132 | [#149](https://github.com/AIDroneMap/aidm-ui/pull/149) | 3 November | Results, a tile-less orthophoto on the map, a framed 3D model |
| #133 | [#152](https://github.com/AIDroneMap/aidm-ui/pull/152) | 3 November | Details, storage and the sized deletion dialog |
| #134 | [#165](https://github.com/AIDroneMap/aidm-ui/pull/165) | 3 November | Engines, Preferences and the wizard on the design system |
| #142 | [#153](https://github.com/AIDroneMap/aidm-ui/pull/153) | 3 November | The Runs table |
| #154 | [#159](https://github.com/AIDroneMap/aidm-ui/pull/159) | 3 November | The sample project listed before its first run |
| #158 | [#161](https://github.com/AIDroneMap/aidm-ui/pull/161) | 3 November | No speed or memory figures in the interface text |
| #163 | [#164](https://github.com/AIDroneMap/aidm-ui/pull/164) | 3 November | The percentage range allowed by that check |
| #143 | this record's pull request | | This record, the changelog cut and version 0.2.0 |

Issue #129 is the parent of its four parts. They merged, and #129 itself is still open for the maintainer to close.

## How each part was tested

The specification named three seams, highest first. No new seam was added. CI ran all three on every pull request: the job "Typecheck and test" holds the unit tests and the Chromium journeys, and the job "Real task API in test mode through the native package" holds the real task API checks. CI also built the four executables and smoke tested the Linux x64 one.

| Part | Chromium journeys on the production routes | Real task API in test mode | Shared unit tests |
| --- | --- | --- | --- |
| CI pin and option lists (#144, #146, #150) | | The live option check against 2.7.0 | The fixture, the stand-in task API and the exact drift check |
| Design system (#145) | The component page by keyboard in both themes, with contrast | | Contrast of every token pair, component markup, the em dash check |
| Shell (#147) | Sidebar, route map, redirects, the new-project dialog, both themes, the tablet menu | | Routes, redirects, the theme, the unfinished run count |
| Option catalogue (#155) | | | Placement in nine groups, locks, facts, the five texts of every entry, the count against the recorded list |
| Settings workspace (#157) | Search, "Changed only", compare, reset, engine switch, a locked row, Review by keyboard | | The settings view and the engine's help on every row |
| Warnings (#156) | A warning appears under its row and goes, Apply stays enabled | | Each of the 17 rules fires on its combination, none blocks |
| Review (#166) | Review and start on the production routes | Editor rows match the live list; one edited option from each of the nine groups reaches the engine | What a run sends, and when the server sets an option |
| Photos (#151) | Intake, previews, positions and timeline | | Previews read without decoding, paged positions |
| Run screen (#148, #162) | A run from queued to results, a failed run to its lines, the log by keyboard, the viewers and back | | Stages, elapsed time and failure range from log lines, kept across a restart |
| Results and viewers (#149) | Viewers, deletion, live fetch and the map route | The sample asks for tiles | The orthophoto reader, model framing, map layers and ranges |
| Details (#152) | The three deletion dialogs by keyboard, Keep focused | | The multiline field, storage and confirmations |
| Runs (#153, #159) | The table, actions and empty state; the sample's first start in both themes | | The sample project listed and read-only |
| Engines, Preferences, wizard (#165) | The wizard by keyboard in both themes, a refused Mac, the Engines dot through its states | | Refusal sentences, the dot's four states, no raw controls |
| Interface text (#161, #164) | | | No speed or memory figure in any translation, with exact exceptions for setting limits |

Four pull requests were full depth: #146, #149, #165 and #166. For each one, a release dry run from its branch built a Mac package, and the maintainer ran the end-to-end test on a Mac. The records are below.

## What the maintainer observed on a Mac

Each record covers one head and its own package. The packages carry 0.1.0 in their names because the version had not moved yet. The records are quoted as written.

| Pull request | Head | Package from | Record |
| --- | --- | --- | --- |
| #146 | `f1bfd5a` | [dry run 41503654740](https://github.com/AIDroneMap/aidm-ui/actions/runs/41503654740) | [Mac with Apple silicon](https://github.com/AIDroneMap/aidm-ui/pull/146#issuecomment-6588022218): "Engine version observed: [0.2.0]. Manifest sequence observed: [2007000]. Install and sample job completed with success." |
| #149 | `df7208c` | [dry run 41597270470](https://github.com/AIDroneMap/aidm-ui/actions/runs/41597270470) | [MacBook Pro M5 Pro, macOS 27](https://github.com/AIDroneMap/aidm-ui/pull/149#issuecomment-6598481719): engine 0.2.0, sequence 2007000, "Install and a Map with heights run on a 145-photo dataset completed with success; Results, the map and the 3D model were checked." |
| #149 | `3b6855d` | [dry run 41607172006](https://github.com/AIDroneMap/aidm-ui/actions/runs/41607172006) | [Re-check](https://github.com/AIDroneMap/aidm-ui/pull/149#issuecomment-6599554902): "Engine 0.2.0 API 2.7.0 all validated and confirmed". No manifest sequence. |
| #165 | `25406d5` | [dry run 41623780569](https://github.com/AIDroneMap/aidm-ui/actions/runs/41623780569) | [MacBook Pro M5 Pro, OS 27](https://github.com/AIDroneMap/aidm-ui/pull/165#issuecomment-6602848822): "Engine 0.2.0 and API 2.7.0 exposed correctly. Full installation with wizard performed, test run, everything worked as expected." No manifest sequence. |
| #166 | `07b2522` | [dry run 41622179719](https://github.com/AIDroneMap/aidm-ui/actions/runs/41622179719) | [MacBook Pro M5 Pro, OS 27](https://github.com/AIDroneMap/aidm-ui/pull/166#issuecomment-6602610365), with "Processes at once" 4 and "Map tiles" off: "Test successful." [Addition](https://github.com/AIDroneMap/aidm-ui/pull/166#issuecomment-6604015244): engine 0.2.0, task API 2.7.0, sequence 2007000. |

After the first #149 record, its head moved to `3b6855d`, with a fix to the map route's way back and the project's own controls in Results. The re-check covers that head. The #166 head changed after its Mac test by text only, in `280035e`.

The maintainer runs the end-to-end test once more on the package from this record's pull request, which carries the integrated tree as 0.2.0. That record is linked from the pull request.

No speed or memory figure is claimed anywhere in this milestone.

## Release 0.2.0

`package.json` says 0.2.0, and `CHANGELOG.md` moves every entry of this milestone under `## 0.2.0`. A test in `scripts/changelog.test.ts` checks that the version in `package.json` has a dated section right after `## Unreleased` and that every entry in it names its evidence. The release workflow `release-build.yml` is unchanged; its first job checks that a tag matches that version.

The maintainer tags `v0.2.0` on main after this record merges. The tag run builds the executables, packages the Mac app on a disk image, opens it on a Mac, and drafts the release "AIDM UI 0.2.0". The maintainer publishes the draft and tests the published package as a pilot. Nobody else tags, publishes or tests the published package.

The `v0.1.0` tag and its draft release from 1 November 2026 are still there. The maintainer stopped that release on 2 November and decides what happens to them.

## Known limits

| Limit | Owner and follow-up |
| --- | --- |
| The Mac app has an ad-hoc signature. The release environment holds no Developer ID or notarization secrets, so the signed path of `scripts/ci/package-macos.sh` has never run | UI maintainer, the five signing secrets in the release environment |
| Each Mac record covers its own head. The complete journey on the published 0.2.0 package is not yet tested | UI maintainer, the pilot test of the published release |
| Two Mac records name no manifest sequence, and the #146 record names no task API version | UI maintainer, the record of the 0.2.0 end-to-end run |
| The Linux arm64 and Windows executables are built but were not run. Linux x64 has CI's smoke test only | UI maintainer, a pilot on each platform |
| The resolution warning has no measured ground sampling distance, so it fires on a value finer than the engine default and says only that the engine caps it | UI maintainer, a rule from the engine's reported resolution if the task API reports one |
| Numbers in Settings show no units, because the catalogue has no unit field | UI maintainer, a unit field in the catalogue |
| A viewer's "Back to the results" leads to the Results section, also when the viewer was opened from the run screen. The browser's Back returns to the run screen | UI maintainer |
| "Run again" drops `no-gpu` from the settings it starts from. A settings file exported between #155 and #166 can hold `tiles: false` and turns tiles off for its run | UI maintainer |
| Theme colours use `light-dark()`, so browsers older than Chrome or Edge 123, Firefox 120 or Safari 17.5 show default colours | UI maintainer |
| An engine on a second physical computer was not exercised | UI maintainer, a two-computer run and interrupted-network acceptance |
| No real native processing run or local Windows engine was checked | Engine package maintainer, AIDroneMap/aidm#15 |
| GPU processing was not exercised | Engine release maintainer, the engine release GPU test |

The ad-hoc signature limit is resolved in 0.2.1: the release environment holds the Developer ID and notarization secrets, and [run 41714683961](https://github.com/AIDroneMap/aidm-ui/actions/runs/41714683961) from the tag `v0.2.0` signed, notarized and stapled the Mac app, which Gatekeeper accepted.

Milestone 2's limit "Hosted task API coverage pins API 2.6.1" is closed: CI's test-mode task API runs 2.7.0 since #146.

## Acceptance boundary

The implementation tickets are merged. Merging this record accepts the scope above. It does not turn the untested cases into passes. Close #129 and the specification #125 after this record merges. The release follows when the maintainer tags it.
