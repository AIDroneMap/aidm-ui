---
status: accepted
date: 2026-10-27
---

# The local engine on a Mac is reached through a socket, and explains itself when it cannot be

An operator must never be left with a local engine that runs and cannot be reached, with no hint why. On a Mac, the connection should not depend on the IP network at all where that can be done. This changes how aidm-ui reaches the engine in Apple's container tool. Docker and Podman keep the published port.

## Why

The second install on a real Mac (Apple M5 Pro, 24 GiB, macOS 27.0, Apple's tool 1.6.1) ran a whole job, over a slow, unstable mobile link through a VPN exit node, about 0.5 to 1 MB/s. Twice the engine ran and aidm-ui could not reach it:

1. macOS asked whether "container" may find devices on the local network, and the answer was no. Every connection to the published port 127.0.0.1:<port> was reset (ECONNRESET). `ping` and `curl` to the container's address, 192.168.64.2, failed at once with "No route to host", and `route -n get` showed the tool's bridge (bridge100). Inside the container the API answered. Turning the permission on fixed it with no restart.
2. After 18 minutes, at a VPN reconnect, polls timed out after 10 s. The VPN client, with an exit node and LAN access off, had put a route for 192.168.64.0/24 into its tunnel (utun4). Allowing LAN access replaced it with a route through the home router, also wrong. Only a route added by hand through 192.168.64.1 fixed it.

Both come from the same place. The tool publishes a port by listening on 127.0.0.1 in its runtime helper and connecting from there to the container's address on a small virtual network (1.6.1: `RuntimeService.startSocketForwarders`). That connection needs the Local Network permission, which the tool asks for only for a container with published ports (`LocalNetworkPrivacy.triggerLocalNetworkPrivacyAlert`), and it follows the Mac's routing table, which a VPN may rewrite at any time.

The tool has another way. `container run --publish-socket host_path:container_path` relays a Unix socket inside the container to one on the Mac through the virtual machine's own channel, vsock (`Parser.publishSocket`, `UnixSocketRelay`, direction `.outOf`). The program inside listens on `container_path`. The runtime helper creates `host_path` at each start, removes it at a clean stop, and `container run` refuses a socket file that is already there. No IP route and no permission are involved.

## Decision

### The socket

When Apple's tool runs the engine and the manifest entry of its package says `"taskApiSocket": true`, aidm-ui:

- starts the container with `--publish-socket <data folder>/run/task-api.sock:/run/task-api.sock` and no `-p`;
- writes `"socket": "/run/task-api.sock"` into the task API's config file, next to the port, which stays open inside the container for the check from inside;
- removes a socket file left at the host path before the start, since the tool would refuse it;
- stores the engine's address as `unix:<host path>`, and the task client sends every request over that socket with Bun's `fetch` and its `unix` option. The address rule for typed addresses does not apply to it.

The task API cannot listen on a socket today: aidm-api 2.6.1 calls `app.listen(port)` only. AIDroneMap/aidm-api#34 asks for the option.

aidm-ui learns that a package can do it from the signed manifest, because it must know before the start what to start. Asking the API's version needs a running engine, and so does a check at start, which would also have to start the engine twice when the answer is no. A manifest field costs nothing: a version of aidm-ui that does not know it ignores it, and the first task API release with the option sets it on its container variants.

A socket path on macOS holds 104 bytes with the closing zero. A data folder deep enough to pass that falls back to the published port, and the diagnosis log says so.

With the socket, the step list leaves out the Local Network step: the tool never asks for the permission.

### Until then: three checks on the published port

When the engine container runs and the task API does not answer from the Mac, aidm-ui runs three checks every five seconds until it answers again, so a setting the operator changes shows without a click. Each step goes to the diagnosis log:

1. **The route.** `container inspect` gives the container's address and gateway, `ifconfig` the interface that holds the gateway (the tool's bridge), and `route -n get <address>` the interface the Mac would use. When the two differ, a VPN took the route: the operator is told to allow access to the local network in the VPN app, and is offered the move of the subnet.
2. **The permission.** A TCP connection to the container's address and the API's port. "No route to host" (EHOSTUNREACH) in under a second while the route is on the bridge is macOS refusing the connection itself: the operator is told to turn on "container" in System Settings, Privacy & Security, Local Network.
3. **Inside.** `container exec` runs `/bin/bash` with its own `/dev/tcp` to ask the API's port for an HTTP status line. Every engine image has bash, because the engine's postprocess script needs it. 2.6 images have no Node.js, and the check does not rely on curl or any other tool. The operator is told whether the engine answers inside, and sees its log.

The checks run only from the Mac side except the last. They never change anything.

### The Local Network step

On a Mac where aidm-ui installs Apple's tool and the engine will use the published port, the step list has a step after the password: "Your approval: macOS asks whether "container" may find devices on your local network. Choose Allow." The tool asks when the first container with a published port starts, not when its service starts, so the step is current while the engine starts and done once it answers. aidm-ui never waits on it.

### The subnet

The tool reads its network's IPv4 subnet from `[network] subnet` in `~/.config/container/config.toml` (or under `$XDG_CONFIG_HOME`) when its service starts, and rebuilds the default network from it each time (1.6.1: `ContainerSystemConfig`, `APIServer+Start.swift`, `NetworksService`). There is no command to set it.

- Before the first start of a tool that aidm-ui installed, when there is no config.toml yet, aidm-ui picks the first of a short list of uncommon /24 ranges that nothing on the Mac uses. It reads the whole routing table (`netstat -rn -f inet`) and every interface (`ifconfig`). A candidate is out when another interface has an address in it or a route covers any part of it at /8 or longer, so a company VPN that routes all of 10.0.0.0/8 or 172.16.0.0/12 rules out every candidate there. Default routes and a VPN's 0/1 and 128.0/1 never rule one out: the tool's /24 is more specific than them.
- At every start of the engine, aidm-ui checks the tool's current subnet (`container network inspect default`) against the routes and interfaces again. A route of another interface at least as specific as the tool's own, or an address of another interface in it, is a conflict, and the page explains it.
- The subnet changes only when the operator asks, on a page that says it restarts the tool's service and every container on it. aidm-ui then sets the subnet in config.toml, keeping every other line, runs `container system stop` and `container system start`, and starts the engine again. A config.toml that was there before is never written without that request.

## Consequences

- Once a task API release has the socket option, the engine on a Mac does not depend on routes, VPNs or the Local Network permission, and the three checks and the Local Network step no longer apply to it.
- Until then, every way the Mac's network can cut off the engine that the second Mac test met has a message that names it and says what to do.
- aidm-ui writes into the tool's own config file, which other users of the tool share. It does so once before the tool's first start, and otherwise only when the operator asks.
- A VPN client that takes every network attached to the Mac when LAN access is off would take a moved subnet too. The move helps against a route or a network that uses the same addresses; the VPN setting is the fix for the rest.
- None of this was run on a Mac. The tool's behaviour comes from its source at 1.6.1, and the outputs of `route`, `netstat` and `ifconfig` in the tests are written in macOS's formats.
