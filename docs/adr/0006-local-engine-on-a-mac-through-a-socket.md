---
status: accepted
date: 2026-10-27
amended: 2026-10-27, after the third Mac test, for the checks and the subnet
---

# The local engine on a Mac is reached through a socket, and explains itself when it cannot be

An operator must never be left with a local engine that runs and cannot be reached, with no hint why. On a Mac, the connection should not depend on the IP network at all where that can be done. This changes how aidm-ui reaches the engine in Apple's container tool. Docker and Podman keep the published port.

## Why

The second install on a real Mac (Apple M5 Pro, 24 GiB, macOS 27.0, Apple's tool 1.6.1) ran a whole job, over a slow, unstable mobile link with a VPN client using an exit node. Twice the engine ran and aidm-ui could not reach it:

1. macOS asked whether "container" may find devices on the local network, and the answer was no. Every connection to the published port 127.0.0.1:<port> was reset (ECONNRESET). `ping` and `curl` to the container's address, 192.168.64.2, failed at once with "No route to host", and `route -n get` showed the tool's bridge (bridge100). Inside the container the API answered. Turning the permission on fixed it with no restart.
2. After 18 minutes, at a VPN reconnect, polls timed out after 10 s. The VPN client had put a route for the tool's subnet somewhere else (below).

The third Mac test, the same day, looked at the routing table at each step. With the exit node on and subnet routes off:

- LAN access off: a static route for the whole subnet into the tunnel, `192.168.64  link#26  UCS  utun4`. Polls time out.
- LAN access on: a static route for the subnet towards the home router on the physical interface, `192.168.64  192.168.178.1  UGSc  en0`. A direct connection to the container is refused at once by the router, and the published port times out.
- The client rewrote that route at each of its reconnects, about every 10 minutes on that link, so a repair by hand lasted until the next one.
- A host route added by hand into the tunnel (`route add -host <container> -interface utun4`) broke nothing, so it does not reproduce the problem.
- A gateway route through the bridge's own address (`route add -net 192.168.64.0/24 192.168.64.1`) makes a loop: ping answers "Time to live exceeded" from 192.168.64.1. It seemed to work only for a container that already had a link-layer entry on the bridge. A direct route on the bridge (`-interface 192.168.64.1`) is right.

With the route right and the permission off, the published port reset every connection while the API answered inside; with the permission on, it answered. A direct connection from the Mac to the container's address follows the Mac's route to the tool's subnet, which was wrong again and again, so its failures said nothing about the permission. The first version of the checks below used it as evidence for the permission and named the wrong cause.

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

### Until then: what stands between the Mac and the engine

When the engine container runs and the task API does not answer from the Mac, aidm-ui looks every five seconds until it answers again, so a setting the operator changes shows without a click. Each look goes to the diagnosis log. The route comes first:

| Route to the container's address | API inside | Published port | Message |
| --- | --- | --- | --- |
| not on the tool's bridge: a tunnel interface, or the physical interface towards the home router | any | any failure | A VPN on this Mac changed the route to the engine's network |
| on the bridge, but a gateway route through the bridge's own address | any | any failure | The route to the engine's network loops |
| on the bridge, direct | answers | reset | macOS keeps "container" from the local network, with where to turn it on |
| on the bridge, direct | answers | timeout or another failure | Not known, with the engine's log |
| any | does not answer | any | The engine has a problem, with its log |

- **The route.** `container inspect` gives the container's address, gateway and published port, `ifconfig` the interface that holds the gateway (the tool's bridge), and `route -n get <address>` the interface, the gateway and the flags the Mac would use. A tunnel interface (`utun`, `ipsec`, `ppp`) or another interface is a VPN client's route; a `GATEWAY` route on the bridge is the loop.
- **Inside.** `container exec` runs `/bin/bash` with its own `/dev/tcp` to ask the API's port for an HTTP status line. Every engine image has bash, because the engine's postprocess script needs it. 2.6 images have no Node.js, and the check does not rely on curl or any other tool.
- **The published port.** One HTTP request to `127.0.0.1:<port>`: an answer, a reset, a timeout or another failure. An answer means nothing is in the way any more.
- **The direct connection** to the container's address is still made and logged, as information only. It decides nothing.

The VPN message says in plain words what the client did (into its tunnel, or towards the router) and the one setting to try: the exit node off while the local engine is used. It never gives route commands, and it says that moving the subnet does not help. While a message is shown for the local engine, the page leaves out the general "No engine answered at this address" note. The checks run from the Mac side except the one inside, and never change anything.

### The Local Network step

On a Mac where aidm-ui installs Apple's tool and the engine will use the published port, the step list has a step after the password: "Your approval: macOS asks whether "container" may find devices on your local network. Choose Allow." The tool asks when the first container with a published port starts, not when its service starts, so the step is current while the engine starts and done once it answers. aidm-ui never waits on it.

### The subnet

The tool reads its network's IPv4 subnet from `[network] subnet` in `~/.config/container/config.toml` (or under `$XDG_CONFIG_HOME`) when its service starts, and rebuilds the default network from it each time (1.6.1: `ContainerSystemConfig`, `APIServer+Start.swift`, `NetworksService`). There is no command to set it.

- Before the first start of a tool that aidm-ui installed, when there is no config.toml yet, aidm-ui picks the first of a short list of uncommon /24 ranges that nothing on the Mac uses. It reads the whole routing table (`netstat -rn -f inet`) and every interface (`ifconfig`). A candidate is out when another interface has an address in it or a route covers any part of it at /8 or longer, so a company VPN that routes all of 10.0.0.0/8 or 172.16.0.0/12 rules out every candidate there. Default routes and a VPN's 0/1 and 128.0/1 never rule one out: the tool's /24 is more specific than them.
- At every start of the engine, aidm-ui checks the tool's current subnet (`container network inspect default`) against the routes and interfaces again. Another interface with an address in it is a conflict: two networks use the same addresses, and the page explains it and offers the move. A route of another interface into the subnet is a VPN client's, and is no conflict: the client takes whatever subnet sits on the bridge, so a move would not help. The diagnosis above names it instead.
- The subnet changes only when the operator asks, on a page that says it restarts the tool's service and every container on it. aidm-ui then sets the subnet in config.toml, keeping every other line, runs `container system stop` and `container system start`, and starts the engine again. A config.toml that was there before is never written without that request.

## Consequences

- Once a task API release has the socket option, the engine on a Mac does not depend on routes, VPNs or the Local Network permission, and the three checks and the Local Network step no longer apply to it.
- Until then, a Mac behind a VPN client with an exit node loses its engine at the client's reconnects, which on the test link came about every 10 minutes. aidm-ui can only explain it: the engine runs, the client's route is wrong, and the exit node off is the one setting to try.
- aidm-ui writes into the tool's own config file, which other users of the tool share. It does so once before the tool's first start, and otherwise only when the operator asks.
- The subnet move is for a real collision only: another network on the Mac with the same addresses. Against the VPN client of the tests it does nothing, because the client claimed whatever subnet sat on the bridge.
- None of this was run on a Mac by aidm-ui's tests. The tool's behaviour comes from its source at 1.6.1, and the routing tables in the tests are the ones the Mac tests saw, written in macOS's formats.
