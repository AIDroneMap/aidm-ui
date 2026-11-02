---
status: accepted
date: 2026-11-02
supersedes-in-part: 0009
---

# Every option the task API offers is shown in the settings editor

ADR 0009 hid some options by name whatever the engine reported: options that need a file, options for more than one machine, options that steer the engine's own process, and options the server sets. The engine declares ninety arguments; the task API exposes eighty of them through its documented option list and discards anything else a client sends. The editor showed sixty-three. An operator who knew the engine could not reach the other seventeen from the interface, and the corrective brief of 1 November 2026 named that gap as the product's core failure.

We decided that the editor shows every option the chosen engine's task API reports, with no list of names hidden on this side. The catalogue still names all ninety engine arguments; the ten the task API does not offer are kept in a bin of their own, listed in the documentation and never in the editor, because no value sent for them would reach the engine. Three options the task API forces on every task, the point cloud in EPT form, the cloud-optimised GeoTIFF and the GLB model, are shown locked with the reason, because an editable control for a value the engine service overrides would be a lie. Options the server set on the operator's behalf until now (the process count, GPU use, map tiles) become editable with the server's value as their default. Options that accept a file or a JSON string are offered as JSON text. Options for splitting work across machines and for steering the engine's process sit in an Expert group that opens collapsed, each with a warning taken from the engine's own rules.

The coverage of the editor is a test: against a recorded option list of the released task API and against the live test-mode API in CI, the number of editor rows equals the number of options reported, and no row is unexplained. A new engine release that adds an option fails that test here before an operator sees it.

## Considered options

- Keeping the hidden bins and documenting them. Rejected: the brief asks for every option, and an operator cannot learn a hidden option exists.
- Showing the three forced options as editable. Rejected: the engine service sets them regardless, so the control would show a choice the operator does not have.

## Consequences

- The seventeen options need their five texts, reviewed by a maintainer entry by entry as ADR 0009 requires.
- The server sets an option only when the operator left it at the default; the review shows the value sent.
- The CI pin of the test-mode task API moves to the release whose option list the check is exact against.
