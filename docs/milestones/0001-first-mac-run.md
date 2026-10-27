# Milestone 1: from one executable to a finished run on a Mac

Closed on 27 October 2026, pending the checks listed at the end on Dimitri's Mac.

## What it delivers

One executable, started with no arguments, serves the interface in the browser and takes an operator from a bare computer to a finished photogrammetry run:

- the wizard checks the computer (processor, memory, disk, graphics card, container tool), installs the engine, and offers the sample job;
- the engine package is downloaded by aidm-ui itself, blob by blob, with resume across broken connections and a check of every blob (ADR 0005). Layers the container tool already holds are not downloaded again;
- on Linux the engine runs in Podman or Docker; on a Mac in Apple's container tool, which aidm-ui installs and sets up with one approval from the operator (ADR 0001, ADR 0004);
- the sample job downloads 73 public drone photos once, keeps them, sends them to the engine, follows the run and offers the results archive;
- remote engines on the network or in the cloud are added by address and token, and the token never reaches the browser (ADR 0002);
- updates and the way back to the previous version come from a signed manifest (ADR 0003);
- a readable log for diagnosis holds every install step, command, download, failed check and a summary of every run; on a Mac it says why an engine that runs cannot be reached (ADR 0006).

Spec #2 and its tickets #3 to #15, and the follow-ups after the Mac tests, built it: #34 to #38, #42 to #44, #46, #49, #50 and this file's #51.

## Measured

### On a Mac

Apple M5 Pro with 24 GiB of memory, macOS 27.0, Apple's container tool 1.6.1, three Mac tests on 26 and 27 October 2026:

| What | Figure |
| --- | --- |
| Engine download, aidm-api 2.5.0 for arm64 | 594 MiB, finished through 2 connection cuts |
| Load into Apple's container tool | 8.9 s |
| Sample photos | 888,735,308 bytes, finished after a forced cut at 97.3% |
| Upload | 73 photos |
| Sample job, aidm-api 2.5.0 (Node.js) | 395 s and 392 s |
| Sample job, aidm-api 2.6.1 (Bun), started by hand and added as a remote engine | 381 s |
| Engine image of aidm-api 2.6.1 for arm64 | 487 MiB in 13 layers; the container tool, holding 2.5.0, fetched only its 8 new layers, 56 MiB |
| "Start again" | the photos came from disk ("already on disk and checked") |

The three runs had the same options, warnings and failed processes. The differences in time are the ordinary spread from one run to the next, not the task API.

For comparison, the engine's CI measured the same sample job at 982 s on a 4-core arm64 runner and 1366 s on a 4-core x64 runner, both with 15 GiB of memory.

### On the build server

One end-to-end run per container runtime on 27 October 2026, on the tip of #46, #49 and #50, through the same calls the interface makes: the wizard's checks, the install of the built-in 2.5.0 package, the sample job and its results archive. AMD Ryzen 9 9900X (12 cores, 24 threads), 60 GiB of memory, Linux x64.

| What | Docker 29.9.2 (containerd store) | Podman 5.8.9 (rootful, in its own container) |
| --- | --- | --- |
| Install of the engine, 682,533,845 bytes | ready after 30 s (download 22.8 s) | ready after 40 s (download 25.4 s) |
| Sample photos download | 12 s | 13 s |
| Upload and the wait in the engine's queue (one step to the polls) | 3 s | 3 s |
| Processing, as the engine counts it | 311.5 s | 316.2 s |
| Sample job from the click to completed | 325 s | 332 s |
| Results archive | 248,309,465 bytes | 250,657,290 bytes |

The full test suite passed on that tip: 1571 tests, 31 skipped where they need a real runtime or the real task API, which CI runs. In CI the real Podman and Docker jobs also loaded an image without the layer they already held.

## Known limits

| Limit | Owner |
| --- | --- |
| On arm64 the engine's PoissonRecon races with several threads and only succeeds single-threaded: three failed attempts on every arm64 run, including all three Mac runs | AIDroneMap/aidm#24 |
| OpenMVS on arm64 builds its "no SSE" branch and carries an "x32" label that needs checking | AIDroneMap/aidm#25 |
| On a Mac the engine is reached through a published port, so a VPN client with an exit node can take its route at each reconnect, and aidm-ui can only explain it. The socket connection that needs no network waits for the task API to listen on a Unix socket | AIDroneMap/aidm-api#34 |
| Engine packages after 2.5.0 come with signed manifests only from aidm-api 2.7.0 | AIDroneMap/aidm-api#25 |
| A built-in entry for 2.6.1 waits for the production signing key | Dimitri |
| No local engine on Windows yet, and no native engine packages for Linux or macOS | AIDroneMap/aidm#15 |
| The Mac app's packaging and signing, from the first-release addendum | Dimitri |

## Before calling it closed

To be checked on the Mac after #46, #49 and #50 are merged:

- with the Local Network permission for "container" off, the engines page names the permission, and no "No engine answered" note shows;
- with a VPN client's exit node on, after its next reconnect, the page says the VPN changed the route and offers no move;
- an update from 2.5.0 downloads only the new layers, and the engine starts;
- the log has one summary line per run, with the failed PoissonRecon attempts counted.
