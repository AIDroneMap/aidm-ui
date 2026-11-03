# Catalogue sources and the option lists

The catalogue follows the engine's 90 arguments, including positional `name`. Its facts come from [the engine declarations at 68c643965349e7e0bb5e2a0595bcbeca645c70fe](https://github.com/AIDroneMap/aidm/blob/68c643965349e7e0bb5e2a0595bcbeca645c70fe/modules/config.py). Help is kept out of the shared facts. Explanations belong in the translation file under issue #66.

The API converts declarations into a `/options` array with `name`, `type`, `value`, `domain` and `help`. Defaults are strings. Choices use type `enum`. See [the conversion and validation source](https://github.com/AIDroneMap/aidm-api/blob/4cd431575a2186d7733ba20cf882543ec864a7b9/libs/odmInfo.js) and [the endpoint](https://github.com/AIDroneMap/aidm-api/blob/4cd431575a2186d7733ba20cf882543ec864a7b9/index.js#L661).

## The recorded 2.7.0 engine list

The recorded response in `test-support/fixtures/task-api-2.7.0-options.json` is what the `/options` route of a released API 2.7.0 package answers when a real engine runs behind it. It was recorded on 2 November 2026 on a disposable Linux x64 machine, from the released package of [tag v2.7.0](https://github.com/AIDroneMap/aidm-api/releases/tag/v2.7.0) (commit `967a4e70997de6e303565f2d732335163e4ba08e`), CPU container image `ghcr.io/aidronemap/aidm-api@sha256:a16acea2c75ab17204748fe3e28a19df5ec18c0c1f3af875cdc371158876e7e3`, which carries engine 0.2.0. The container was started the way aidm-ui starts it, from its config file on a loopback port, in live mode and not in test mode, so the API asked the engine itself for its options. The answer lists 80 options and passes the drift check with no exception.

This recorded list is the only option list the repository carries. The stand-in task API serves it whatever version a test gives the stand-in.

## The bundled test-mode list

A package started in test mode does not ask an installed engine. It reads [the option fixture bundled in its release](https://github.com/AIDroneMap/aidm-api/blob/4cd431575a2186d7733ba20cf882543ec864a7b9/tests/odm_options.json), then converts it through the same code as a live engine. See [the test-mode branch](https://github.com/AIDroneMap/aidm-api/blob/4cd431575a2186d7733ba20cf882543ec864a7b9/libs/odmRunner.js#L110). The released 2.7.0 package bundles that fixture as Git blob `7b897173fddd91a5165424fcce7c2f00cfb6c69b`. No copy of the bundled list lives in this repository; only its four differences from the recorded list do.

The bundled fixture predates four current options and still contains four retired ones. The drift check permits exactly these differences for that bundled list:

| Missing shown options | Unexplained retired options |
| --- | --- |
| `gps-z-offset` | `build-overviews` |
| `matcher-order` | `pc-rectify` |
| `report-units` | `pc-tile` |
| `sfm-no-partial` | `texturing-skip-local-seam-leveling` |

The runtime route hides missing options and shows unexplained options, as it does for every engine. The baseline changes only the drift check. Any further addition or missing shown option fails. A refreshed bundle also fails until this baseline is updated. A list a real engine reported has no exception of its own: it must match the catalogue exactly.

The drift check keys its exception by the list it ran against, not by API version. `assertCatalogueDrift(options, version, "test-mode")` permits the four differences above for the bundled list at any version. The kind `"engine"` permits nothing.

## The live check in CI

The CI job that runs the real task API through the native package starts the released package pinned to 2.7.0, in test mode. It asks the reconciliation route and applies the drift check with the kind `"test-mode"`. The job therefore proves two things at once, that the pinned package runs and that the exception still matches the list that package bundles.

## Validation

Task creation fetches the selected engine's current option list before sending a create request. Values must use their declared scalar types. Validation covers enum membership, numeric ranges and comparisons, positive and negative numbers, percentages, JSON, strings and paths. Unknown names, repeated names and unsupported domain grammar are refused with a message code. An engine refusal after validation keeps the engine's error text, with the token removed.

The catalogue never overrides an engine's type, domain or default. Reconciliation marks each differing field, except the default of `max-concurrency`, which the engine takes from the machine's processor count. Since ADR 0012 no option the task API offers is hidden by name. The ten engine arguments it does not offer sit in the catalogue's bin "not offered by the task API" and never become rows. The count check in `server/options/reconcile.test.ts` asserts that the recorded 2.7.0 list gives one explained row per option.
