---
status: accepted
date: 2026-10-26
---

# Container runtimes are driven through their command-line tools, behind adapters

The engine manager must run a container package through Podman, Docker or Apple's `container`. Docker and Podman expose a socket API with structured pull progress, which looks like the better interface. We decided to drive all three through their command-line tools as child processes, with JSON output where the tool offers it, behind one runtime interface with `detect`, `pull`, `start`, `stop`, `status`, `logs` and `remove`. Podman serves only Docker API version 1.40 on its compatibility socket, Apple's `container` has no socket API at all, and socket paths differ between Docker Engine, Docker Desktop, rootless Podman and the snap. One adapter shape across all three runtimes, plus a fake for tests, is worth more than structured progress on two of them.

## Consequences

- Pull progress is parsed from the tool's plain output, with the total size taken from the manifest so the progress bar is honest.
- Each adapter is tested against recorded outputs of the real tool, and the Linux adapters also against the real tools on GitHub-hosted runners with a tiny image.
- Switching one runtime to its socket API later changes one adapter and nothing above it.
