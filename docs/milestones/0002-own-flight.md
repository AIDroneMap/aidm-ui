# Milestone 2: an operator's project, from photos to results

Specification [#58](https://github.com/AIDroneMap/aidm-ui/issues/58) is implemented. Projects, all three ways to bring photos in, settings, retained runs, downloads and offline viewers have merged. The final import change [#110](https://github.com/AIDroneMap/aidm-ui/pull/110) merged on 1 November 2026, after the publisher-key change [#116](https://github.com/AIDroneMap/aidm-ui/pull/116).

This record uses public sample photos. It distinguishes the released-package checks from earlier source-candidate checks. An operator's private flight and an engine on a second physical computer were not exercised. The known limits below name their owners.

## What it delivers

- Projects keep a name, notes, photo facts and run history. Uploads resume after interruptions. Imports keep the originals in their folder. A checked ZIP address lets the engine fetch photos itself.
- Photo facts group flights and record camera, dimensions, dates, bands and GPS presence. Exclusions affect the reviewed selection.
- Presets name the result the operator wants. The settings editor gives each option's engine name, value, explanation and constraints. Settings can be saved, loaded and reused as named presets.
- Review names the selected photos, engine, changed settings and requested outputs. Waiting text reports the engine's running-or-waiting total. It does not claim a position in the queue.
- Runs retain their settings, log and archive. Retry and run again preserve earlier archives. Deleting a run removes its results and engine task while leaving imported originals in place.
- The map reads the engine's tiles from the archive. The textured model opens on demand. Both viewers ship with the interface. A basemap stays off until the operator adds one.
- Same-machine imports use the API's in-place capability for an exact top-level selection. Exclusions, nested photos and duplicate aliases use copy mode when the API cannot represent the reviewed selection. Copy can also be chosen explicitly.

## What was observed

The checks ran on disposable Linux x64 CPU machines with Ubuntu 24.04.4, AMD Ryzen 9 9950X, Docker 29.7.0, Bun 1.4.4 and Chrome 151.0.7922.108. Browser rendering used software WebGL. These are functional diagnostics, not CI, benchmarks or evidence of production readiness. No speed or memory result is claimed.

### Released package and integrated tree

API 2.7.0 was [published on 1 November 2026](https://github.com/AIDroneMap/aidm-api/releases/tag/v2.7.0) at commit `967a4e70997de6e303565f2d732335163e4ba08e`. Its signed manifest names engine 0.2.0 and sequence 2007000. The compiled UI accepted that manifest through its default keys and installed CPU image `sha256:a16acea2c75ab17204748fe3e28a19df5ec18c0c1f3af875cdc371158876e7e3`.

The [published-package record](https://github.com/AIDroneMap/aidm-ui/pull/110#issuecomment-6555687785) covers UI head `a154ef1f18d0524ad8f543288013b82ace12b90f`. Review head `756f045256c89544a12e7f05a6e5f784a5d1d43f` and merged main `983aa323524c3e306f0f3079c51c36b7c0ea5a1e` have exactly the same tree, `4eb78939caa22e2049d49092261fa965fcac0e82`.

The real sample completed through the compiled application. Its archive passed every member's CRC, raster reads and coordinate checks, a point-cloud header and nonzero point-count check, a PDF signature check, and GLB structure and buffer-bound checks. The orthophoto output route matched the archive member. The sample produced no tiles; the map correctly reported them unavailable. Tile-route evidence comes from the imported run below.

The first diagnostic wrapper exited unsuccessfully because it failed to retain and explicitly close its log FileHandle. The installation, processing and output assertions completed successfully. The original record is retained. A corrected wrapper rechecked the same completed sample and exited successfully. That replay did not reinstall the package or repeat processing. The application and executable did not change.

The same integrated UI tree passed the published native API 2.7.0 acceptance in test mode. It covered in-place completion, zero uploads, source preservation and an archived textured model. The native archive matched its published checksum. Its test manifest used an ephemeral signer and sequence 2; it is separate from the publisher-signed container installation at sequence 2007000 above. It does not establish real native photogrammetry.

All five [review-head CI checks](https://github.com/AIDroneMap/aidm-ui/actions/runs/41290228088) passed, including typecheck and source tests, executable builds, real container runtimes and the native task API flow. Hosted CI still pins API 2.6.1, so the published 2.7.0 native check was run separately. The [second independent review](https://github.com/AIDroneMap/aidm-ui/pull/110#pullrequestreview-5727271185) approved the full-test record for the identical tree.

### Flow outcomes

The records below cover different heads. They do not represent one complete journey on one final executable.

| Flow | Observed outcome and scope |
| --- | --- |
| Installation and sample | The integrated compiled application accepted the published signature, installed API 2.7.0 and engine 0.2.0 at sequence 2007000, completed the sample and served verified outputs. |
| Browser upload | At `17a01210e2055fe0b2dd44dcffcb545448bfb9f9`, the browser uploaded the selected public photos to a second attached engine instance and completed Quick map. |
| Imported folder | At `783ae536c22841e40082240a50c288f244275d48`, the real published container completed Quick map on the checked public photos after an idle read-only mount restart. The API received every reviewed photo and no uploads. The archive, raster and produced-tile route checks passed. A mount write failed. Deletion preserved original names, modes, sizes, modification times and hashes. |
| Explicit copy | At `a2f1df5b2782f9f1726c8294a4d0072aa90a5edf`, choosing copy sent exactly the selected photos and completed processing. The earlier in-place run and sample also completed. |
| ZIP address | At `17a0121`, link checking and unknown review counts passed. The run completed without image uploads. Reported facts matched an independent read of the archived images.json. |
| Attached engine | At `17a0121`, a second independent engine instance completed the uploaded project. Both engine instances shared one physical computer. This does not validate a network between two computers. |
| Map and model | At `783ae53`, the compiled application opened an archive produced at `a2f1df5`. Map containment, pan, zoom and layer controls passed. The real textured model rendered, responded to keyboard orbit and closed and reopened. Requests stayed on the application origin with the basemap off. |
| Run again and deletion | At `17a0121`, changed settings reached the attached engine without additional photo uploads. The earlier archive and log remained unchanged. Deleting the selected rerun preserved the earlier run. The later published-container import deletion preserved the originals and the sample archive. |
| Token boundary | The `a2f1df5` real-input audit and `783ae53` viewer audit accounted for each response stream with no matches for the checked token forms and no audit errors. An earlier `17a0121` audit left a response unaccounted for; its resumed audit passed. This does not establish the absence of every possible encoding of a token. |

The [earlier diagnostic record](https://github.com/AIDroneMap/aidm-ui/pull/110#issuecomment-6554127845) covers the source-candidate integration and retained-archive viewer checks. They used prepared API source `cea190a4d90ee2688d6ffda420e5fcb805419745` with engine 0.2.0. The attached engine had no manifest sequence, and preloaded source images did not establish publisher installation.

The later real import at `783ae53` used the published API 2.7.0 container, absent before manager installation, with manifest sequence 2007000. That source test supplied the publisher key through an existing test dependency before #116. Only the publisher key, signed fixtures, verification regression and changelog differ between that head and the integrated tree. Import production code is unchanged. The integrated compiled sample then checked normal accepted-key behavior without injection.

Only reviewed records and viewer canvas screenshots were collected. Photos, result archives, databases, browser profiles, binaries and raw application or engine logs stayed in the disposable machines. The machines were deleted and subsequent lookups returned 404.

## Known limits

| Limit | Owner and follow-up |
| --- | --- |
| The input was the public sample, not an operator's private flight | UI maintainer, acceptance of another flight and its metadata or camera differences |
| The attached-engine test used another instance on the same computer | UI maintainer, a two-computer run and interrupted-network acceptance |
| The complete journey was not repeated on one final released executable | UI maintainer, acceptance of the separately identified records above or a later complete journey |
| Hosted task API coverage pins API 2.6.1 | UI maintainer, a separate workflow-only change to the published API pin |
| No real native processing run or local Windows engine was checked | Engine package maintainer, AIDroneMap/aidm#15 |
| The Sprint 2 flow was not repeated on a Mac, and the API publisher's relay check is not a UI import test | UI maintainer, Apple socket-relay and imported-folder acceptance |
| GPU processing was not exercised | Engine release maintainer, the engine release GPU test |
| No performance result is established for in-place imports | Benchmark maintainer, import preparation and disk I/O measurement |

## Acceptance boundary

The implementation tickets are merged. This milestone records the observed scope and its limits for maintainer acceptance. Merging the milestone record accepts that scope; it does not turn the untested cases into passes or declare a production release. Close the parent specification after that acceptance and the milestone documentation have merged.
