---
status: accepted
date: 2026-10-26
---

# Native engine packages are the target on desktops; containers are the interim and the server path

The requirement is that nobody needs Docker, a terminal or any technical tool to run the interface and the engine on their own computer. Today the engine ships only as a container image, and a native package exists for no desktop platform. We decided that the engine manager supports two kinds of engine package from the start, native and container, behind one adapter seam, and that the native kind is the target on Windows, macOS and Linux. Until native packages exist on Linux and macOS, the wizard installs and drives a container runtime itself: rootless Podman on Linux and Apple's `container` on macOS, with at most one operating-system approval and never an instruction to install something by hand. Where that is not possible, the wizard offers a remote engine instead. Containers stay the path for servers and for operators who already run Podman or Docker.

## Considered options

- Containers everywhere. Rejected: it makes the operator install and understand a container runtime, and on macOS it needs Apple silicon and macOS 26, which the engine itself does not require.
- Native packages everywhere, and nothing shipped until they exist. Rejected: it blocks the first release on engine builds that live in another repository.

## Consequences

- The runtime-installing code in the wizard is expected to shrink to the server case once native packages ship. Keep it isolated behind the package adapter so it can go without touching the rest.
- The CPU floor, RAM thresholds and GPU checks apply to both kinds. The memory cap is enforced on containers, and on native processes only where the operating system gives a cap for free.
- The macOS limits (Apple silicon, macOS 26 or later) come from Apple's tool, not from the engine. A native macOS package lifts them, subject to the CPU floor.
