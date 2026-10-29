---
status: accepted
date: 2026-10-29
---

# The interface's controls are hand-written on design tokens, with no UI framework or component library

The second specification brings a form-heavy interface: a project list, uploads, a settings screen with sixty-three controls, a review screen, run lists, viewers and dialogs. The interface today is React, a few hundred lines of hand-written CSS with hard-coded colours, and fourteen components. Every control must work from the keyboard, show its focus, carry a label and meet WCAG 2.2 AA contrast.

We decided to build the controls in the repository. First come design tokens as CSS custom properties: colour pairs checked for contrast, spacing, the type scale and the focus ring. On them sit a small set of shared components, about ten (button, text field, number field, select, toggle, disclosure section, table, dialog, notice, progress), each a styled native HTML control so keyboard use and labels come for free. That ticket lands before any screen of the specification. No UI framework or component library is added for this.

This is a choice for the interface's own controls, not a rule against dependencies. Libraries that render content, such as the map and the 3D viewer of ADR 0010, are wanted, and any dependency is judged by the rule in `AGENTS.md`: a reason in the pull request, few well-maintained libraries, licences compatible with AGPL-3.0, nothing that calls out at run time.

## Considered options

- A component library. Rejected for the controls: every one this specification needs is a native HTML element with styling, and a library brings its own styling language next to the existing CSS and a dependency the whole product then carries.

## Consequences

- `styles.css` is split into tokens and one file per component.
- Accessibility is checked per component once, in its tests, instead of per screen.
