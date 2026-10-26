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
| `docker/pull-no-tty.txt` | the image pull that `docker run` does when output is not a terminal | Only the pull lines are kept. The failed container start that followed was dropped. |
| `podman/version.txt` | `podman version --format json` | Only the normalisations listed below. |
| `podman/info-rootless.txt` | `podman info --format json`, rootless, controllers include `memory` | `hostname` set to `operator-pc`. Home folders changed to `/home/operator`. Normalisations as below. |
| `podman/inspect-missing.*` | `podman inspect --format json nosuch` | Split into stdout `[]` and stderr. Exit 125. |
| `podman/pull.*` | `podman pull` of an image by digest | Split: the image ID is stdout, the progress lines are stderr. |
| `podman/system-migrate.txt` | `podman system migrate` | Nothing (no output, exit 0). Not used by a test yet. |
| `docker/pull-busybox.txt` | `docker pull docker.io/library/busybox@sha256:bdf57e52...` | Nothing. All stdout. The first line names the image, the layer lines follow. |
| `docker/pull-not-found.*` | the same with a digest that does not exist | stderr only, exit 1. |
| `docker/pull-no-repository.*` | the same with a repository that does not exist | stderr only, exit 1. |
| `docker/run.txt` | `docker run -d --name ... -p 127.0.0.1:PORT:3000 -v ... --memory 268435456b --cpus 1` of busybox `httpd` | Container ID replaced by `1111...`. |
| `docker/run-name-in-use.*` | the same run again under the same name | Container ID replaced as above. Exit 125, stderr only. |
| `docker/run-port-in-use.*` | a run under another name on the port the first container holds | Exit 125. Docker had created the container before the start failed and printed its ID on stdout (replaced by `5555...`), so the adapter removes the half-made container. |
| `docker/inspect-running.txt`, `docker/inspect-exited.txt` | `docker inspect --format json NAME` while the container ran, and after `docker stop -t 5` (exit code 137, because `httpd` as the first process ignores SIGTERM) | IDs replaced by runs of one digit. The folder `/home/operator/engine-data`. Timestamps set to `2026-01-01T00:00:00Z` (the unset `0001-01-01` ones stay). `Pid` set to 4242. The container `Hostname` (its short ID) set to `operator-pc`. Network addresses in `192.0.2.0/24`, the MAC address changed to a made-up one. |
| `docker/inspect-missing.*` | `docker inspect --format json NAME` after removal | stdout `[]`, exit 1, stderr `error: no such object: ...` (lower case, unlike the Docker CLI source). |
| `docker/logs.*` | `docker logs --tail 50 NAME` after one request | Container output is on stderr (busybox `httpd -v`), so it is in the `.json`. Client address changed to `192.0.2.1`. |
| `docker/logs-missing.*`, `docker/stop.txt`, `docker/stop-missing.*`, `docker/rm.txt`, `docker/rm-missing.txt`, `docker/rmi.txt`, `docker/rmi-missing.*` | `logs`, `stop -t 5`, `rm -f`, `rmi` on the container and image above, and again once gone | Name changed to `aidm-engine`. `rm -f` of a missing container prints nothing and exits 0. |

The Docker cases were recorded with Docker 29.9.2 on the same Linux machine,
with the public image `docker.io/library/busybox@sha256:bdf57e52...` (busybox
1.37). The container name was `aidm-ui-rec-9a`, shown here as `aidm-engine`, and
the port was changed to `41823`.

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

Rebuilt from the Podman source (`cmd/podman`, `test/system`, HEAD of 23 October
2026) and the runtime research notes. The Podman on the recording machine ran
only `version`, `info`, `inspect` of a missing name and `pull`, so these have
not been checked against a real run. Podman 5.x may word the messages a little
differently. The adapter matches on short phrases for that reason.

- `podman/run.txt`, `run-name-in-use.*` (exit 125), `run-port-in-use.*` (exit 126, the `rootlessport` message)
- `podman/inspect-running.txt`, `inspect-exited.txt`, `inspect-oom-killed.txt`, `inspect-created.txt` (only the fields the adapter reads, timestamps set to `2026-01-01T00:00:00Z`, in Podman's JSON shape)
- `podman/logs.*`, `logs-missing.*`, `stop.txt`, `stop-missing.*`, `rm.txt`, `rm-missing.txt`
- `podman/rmi.txt`, `rmi-missing.*` (exit 1, `image not known`), `rmi-in-use.*` (exit 2)
- `podman/pull-not-found.*` (exit 125, `manifest unknown`)
- `podman/pull-three-layers.*`: the recorded `podman/pull` with two more `Copying blob` lines, to test the layer count.

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
