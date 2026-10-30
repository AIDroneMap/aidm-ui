# Result model

A ready run offers Open the 3D model only when its archive contains a GLB. Opening the view loads the bundled three.js viewer and fetches the model from `GET /api/runs/:id/outputs/glb`. It does not contact the engine. Closing the view releases its renderer, textures, geometry and event listeners. A pending model download is cancelled. Draco-compressed geometry uses the decoder files bundled with the viewer. Decoder workers and their Blob URLs are released after pending decode tasks settle, including when the view closes during loading.

Drag with the mouse or one finger to orbit. The mouse wheel zooms; right-drag pans. Two fingers zoom and pan. With the labelled view focused, arrow keys orbit, Shift and arrow keys pan, and plus or minus zoom. Reset view restores the initial framing. The map remains a separate view.

The loader checks the GLB header and chunk lengths before parsing. It rejects external resource addresses and loads embedded textures from local blobs or data addresses. The content security policy permits these local reads, local Blob workers and WebAssembly compilation without allowing another origin. The decoder reads only its two bundled asset addresses. The executable also serves the three.js and Draco licence texts under `/licenses/`. Missing or damaged textures produce a visible error. The browser holds the opened GLB and its decoded resources in memory; this change adds no streaming model format or size limit.

## Evidence

- `web/src/model/ModelPanel.test.tsx` checks that the view starts closed.
- `web/src/model/ModelView.browser.test.ts` uses a synthetic triangle with UVs and an embedded four-colour texture. It checks actual texture pixels under the application's security headers, mouse, touch and keyboard controls, close and reopen, reset, malformed files, damaged textures, external resource rejection and cancellation during a delayed download. A synthetic Draco-compressed version checks offline textured rendering and worker cleanup after closing during decoder loading. Its triangle bytes were encoded with the public `draco3d` 1.5.7 package, without adding it as a project dependency. Requests stay on the server or use local blob and data addresses.
- `web/src/pages/RunPage.browser.test.ts` checks that the button is present for an archived GLB and absent without one, including navigation between runs.
- The existing hosted executable builds check the production lazy import.

The missing component and viewer tests failed before implementation. The texture-pixel assertion then exposed a content security policy failure. A damaged-image case exposed the loader's silent texture fallback. Both now pass with the corresponding fixes. The real sample then exposed missing Draco decoder configuration. The compressed-model regression failed before the decoder was configured and passes with the bundled decoder assets.

## Test-mode archive acceptance

The task API fixture was corrected in merged commit `fbf452f26015027ef7f7593b4232c05a2e24d54f`, through AIDroneMap/aidm-api#68. Issue #67 remains open to record UI acceptance and the first released native package. The published `v2.6.1` package still contains the original five-byte `glTF` placeholder. The corrected source fixture is a self-contained textured GLB.

`server/packages/real-task-api.test.ts` can install a source-built native package through the existing signed test-manifest path. It completes the sample in test mode, retains the archive, compares the GLB output route with the archive member, then opens the actual viewer on that same server. Chromium must render coloured texture pixels, request the single-output route, and make no external browser requests. The fixture uses the application's content security policy and bundled decoder files. It does not replace engine results or relax GLB validation.

Run the existing entry point on a disposable runtime machine with:

```sh
AIDM_REAL_TASK_API_VERSION=2.6.1 \
AIDM_REAL_TASK_API_ARCHIVE_PATH=/tmp/aidm-api-2.6.1-linux-x64.tar.gz \
AIDM_REAL_TASK_API_ARCHIVE_SHA256=<expected-build-sha256> \
AIDM_REAL_TASK_API_MODEL_ACCEPTANCE=1 \
bun test server/packages/real-task-api.test.ts
```

The archive path and digest select an explicitly unreleased build. Its embedded version remains 2.6.1, so the source commit and package digest must accompany the result. The test digest and generated test signature do not assert publisher authenticity. `AIDM_REAL_TASK_API_MODEL_SCREENSHOT` optionally saves the rendered canvas.

The existing hosted task API job continues to check the published 2.6.1 package. Its route-byte comparison cannot prove that the placeholder renders. The opt-in archive acceptance above fails for that package and must pass for the corrected source build. A future released-package pin belongs in a separate workflow change.

Test depth: full. The viewer's browser tests run from source, and the full diagnostic opens a real engine-produced model after installing the signed package and completing the sample. No job preparation, signing or update behavior changes.
