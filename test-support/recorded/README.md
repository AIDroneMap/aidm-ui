# Recorded command outputs

Outputs of the programs the machine check and the runtime adapters run. Tests
load them through `recorded(tool, case)` and `recordedText(tool, case)` in
`test-support/scripted-runner.ts`.

Each case is `<tool>/<case>.txt` (stdout). A sibling `<case>.json` holds
`{ "exitCode": n, "stderr": "..." }`; without one the case is exit 0 with an
empty stderr.

A test (`server/machine/recorded-fixtures.test.ts`) fails if a host name, user
name, home folder, identifier or public address comes back into these files.

## Recorded on a Linux machine

Real runs on one Linux machine (Ubuntu 24.04, Docker 29.9.2, Podman 5.8.9 from
a Fedora container). The recordings are from 26 October 2026.

| File | Source | What changed |
|---|---|---|
| `docker/version.txt` | `docker version --format json`, daemon reachable | Nothing. |
| `docker/version-no-daemon.*` | the same, with a socket path that does not exist | The two streams were split: the JSON is stdout, the error line is stderr. Exit 1. |
| `docker/info.txt` | `docker info --format json` | Daemon `ID` set to all zeros. `Name` (the machine's host name) set to `operator-pc`. The value of `status` under `Runtimes` (a long copy of the runc feature list) cut to `{}`. |
| `docker/pull-no-tty.txt` | the image pull that `docker run` does when output is not a terminal | Only the pull lines are kept. The failed container start that followed was dropped. Not used by a test yet. |
| `podman/version.txt` | `podman version --format json` | Nothing. |
| `podman/info-rootless.txt` | `podman info --format json`, rootless, controllers include `memory` | `hostname` set to `operator-pc`. Home folders changed to `/home/operator`. |
| `podman/inspect-missing.*` | `podman inspect --format json nosuch` | Split into stdout `[]` and stderr. Exit 125. Not used by a test yet. |
| `podman/pull.*` | `podman pull` of an image by digest | Split: the image ID is stdout, the progress lines are stderr. Not used by a test yet. |
| `podman/system-migrate.txt` | `podman system migrate` | Nothing (no output, exit 0). Not used by a test yet. |

## Edited

Marked edited because no machine produced them as they stand.

| File | Made from | Edit |
|---|---|---|
| `docker/version-permission-denied.*` | `docker/version-no-daemon` | stderr replaced with the real message pattern `permission denied while trying to connect to the docker API at unix:///var/run/docker.sock` (Docker CLI source, `client/request.go`). |
| `docker/info-rootless.txt` | `docker/info.txt` | `name=rootless` added to `SecurityOptions`, as the daemon does for a rootless install. |
| `podman/info-rootful.txt` | `podman/info-rootless.txt` | `security.rootless` set to `false`. |
| `podman/info-rootless-no-memory.txt` | `podman/info-rootless.txt` | `memory` removed from `cgroupControllers`. |
| `podman/info-rootful-no-memory.txt` | `podman/info-rootful.txt` | `memory` removed from `cgroupControllers`. |
| `cpuinfo/x86-64-no-avx2.txt` | `cpuinfo/x86-64-avx2.txt` | `avx2` and `fma` removed from the `flags` line. |
| `cpuinfo/arm64-v8-0.txt` | `cpuinfo/arm64-v8-2.txt` | `atomics` and `asimdrdm` removed from the `Features` line. |

## Written by hand

`cpuinfo/x86-64-avx2.txt` and `cpuinfo/arm64-v8-2.txt` are typical `/proc/cpuinfo`
text for a modern x86-64 CPU and an Armv8.2 CPU, two processors each, in the
shape the kernel prints. They are not copies of one machine.

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

- Docker daemon `ID` (a UUID): now zeros.
- The machine's host name, in Docker `Name` and in Podman `host.hostname`: now `operator-pc`.
- The user name in home folders (`/home/podman`): now `/home/operator`.
- No IP addresses were present. Loopback networks in Docker's registry config (`127.0.0.0/8`) stay.
- Kernel strings, versions, commit hashes and image digests stay.
