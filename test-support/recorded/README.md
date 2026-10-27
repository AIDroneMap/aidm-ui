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
| `podman/load-dir.*` | `podman load -i FOLDER` of an OCI image layout folder that holds the busybox image | Split: the line `Loaded image: sha256:30ecbe...` is stdout, the progress lines are stderr. Nothing else changed. |
| `podman/load-missing.*` | the same with a folder that does not exist | stderr only, exit 125. Nothing changed. |
| `podman/tag.txt` | `podman tag CONFIG_DIGEST ghcr.io/aidm-ui-loadtest/busybox:sha256-66a6306d...` | Nothing (no output, exit 0). |
| `podman/image-inspect-loaded.txt` | `podman image inspect NAME` after the load and the tag | Podman's home folder `/home/podman` replaced by `/home/operator`. Timestamps set to `2026-01-01T00:00:00Z`. |
| `podman/image-inspect-missing.*` | the same with a tag that does not exist | Split into stdout `[]` and stderr. Exit 125. Nothing else changed. |
| `podman/rmi-loaded.txt` | `podman rmi NAME` of the loaded image | Nothing. |
| `docker/load.txt` | `docker load` with an archive on standard input (the OCI layout and the `manifest.json` of `docker save`, as aidm-ui writes it), on Docker 29.9.2 with the containerd image store | Nothing. |
| `docker/load-classic.txt` | the same archive on Docker 28.5.2 with the classic image store (overlay2 storage driver) | Nothing. |
| `docker/load-truncated.*` | `docker load` of the same archive cut after 100000 bytes (containerd image store) | stderr only, exit 1. Nothing changed. |
| `docker/load-missing-layer.txt` | `docker load` of an archive of a small image that leaves out a layer the content store does not hold, on Docker 29.9.2 with the containerd image store, recorded on the build server on 27 October 2026 | Exit 0, with a line "Error unpacking image". The record does not tell stdout from stderr; it is kept as one block. The image is a throwaway one (`localhost/aidm-reuse:two`). |
| `docker/image-inspect-containerd.txt` | `docker image inspect NAME` after `docker/load.txt`: the ID is the manifest digest | Timestamps set to `2026-01-01T00:00:00Z`. |
| `docker/image-inspect-classic.txt` | `docker image inspect NAME` after `docker/load-classic.txt`: the ID is the config digest | Timestamps set to `2026-01-01T00:00:00Z`. |
| `docker/image-inspect-missing.*` | the same with a tag that does not exist | stdout `[]`, exit 1, stderr `Error response from daemon: No such image: ...`. Nothing changed. |
| `docker/rmi-loaded.txt` | `docker rmi NAME` of the loaded image | Nothing. |
| `systemd/show-environment.txt` | `systemctl --user show-environment` on a Linux machine whose user manager runs (exit 0) | User name and home folder changed to `operator`, the user id to 1000. The entries that name this machine (`GPG_AGENT_INFO`, `SSH_AUTH_SOCK`, snap paths in `PATH` and `XDG_DATA_DIRS`) were dropped. |
| `systemd/run-scope.txt` | `systemd-run --user --scope --quiet -p MemoryMax=1G -- true` on a Linux machine whose user manager runs | Nothing (no output, exit 0). |
| `systemd/run-scope-no-bus.*` | the same with `XDG_RUNTIME_DIR` set to a folder that does not exist and `DBUS_SESSION_BUS_ADDRESS` empty, so that the user manager cannot be reached | stderr only, exit 1. Nothing was changed. |

The adapter now asks for a container with `docker inspect --type container NAME`
and `podman container inspect NAME`, which print the same JSON as the commands
the inspect recordings were made with, so those recordings still stand.

The load and inspect cases above are of one image: busybox 1.37, linux/amd64
(manifest digest `sha256:66a6306d...`, config digest `sha256:30ecbe15...`, one
layer of 2211514 bytes), named `ghcr.io/aidm-ui-loadtest/busybox:sha256-66a6306d...`,
which is the tag aidm-ui gives an image it loads. The classic image store
recordings (`docker/load-classic.txt`, `docker/image-inspect-classic.txt`) came
from Docker 28.5.2 with the overlay2 storage driver, and every other Docker case
from Docker 29.9.2. Podman 5.8.9 ran rootless in a container.

The other Docker cases were recorded with Docker 29.9.2 on the same Linux machine,
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
| `podman/info-rootless-no-cpu.txt` | `podman/info-rootless.txt` | `cpu` removed from `cgroupControllers`. |
| `docker/info-nvidia-runtime.txt` | `docker/info.txt` | An `nvidia` entry added under `Runtimes` with the path `nvidia-container-runtime` and no status, which is what `docker info` lists after `nvidia-ctk runtime configure` (shape from the Docker daemon source, `Runtimes` is a map of name to path and options). |
| `docker/info-no-cpu-quota.txt` | `docker/info.txt` | `CpuCfsQuota` set to `false`. |
| `cpuinfo/x86-64-no-avx2.txt` | `cpuinfo/x86-64-avx2.txt` | `avx2` and `fma` removed from the `flags` line. |
| `cpuinfo/arm64-v8-0.txt` | `cpuinfo/arm64-v8-2.txt` | `atomics` and `asimdrdm` removed from the `Features` line. |

## Written by hand

The four files in `cpuinfo/` are hand-written typical text, not recordings.
`x86-64-avx2.txt` and `arm64-v8-2.txt` are typical `/proc/cpuinfo` text for a
modern x86-64 CPU and an Armv8.2 CPU, two processors each, in the shape the
kernel prints. They are not copies of one machine. The other two are edits of
them (see the table above).

## Recorded on a Mac

From the recording of every runtime command in the second Mac test (27 October 2026, Apple's container tool 1.6.1,
macOS 27.0, three sessions). "Session 1" is the first run of the recording (seq 1 to 25), "session 2" the second
(seq 1 to 16) and "session 3" the third (seq 26 to 60). The user name in the paths was replaced in the recording
already.

| File | Command | What changed |
| --- | --- | --- |
| `apple-container/inspect-running.txt` | `container inspect aidm-local-engine` while the engine ran and answered | The container's MAC address and IPv6 address were set to placeholders. |
| `apple-container/cli-version.txt` | `container --version` (session 1, seq 19) | Nothing. The commit is `aa8d76b`, not the one the source-built file had. |
| `apple-container/system-status-running.txt` | `container system status --format json` right after the start (session 1, seq 20) | `cpus` set from 15 to 8. Nothing else. The real key order is alphabetical, there is no `logRoot` key, both paths end with `/`, and `operatingSystem` reads `Version 27.0 (Build 26A428)`. |
| `apple-container/system-start.*` | `container system start --enable-kernel-install`, streamed (session 1, seq 18) | Nothing. All four lines are on stderr (so they are in the `.json`) and stdout is empty. The real run printed no line about the startup files, so the made-up `Fetching init image...` line is gone. |
| `apple-container/image-inspect-init-missing.*` | `container image inspect ghcr.io/apple/containerization/vminit:0.53.0` before the load (session 2, seq 3) | Nothing. Exit 1, stderr `Error: image not found: ...` with no `notFound:` prefix. |
| `apple-container/image-load-init.txt` | `container image load` of the startup files (session 2, seq 12) | Nothing. Exit 0, the reference it loaded on stdout. |
| `apple-container/image-inspect-init-present.txt` | the same inspect after the load (session 2, seq 13) | Nothing. Exit 0, an empty JSON list (`[`, a blank line, `]`): the tool hides its startup files from `image inspect`. |
| `apple-container/inspect-missing.*` | `container inspect aidm-local-engine` before the first run (session 3, seq 47) | Nothing. Exit 1, stderr `Error: container not found: aidm-local-engine`, no `notFound:` prefix. |
| `apple-container/run.*` | `container run -d --name aidm-local-engine ...` of the engine image (session 3, seq 48) | Nothing. Stdout is the name of the container. The six numbered progress steps are on stderr, so they are in the `.json` (exit 0). |
| `apple-container/logs.txt` | `container logs -f aidm-local-engine`, streamed (session 3, seq 49) | Only the first 7 lines are kept; the recording goes on with the lines of a job. In `Listening on ...:6367 UDP`, the address `0.0.0.0` was set to `127.0.0.1`. |
| `apple-container/image-inspect-engine.txt` | `container image inspect` of the engine image after its load (session 3, seq 43) | All 24 timestamps (`creationDate`, `created`, the history) set to `2026-01-01T00:00:00Z`. Nothing else. The manifest digest is under `variants`, and the image's own index is under `configuration.descriptor`. |
| `apple-container/pull-stream-closed.*` | `container image pull --platform linux/arm64 --progress plain ...` of the engine image (session 1, seq 25; seq 21 to 24 ended the same way) | Cut to the first 3 lines, the first line with a percentage, the last 3 progress lines and the error line. Exit 1, stdout empty. The numbers use a decimal comma because that Mac is set to Italian. Nothing else changed. |

The container is called `aidm-local-engine` in the recording. The tests that use these files use that name where they
read it back (`run.txt`), and a made-up name elsewhere.

## Reconstructed from source

The recording of the second Mac test does not hold these cases. They are rebuilt from the output formats in the
Apple `container` source (release 1.6.1: `SystemStatus.swift` for the status JSON) and from the sample lines in the
runtime research notes. They have not been checked against a real run.

- `docker/run-image-not-found.*` (exit 125, `No such image`, which is what `docker run --pull=never` says for an image that is not stored; from the Docker CLI and daemon sources)
- `apple-container/system-status-not-running.*`, `system-status-unregistered.*` (exit 1, as the source does; the
  recording only has the running answer)
- Every other file in `apple-container/`, for the operations of the adapter. None was captured; each is built from
  the command reference and the source of release 1.6.1, and the error texts are the ones the research notes quote.
  What is a guess is said here, so nobody takes it for a recording:
  - `pull.*`: the plain progress lines of a pull that works. The recording only has pulls that failed (see
    `pull-stream-closed.*` above, whose lines are real), so the wording of the counts here is a guess, and the
    unpack lines (`[2/2] Unpacking image ...`) were never seen. The progress goes to stderr. `pull-not-found.*` and
    `pull-service-down.*` carry error texts the research notes do not quote for a pull; the first is a guess, the
    second is the rewritten service error of `Application.swift`. Only `pull-service-down.*` is used by a test.
  - `run-name-in-use.*` (`container already exists: <id>`, from the source), `run-service-down.*`.
    `run-port-in-use.*` and `run-image-not-found.*` are guesses: the research notes found no
    port conflict message and no image message for a run. The adapter matches whole phrases only, and a failed run is never followed by a delete.
  - `inspect-stopped.txt`, `inspect-stopping.txt`, `inspect-unknown.txt`: the shape of the
    documentation sample, with the state in `status.state`. No exit code is in any of them, because
    the research notes found none. The real running answer is much longer (see `inspect-running.txt`).
  - `logs-missing.*`, `stop.txt`, `stop-not-running.*` (`container <id> is not running`, from the
    source), `stop-missing.*`, `delete.txt`, `delete-missing.*`. A real `delete --force` of a missing container may
    print nothing and succeed; the adapter accepts both.
  - `image-delete.txt`, `image-delete-missing.*` and `image-delete-in-use.*`: the first prints the reference, as the
    source does; the other two texts are guesses.
  - `system-start-failed.*`: one line, `Launching container-apiserver...`, from the source, and the error text is a
    guess. The real tool prints its start lines on stderr (see `system-start.*` above); here the line is on stdout.
    The streaming runner treats both streams alike.
- `macos/sw-vers-26.txt`, `sw-vers-15.txt` (`sw_vers -productVersion`)
- `nvidia/smi-l.txt` (`nvidia-smi -L`, with a placeholder UUID)
- `nvidia/smi-l-no-driver.*` (exit 9, the driver message from the `nvidia-smi` manual and the text people quote from it; whether a real machine without a loaded driver exits 9 or 255 was not confirmed). The same file stands for the failing listing inside the engine image.
- `nvidia-ctk/cdi-list.*` (`nvidia-ctk cdi list`: one device name per line on stdout, the `INFO` line on stderr, from `cmd/nvidia-ctk/cdi/list/list.go` of the NVIDIA Container Toolkit and the device names in its README) and `nvidia-ctk/cdi-list-none.*` (the same with no device: nothing on stdout, exit 0)

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
- `podman/run-image-not-found.*` (exit 125, `image not known`, which is what `podman run --pull=never` says for an image that is not stored)
- `podman/pull-three-layers.*`: the recorded `podman/pull` with two more `Copying blob` lines, to test the layer count.

## os-release files

`os-release/*.txt` are the contents of `/etc/os-release` for the distributions
the Podman setup step knows (and Gentoo, which it does not). They are
hand-written from the values in the install research notes (Debian 13,
Ubuntu 24.04, Linux Mint 21.2, Fedora 42, openSUSE Tumbleweed) and from the
systemd `os-release(5)` description (Arch Linux and Gentoo, whose files carry
only the fields the setup step reads and a few common ones). They hold no
machine-specific values.

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

The Apple container status text (`apple-container/system-status-running.txt`) is recorded, and its core count was
set to 8 like the others.
