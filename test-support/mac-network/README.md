# Network outputs of a Mac

The routing tables here are the ones the Mac tests saw, written by hand in the formats of macOS's `netstat -rn -f inet`, `ifconfig` and `route -n get`. The recording option of aidm-ui keeps runtime commands only, and the tests ran these commands by hand. The tool's network is its usual 192.168.64.0/24, with the gateway 192.168.64.1 on bridge100 and the container at 192.168.64.2. The VPN client's tunnel is utun4, and the home router is 192.168.178.1 on en0. The tunnel's own address, the Mac's address on the home network and the link addresses are made up.

| File | What it shows |
| --- | --- |
| `netstat-healthy.txt` | The routing table while the engine answers: the tool's subnet on the bridge. |
| `netstat-vpn-lan-off.txt` | A VPN client with an exit node and LAN access off: a static route for the whole subnet into its tunnel. |
| `netstat-vpn-lan-on.txt` | The same client with LAN access on: a static route for the subnet towards the home router on en0. |
| `netstat-route-loop.txt` | A gateway route through the bridge's own address, as a repair by hand left it. Packets go round until their time to live runs out. |
| `ifconfig.txt` | The interfaces, with the tool's bridge holding the gateway. |
| `route-get-bridge.txt` | The way to the container while it is on the bridge. |
| `route-get-vpn-lan-off.txt` | The way to the container into the tunnel. |
| `route-get-vpn-lan-on.txt` | The way to the container towards the home router. |
| `route-get-loop.txt` | The way to the container through the bridge's own address. |
| `network-inspect-default.txt` | `container network inspect default`, in the shape of the tool's source at 1.6.1 (`NetworkResource`, `NetworkStatus`). Only the status part is read. |
| `container-inspect.txt` | `container inspect aidm-local-engine` from the recording of the second Mac test, with its MAC and IPv6 addresses set to placeholders. It names the published port, 54794. |

Replace them with real outputs from a Mac when a test records them.
