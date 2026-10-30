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

## Test-mode fixture gap

The task API `v2.6.1` test fixture at `tests/processing_results/odm_texturing/odm_textured_model_geo.glb` is the five bytes `glTF\n`, not a GLB 2 file. The existing hosted archive acceptance compares its route bytes but cannot prove that a viewer can open them. The viewer correctly rejects this placeholder.

AIDroneMap/aidm-api#67 tracks replacing the placeholder with a self-contained textured model and testing that the archive preserves it. Until a corrected approved fixture is available, issue #77's test-mode archive rendering criterion remains unverified. Synthetic rendering and a real-sample diagnostic are separate evidence and do not close that gap.

Test depth: full. The viewer's browser tests run from source, and the full diagnostic opens a real engine-produced model after installing the signed package and completing the sample. No job preparation, signing or update behavior changes.
