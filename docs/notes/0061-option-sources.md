# Catalogue sources and API 2.6.1 compatibility

The catalogue follows the engine's 90 arguments, including positional `name`. Its facts come from [the engine declarations at 68c643965349e7e0bb5e2a0595bcbeca645c70fe](https://github.com/AIDroneMap/aidm/blob/68c643965349e7e0bb5e2a0595bcbeca645c70fe/modules/config.py). Help is kept out of the shared facts. Explanations belong in the translation file under issue #66.

The API converts declarations into a `/options` array with `name`, `type`, `value`, `domain` and `help`. Defaults are strings. Choices use type `enum`. See [the conversion and validation source](https://github.com/AIDroneMap/aidm-api/blob/4cd431575a2186d7733ba20cf882543ec864a7b9/libs/odmInfo.js) and [the endpoint](https://github.com/AIDroneMap/aidm-api/blob/4cd431575a2186d7733ba20cf882543ec864a7b9/index.js#L661).

## Test-mode compatibility baseline

API 2.6.1 test mode reads [its bundled fixture](https://github.com/AIDroneMap/aidm-api/blob/4cd431575a2186d7733ba20cf882543ec864a7b9/tests/odm_options.json), then converts it through the same code as a live engine. It does not ask an installed engine. See [the test-mode branch](https://github.com/AIDroneMap/aidm-api/blob/4cd431575a2186d7733ba20cf882543ec864a7b9/libs/odmRunner.js#L110).

The fixture predates four current options and still contains four retired ones. The drift test permits exactly these differences for API 2.6.1:

| Missing shown options | Unexplained retired options |
| --- | --- |
| `gps-z-offset` | `build-overviews` |
| `matcher-order` | `pc-rectify` |
| `report-units` | `pc-tile` |
| `sfm-no-partial` | `texturing-skip-local-seam-leveling` |

The runtime route hides missing options and shows unexplained options, as it does for every engine. The baseline changes only the drift test. Any further addition or missing shown option fails. A refreshed fixture also fails until this baseline is updated. Other API versions have no exception.

The recorded response in `test-support/fixtures/task-api-2.6.1-options.json` is derived from that pinned fixture and the API's conversion rules. It is independent of the shared catalogue. The fake API serves it for unit tests. The existing real task API CI test asks the reconciliation route and applies the same drift check against the running 2.6.1 test-mode API.

## Validation

Task creation fetches the selected engine's current option list before sending a create request. Values must use their declared scalar types. Validation covers enum membership, numeric ranges and comparisons, positive and negative numbers, percentages, JSON, strings and paths. Unknown names, repeated names and unsupported domain grammar are refused with a message code. An engine refusal after validation keeps the engine's error text, with the token removed.

The catalogue never overrides an engine's type, domain or default. Reconciliation marks each differing field. Hidden bins remain hidden by name, including `end-with` and `rerun-from`.
