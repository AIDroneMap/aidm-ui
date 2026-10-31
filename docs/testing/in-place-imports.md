# Imported photos read by a same-machine engine

Issue #74 uses the documented task API 2.7.0 `imagesPath` field at task initialization. The choice appears only when the engine reports `imagesPath: true`, the engine is managed locally or has a loopback address, and its top-level folder is exactly the reviewed selection. The default is to read in place. Copy remains an explicit alternative for a source on a slower disk.

The API reads every accepted top-level file. It cannot apply exclusions or flatten nested folders. Those selections use copy mode, as accepted by the maintainer. Duplicate photo aliases also require a copy when the engine would otherwise receive more files than the review counted. Older engines and engines on another machine show only the copy choice, without a missing-capability message.

## Local packages

Container packages use a separate read-only mount for each imported folder. The task API sees stable paths below `/aidm-imports`; paths and the shared-folder list stay in the server. The review tells the operator that adding a folder requires an idle restart. The manager checks unfinished runs and the engine's reported queue before restarting. A preparation blocks new project and sample starts until it releases the engine. Existing mounts remain available for task restarts. A missing or replaced original is never recreated or mounted during a later engine start.

Imported mounts do not use Podman's SELinux relabel option, because relabeling changes the originals. Docker uses an existing bind source rather than a volume source that creates a missing directory. A runtime that cannot read the source fails visibly; it does not change the source permissions. The operator can choose the copy instead.

Native packages need no mount or per-folder restart. For API 2.7.0 and later, the private native API configuration enables its images root at the filesystem root. The API remains on loopback with its server-held token. The public run routes accept a mode, never an arbitrary engine folder: the server derives that folder from its checked import record. This permits imports from the operator's other folders and disks without changing the native process for each run.

## Input checks and retained runs

The server checks the original file identities and hashes before task creation and again before commit. A changed source leaves an uncommitted task that is removed. No image upload is sent in place. Restart rechecks the originals before reusing the task's links. Changing the import mode creates a new task so the run uses the reviewed mode. Missing-task recreation uses the saved input record and original import mode. Switching to another engine reconciles the choice again.

Creating or removing a hard link changes a file's ctime even when its bytes, permissions, size and modification time are unchanged. Import validation accepts a ctime-only change only after checking the file identity and full content hash. A write followed by a restored modification time still fails the hash check. Directory changes, replaced files and changed modification times remain failures.

## Verification

- `server/task-api/task-client.test.ts` checks strict capability parsing and the documented `imagesPath` form field.
- `server/projects/in-place-runs.test.ts` covers default in-place creation, zero uploads, explicit copying, selections the API cannot represent, engines elsewhere, source preservation, link metadata, content drift and the local container's new address after a mount restart.
- `server/local-engine/local-engine.test.ts` checks idle-only mounting, engine-reported work, recorded work and preventing a sample from starting during the restart reservation.
- Package and runtime tests check native configuration, read-only mounts, preserving source metadata and Docker's existing-source syntax. The hosted real container tests also attempt a write through the read-only mount and require it to fail.
- `web/src/run-start/ImportMode.browser.test.ts` checks the keyboard choices, restart notice, engine changes, submitted copy mode and tablet width.
- The existing native task API acceptance adds an in-place project run when that API reports the capability. It checks completion, zero uploads, the engine's image count and original file names, modes, sizes, modification times and hashes after run deletion. An older API still exercises the existing copy flow.

The prepared API 2.7.0 package retains exactly the API 2.6.1 test-mode option fixture, Git blob `7b897173fddd91a5165424fcce7c2f00cfb6c69b`. The catalogue guard names only these two API versions and still rejects any further missing or unexplained option. This fixture exception does not describe the real engine option list.

Test depth is full because engine startup, mounts and task preparation change. The pull request links CI and the exact-head runtime record separately. Disposable diagnostics make no performance or production-readiness claim.
