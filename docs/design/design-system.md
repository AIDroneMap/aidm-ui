# Design system

Every screen of AIDM UI is built from the tokens and components on this page. ADR 0011 says why they are hand-written with no UI framework. Section 8 of `docs/proposals/0001-desktop-class-interface.md` is the outline this page settles.

Where it lives:

- `web/src/tokens.css` holds the tokens. Nothing else in the interface writes a colour value.
- `web/src/controls/` holds one component per file, each with a stylesheet of the same name. `base.css` gives plain HTML elements their look.
- `web/src/icons/` holds the icons.
- `web/src/controls/gallery/` is the component page. It shows every component in every state, in either theme. Run `bun web/src/controls/gallery/serve.ts` from the repository root and open the address it prints. `HOST` and `PORT` set where it listens; it listens on this machine only unless `HOST` says otherwise.

## Themes

There are two themes, light and dark. The interface follows the system setting. An element with `data-theme="light"` or `data-theme="dark"` fixes the theme for itself and everything inside it, so the Preferences override sets that attribute on the `html` element and keeps the choice in the browser.

Each colour token is written once as `light-dark(light value, dark value)` under `color-scheme`. The browser picks the value. This needs Chrome or Edge 123, Firefox 120 or Safari 17.5. An older browser shows the text in its default colours on a plain page, which stays readable.

## Tokens

### Colour

Every pair the components put on screen meets WCAG 2.2 AA in both themes: 4.5:1 for text, 3:1 for control edges and the focus ring. `web/src/controls/tokens.test.ts` lists the pairs and fails when one falls short or when a colour token sits in no pair.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--surface-0` | #FFFFFF | #141614 | The page, fields, dialogs. |
| `--surface-1` | #F5F6F4 | #1C1F1B | Panels, cards, the sidebar. |
| `--surface-2` | #EBEDE8 | #262A26 | Raised parts inside panels, disabled controls, tracks. |
| `--text-1` | #1B1F1B | #EDEFEA | Body text. |
| `--text-2` | #4A514A | #B7BDB4 | Secondary text, hints, column headings. |
| `--text-3` | #636A63 | #90978F | The quietest text: placeholders, disabled labels. |
| `--border-1` | #D4D8D0 | #333833 | Hairlines between rows. Decorative, no contrast rule. |
| `--border-2` | #80887C | #6F776D | Control edges: fields, checkboxes, switch tracks. |
| `--accent` | #2F6B3A | #7FC28B | Field green. Primary buttons, links, the current item, the focus ring. |
| `--accent-soft` | #E3F0E5 | #22402A | Selected rows, chips, the current sidebar item. |
| `--on-accent` | #FFFFFF | #141614 | Text and marks on the accent. |
| `--ok`, `--ok-soft` | #1E6E3A on #E4F2E8 | #6FC48A on #1A3324 | Ready, finished. |
| `--warn`, `--warn-soft` | #8A5A00 on #FFF3DC | #F0B952 on #3A2E12 | Warnings. |
| `--danger`, `--danger-soft` | #A3241C on #FBE9E7 | #F0867E on #3D1B19 | Failed, destructive. |
| `--on-danger` | #FFFFFF | #141614 | Text on the danger colour. |
| `--info`, `--info-soft` | #2F5B8A on #E6EEF7 | #8FB6E6 on #1B2A3A | Neutral notices. |
| `--running`, `--running-soft` | #6A4FB3 on #EEEAF8 | #B39DF0 on #2A2440 | An active run, progress. |
| `--shadow-color` | #1B1F1B at 16% | black at 60% | The one shadow. |

Two values differ from the proposal's starting point, which the contrast test rejected. `--text-3` was #6B736B, 4.15:1 on `--surface-2`; it is now #636A63, 4.72:1, and dark #90978F, 4.86:1. `--border-2` was #A9AFA5, 1.90:1 on `--surface-2`; a field edge needs 3:1, so it is now #80887C, 3.11:1, and dark #6F776D, 3.15:1.

`--on-danger` and the `-soft` partners of ok and running are additions: a red button needs a text colour, and a state pill needs a background.

The dialog backdrop is black at 45% in both themes. It is the only colour outside the tokens, because a backdrop does not take the page's custom properties in every browser.

### Type

The system's own fonts, so nothing is downloaded: `--font-sans` is `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif` and `--font-mono` is `ui-monospace, "SF Mono", Menlo, Consolas, monospace` for engine flags and logs.

| Token | Size | Use |
| --- | --- | --- |
| `--text-xs` | 12 px | Chips, badges, thumbnail captions. |
| `--text-sm` | 13 px | Hints, column headings, pills. |
| `--text-md` | 14 px | Body text and controls. |
| `--text-lg` | 16 px | Card and section titles. |
| `--text-xl` | 20 px | Second-level headings, dialog titles. |
| `--text-2xl` | 24 px | Screen titles. |
| `--text-3xl` | 32 px | Reserved for a figure that is the point of a screen. |

Line height is 1.4 for text and 1.2 for headings. Weights are 400, 500 for labels and 600 for headings, nothing else. Every number uses tabular figures, so columns of sizes line up.

### Space, size and shape

Spacing steps are 4 pixels apart: `--space-1` to `--space-4` are 4, 8, 12 and 16 pixels, then `--space-6`, `--space-8`, `--space-12` and `--space-16` are 24, 32, 48 and 64. Forms stop at `--content-width`, 80 rem. Viewers and tables take the whole width.

Controls are 36 pixels high (`--control-height`), 32 in dense tables (`--control-height-dense`), and 44 on a touch screen, where both tokens grow.

Controls have a 6 pixel radius, cards and dialogs 10, pills a full round. Raised panels and dialogs have the one shadow, `--shadow-raised`. Everything else is flat, with hairlines.

### Focus and motion

Every control shows the same focus ring when it is reached from the keyboard: 2 pixels of the accent, 2 pixels away from the control. The rule sits in `styles.css`, so no screen can lose it.

State changes take 120 ms and panels 200 ms. With "reduce motion" set on the system, both are 0 and nothing spins, pulses or shimmers.

### Names from before

The screens built before the design system read colours through older names such as `--color-text`. `tokens.css` maps each one onto a token, so those screens follow the theme too. Each later ticket moves its screen to the tokens, and an old name goes when nothing reads it.

## Components

Each component is a styled native element wherever HTML has one, so keyboard use and screen reader names come from the browser. A component that needs keys of its own follows the WAI-ARIA pattern named below. Every string a component shows comes from `en.json`; the ones a component brings itself sit under `ui.`.

| Component | What it is for | States | Keyboard |
| --- | --- | --- | --- |
| Button | An action. Primary is the one main action of a screen; secondary and quiet for the rest. Danger is only for the button that confirms a destructive action. | default, hover, focus, disabled | Enter, Space |
| IconButton | An action shown as an icon. Its label is the tooltip and the name. | as Button | Enter, Space |
| TextField, NumberField | A value to type, with an optional hint and error under it. | empty, filled, invalid, disabled | typing |
| Select | One choice from a list, with a chevron drawn in the text colour. | default, disabled | arrows |
| Toggle | On or off, applied at once. A checkbox announced as a switch. | off, on, disabled | Space |
| Checkbox | A choice kept until it is saved. | unchecked, checked, mixed, disabled | Space |
| RadioGroup | One of a few choices, each with a sentence on when to pick it. | chosen, disabled | arrows |
| SegmentedControl | Two to four short choices side by side, such as the theme. | chosen | arrows |
| SearchField | Search with a clear button and the match count, said to screen readers. | empty, typed, matches | typing, Escape clears |
| Disclosure | Content behind a line that opens it. | closed, open | Enter, Space |
| Table | Rows of data with a caption. Dense for long lists. | default, dense | none |
| Dialog | A modal panel. | open | Escape closes |
| ConfirmDialog | A question with two answers. Keep has the focus when it opens. The danger variant has the red button, labelled with what goes and its size. | plain, danger, busy | Escape keeps, Tab, Enter |
| Notice | A message in a box: info, ok, warn or danger. The icon repeats the tone the words carry. | four tones | none |
| Progress | A bar with a label. Without a value a band moves along it. | value, no value | none |
| Tabs | Views of one thing. | selected | arrows, Home, End (WAI-ARIA tabs) |
| Sidebar, NavSection, NavItem | The navigation: lists of links with icons and badges. Below 64 rem only the icons show, and an item shows its words on hover and focus. An expanded sidebar keeps its words at any width. | current, badge, folded, expanded | Tab |
| PageHeader | The title of a screen, a line under it and its actions. The title takes the focus when the screen opens. | with and without subtitle | none |
| Card | A panel that groups what belongs together. With a title it is a named region. | with and without title | none |
| StatusPill | A state in words with a dot in its colour. `RUN_STATE_TONES` and `ENGINE_STATE_TONES` give the tone of every run and engine state. | neutral, running, ok, warn, danger, info | none |
| Chip | A small tag, such as what an option affects. Text, not a control. | default | none |
| EmptyState | What a screen shows before it has anything: an icon, one sentence, one action. | with and without title | none |
| DropZone | A large area that takes dropped files and hands the screen the dropped items, folders included. Its button opens the file picker for the keyboard. | default, dragging over, disabled | Enter, Space on the button |
| Popover | A panel that opens on click or key, never on hover alone. The browser's popover: Escape or a click outside closes it. | closed, open | Enter, Space, Escape |
| StageList | The stages of a run, each waiting, running, done, skipped or failed, in words. The running one is the current step and carries the engine's percentage. | five stage states | none |
| KeyValueList | Facts as name and value. | default, folded to one column | none |
| ThumbnailGrid | Photos in a grid; a photo with no picture is a plain tile with its name. Pictures load as they scroll into view. | picture, no picture, clickable | Enter on a tile |
| Timeline | Rows on one time axis, such as flights, with a control at the end of each row. A left-out row is hollow. | included, left out, opened | as its controls |
| DiffPanel | What changed against a reference, one row each, with a reset per row. | rows, nothing changed | Enter on Reset |
| Toolbar | One row of controls over a viewer. | default | arrows, Home, End (WAI-ARIA toolbar) |
| Skeleton | Grey rows in place of content on its way. Screen readers hear "Loading". | loading | none |

Plain HTML elements get the same look through `base.css` and the component stylesheets: a raw `button`, `input`, `select`, checkbox, radio button or `progress` on an older screen looks like the component. Those rules sit inside `:where()`, so they weigh nothing and a component's own class always wins.

## Icons

Thirty-nine icons from Lucide 1.66.0, copied from the `lucide-static` release into `web/src/icons/icons.tsx`, one component each. They are drawn on a 24 pixel grid with a 1.75 stroke in the colour of the text around them. Lucide is under the ISC licence, and the icons it took from Feather are under MIT. Both texts are in `web/public/licenses/lucide.txt`, which ships with the interface. Nothing is fetched at run time.

An icon next to words is hidden from screen readers. An icon that stands alone takes a `label`, or sits in an IconButton, which has one.

To add an icon, copy the elements inside its `<svg>` from the same Lucide release into a new export in `icons.tsx`, and add its name to the list on this page. Keep one release for all of them.

The icons: ArrowLeft, Box, Check, ChevronDown, ChevronRight, Circle, CircleCheck, CircleDashed, CircleX, ClipboardCheck, Clock, Copy, Cpu, Download, Ellipsis, Folder, FolderOpen, Image, Images, Info, Layers, Link, LoaderCircle, Lock, Map, Menu, Pause, Play, Plus, RefreshCw, RotateCcw, Save, Search, Settings, SlidersHorizontal, TriangleAlert, Trash2, Upload, X.

## Screens and sections

The shell in `web/src/shell/` puts the sidebar around every screen except the wizard and the login. Inside a project it lists the six sections with their badges: the photo count, a spinner while the latest run is unfinished, and the number of runs with results. Below 64 rem the sidebar keeps its icons. On a window under 64 rem that is much taller than wide, such as a tablet held upright, it hides behind a menu button and slides over the screen with its words; following a link or pressing Escape closes it.

Every address is in `ROUTE_MAP` in `web/src/router.ts`, with the screen it opens, and old addresses are in `redirectFromHash`. The router test and the sidebar journey in `web/src/shell/Shell.browser.test.ts` walk that list.

Each section has a folder of its own, and its words sit under its own prefix in `en.json`, so work on different sections touches different files and different lines:

| Section | Folder | Prefix |
| --- | --- | --- |
| Photos | `web/src/sections/photos/` | `photos.visual` |
| Settings | `web/src/sections/settings/` | `settings` |
| Review | `web/src/sections/review/` | `review` |
| Runs | `web/src/sections/runs/` | `runs` |
| Results | `web/src/sections/results/` | `results` |
| Details | `web/src/sections/details/` | `details` |

`danger`, `affects` and `warn` hold the words of the danger area, the option tags and the option warnings. `nav` holds the sidebar's, `projects` the Projects screen's and `preferences` the Preferences screen's. Each prefix is one block of keys in `en.json`; add a key next to the others of its prefix.

## States

Every screen names these states in its tests and shows each with the components above.

| State | What the operator sees |
| --- | --- |
| empty | EmptyState: what to do first and the action that does it. |
| loading | Skeleton rows where the content will be. |
| ready | The content. |
| working (uploading, fetching, saving) | Progress, and the button that started it waits. |
| running | StatusPill in the running tone, StageList, Progress. |
| finished | StatusPill in the ok tone, the results first. |
| failed | StatusPill in the danger tone, a danger Notice with the engine's own message and what to do. |
| offline (engine unreachable) | A warn Notice that says what does not answer and what to check. |
| refused (machine not supported) | One sentence with the requirement, nothing else. |

## Text

- Every string is in `web/src/i18n/en.json`. A component takes its words from the screen that uses it, and the few it brings itself sit under `ui.`.
- Plain words. A term of art appears only next to its plain meaning, as in "orthophoto (the map image)".
- Labels name things the way a drone operator would, not the way the code does.
- No em dashes, in text, code, styles or documentation. The coverage test fails on one in any `.ts`, `.tsx`, `.css` or `.md` file and in `en.json`.

## Tests

- `web/src/controls/tokens.test.ts`: every colour pair, both themes.
- `web/src/controls/controls.test.tsx`: what each control puts in the page, labels and descriptions included.
- `web/src/controls/components.browser.test.ts`: the component page in headless Chromium, once per theme. It walks the page with Tab and checks that every control is reached once and shows the focus ring. It drives each component by keyboard, reads every name from the browser's accessibility tree, and measures the contrast of every piece of text and every control edge as drawn. It also fails any painted colour that is not a token, and any checkbox, radio button, select or progress bar that keeps the browser's own look. It also checks the folded sidebar at 900 pixels.
- `web/src/controls/literal-text.test.ts`: no component or screen writes text outside `en.json`.
- `web/src/i18n/coverage.test.ts`: the em dash rule.
