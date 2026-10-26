# Recorded command outputs

Outputs of the programs the machine check and the runtime adapters run. Tests
load them through `recorded(tool, case)` and `recordedText(tool, case)` in
`test-support/scripted-runner.ts`.

Each case is `<tool>/<case>.txt` (stdout). A sibling `<case>.json` holds
`{ "exitCode": n, "stderr": "..." }`; without one the case is exit 0 with an
empty stderr.

A test (`server/machine/recorded-fixtures.test.ts`) fails if a host name, user
name, home folder, identifier, public address or hardware fingerprint comes back
into these files. It checks shapes, not the values that were removed.

## Recorded on a Linux machine

Real runs on one Linux machine (Ubuntu 24.04, Docker 29.9.2, Podman 5.8.9 from
a Fedora container). The recordings are from 26 October 2026.

| File | Source | What changed |
|---|---|---|
| `docker/version.txt` | `docker version --format json`, daemon reachable | Only the normalisations listed below. |
| `docker/version-no-daemon.*` | the same, with a socket path that does not exist | The two streams were split: the JSON is stdout, the error line is stderr. Exit 1. Normalisations as below. |
| `docker/info.txt` | `docker info --format json` | Daemon `ID` set to all zeros. `Name` (the machine's host name) set to `operator-pc`. The value of `status` under `Runtimes` (a long copy of the runc feature list) cut to `{}`. Normalisations as below. |
| `docker/pull-no-tty.txt` | the image pull that `docker run` does when output is not a terminal | Only the pull lines are kept. The failed container start that followed was dropped.  |
| `podman/version.txt` | `podman version --format json` | Only the normalisations listed below. |
| `podman/info-rootless.txt` | `podman info --format json`, rootless, controllers include `memory` | `hostname` set to `operator-pc`. Home folders changed to `/home/operator`. Normalisations as below. |
| `podman/inspect-missing.*` | `podman inspect --format json nosuch` | Split into stdout `[]` and stderr. Exit 125.  |
| `podman/pull.*` | `podman pull` of an image by digest | Split: the image ID is stdout, the progress lines are stderr.  |
| `podman/system-migrate.txt` | `podman system migrate` | Nothing (no output, exit 0).  |

## Edited

Marked edited because no machine produced them as they stand.

| File | Made from | Edit |
|---|---|---|
| `docker/version-permission-denied.*` | `docker/version-no-daemon` | stderr replaced with the real message pattern `permission denied while trying to connect to the docker API at unix:///var/run/docker.sock` (Docker CLI source, `client/request.go`). |
| `docker/info-rootless.txt` | `docker/info.txt` | `name=rootless` added to `SecurityOptions`, as the daemon does for a rootless install. Not used by a test yet. |
| `podman/info-rootful.txt` | `podman/info-rootless.txt` | `security.rootless` set to `false`. |
| `podman/info-rootless-no-memory.txt` | `podman/info-rootless.txt` | `memory` removed from `cgroupControllers`. |
| `podman/info-rootful-no-memory.txt` | `podman/info-rootful.txt` | `memory` removed from `cgroupControllers`. |
| `cpuinfo/x86-64-no-avx2.txt` | `cpuinfo/x86-64-avx2.txt` | `avx2` and `fma` removed from the `flags` line. |
| `cpuinfo/arm64-v8-0.txt` | `cpuinfo/arm64-v8-2.txt` | `atomics` and `asimdrdm` removed from the `Features` line. |

## Written by hand

The four files in `cpuinfo/` are hand-written typical text, not recordings.
`x86-64-avx2.txt` and `arm64-v8-2.txt` are typical `/proc/cpuinfo` text for a
modern x86-64 CPU and an Armv8.2 CPU, two processors each, in the shape the
kernel prints. They are not copies of one machine. The other two are edits of
them (see the table above).

## Reconstructed from source

No Mac was available. These are rebuilt from the output formats in the Apple
`container` source (release 1.6.1: `SystemStatus.swift` for the status JSON,
`docs/command-reference.md` for the version JSON) and from the sample lines in
the runtime research notes. They have not been checked against a real run.

- `apple-container/system-version.txt`, `system-version-not-started.txt`
- `apple-container/system-status-running.txt`, `system-status-not-running.*`,
  `system-status-unregistered.*` (exit 1, as the source does)
- `macos/sw-vers-26.txt`, `sw-vers-15.txt` (`sw_vers -productVersion`)
- `nvidia/smi-l.txt` (`nvidia-smi -L`, with a placeholder UUID)

## What was scrubbed from the recordings

The `docker/` and `podman/` files keep the JSON shapes of the real output. These
values were replaced:

- Docker daemon `ID` (a UUID): all zeros.
- The machine's host name, in Docker `Name` and in Podman `host.hostname`: `operator-pc`.
- The user name in home folders: `/home/operator`.
- Memory totals (`MemTotal`, `memTotal`): 34359738368 (32 GiB). `memFree`: 16 GiB. `swapFree`, `swapTotal`: 2 GiB and 4 GiB.
- CPU counts (`NCPU`, `cpus`): 8. Podman CPU use percentages and `uptime`: round values.
- Disk numbers (`graphRootAllocated`, `graphRootUsed`): 1000000000000 and 100000000000.
- Image and container counts, open file and goroutine counts: small round numbers.
- Every timestamp: 2026-01-01T00:00:00Z, or the same instant in the format the field uses (ISO text, Go's `Thu Jan  1 00:00:00 2026`, or seconds since the epoch).
- The kernel: `6.8.0-generic`.
- No IP addresses were present. Loopback networks in Docker's registry config (`127.0.0.0/8`) stay.
- Versions, commit hashes and image digests stay: they name public software, not the machine.

The Apple container status text (`apple-container/system-status-running.txt`) is
reconstructed, and its core count is also 8.
