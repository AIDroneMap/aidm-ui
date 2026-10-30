# ZIP-linked photos

An operator saves one HTTP or HTTPS ZIP address. The server makes a bounded HEAD check, follows at most five redirects, and requires a successful response, ZIP type evidence and a positive safe Content-Length. A check does not validate the ZIP bytes or guarantee that an expiring address will still work when the engine uses it. A read of the saved source does not repeat the check.

The project stores the original address only. It keeps signed query parameters intact. The checked size stays in the current browser view. Source checks exclude folder selection, uploads, Start and project deletion while they are pending. A selected link cannot replace uploaded or imported files. Changing the address invalidates a prior review.

A linked review reports unknown photo counts and bytes. It cannot enforce a finite image limit before the engine downloads the ZIP. The server validates the engine and settings as it does for uploaded photos, then uses the documented multipart `zipurl` field on `POST /task/new`. This submits a task directly. There is no upload or commit call. Cancellation waits for the bounded creation response so the task identity is available for cancellation and later project deletion.

After completion, the saved results archive supplies `images.json`. The server reads the validated archive entry without extracting it. JSON reads are capped at 16 MiB and 100,000 records. Camera and dimension summaries have at most 256 groups each. Missing, malformed or over-limit metadata remains unavailable. GPS zero is a valid coordinate. Timestamps, flights and source photo sizes are not inferred from fields the archive does not provide. Filesystem paths in metadata never enter the response.

Each linked run records a hash of its source address. The project shows facts only from a retained completed archive for that address. Changing the address or deleting its local results cannot display the previous source's facts. A bounded in-memory cache avoids parsing the same metadata on every page refresh; the project source table still contains only the address.

## Evidence

- `server/projects/link-store.test.ts` checks HEAD requests, redirects, URL validation, size and type evidence, exact address storage and run association.
- `server/projects/link-routes.test.ts` checks invalid links before task creation, source exclusivity, deletion coordination, stale reviews, unknown project counts, archive facts and local results deletion through HTTP.
- `server/projects/project-runs.test.ts` and `server/task-api/task-client.test.ts` prove single-step linked creation without uploads or commits and cancellation during task creation.
- `server/photos/linked-facts.test.ts` checks stored and deflated archive metadata, malformed records, duplicate names, missing fields, GPS zero and bounded summaries.
- `web/src/links/ProjectLink.browser.test.ts` checks keyboard source switching, saved facts, unknown run review, reload and preservation of unsaved project fields. The panel fixture checks explicit HEAD-check results and removal.
- `server/packages/real-task-api.test.ts` exercises a linked ZIP against the existing test-mode CI entry point and compares its retained metadata with the pinned engine fixture.

Test depth is full because linked task creation changes project job preparation. Hosted checks and a separate exact-head disposable-machine functional diagnostic belong in the pull request. The diagnostic is not a benchmark.
