# Network outputs of a Mac

These files are written by hand in the formats of macOS's `netstat -rn -f inet`, `ifconfig` and `route -n get`. They are not recordings: the recording option of aidm-ui keeps runtime commands only, and the second Mac test ran these commands by hand. They follow what that test reported, with the tool's network written as 192.0.2.0/24, the range the recorded outputs use for addresses (the Mac had 192.168.64.0/24):

- the container at 192.0.2.2 on the tool's bridge, bridge100, with the gateway 192.0.2.1;
- after a VPN reconnect, a route for the tool's network into the VPN's tunnel, utun4, next to the bridge's own route.

The other addresses (the home network, the tunnel's address and the link addresses) are made up.

| File | What it shows |
| --- | --- |
| `netstat-healthy.txt` | The routing table while the engine answers. |
| `netstat-vpn-captured.txt` | The same table after the VPN took the tool's network. |
| `ifconfig.txt` | The interfaces, with the tool's bridge holding the gateway. |
| `route-get-bridge.txt` | The way to the container while it is on the bridge. |
| `route-get-vpn.txt` | The way to the container once the VPN took it. |
| `network-inspect-default.txt` | `container network inspect default`, in the shape of the tool's source at 1.6.1 (`NetworkResource`, `NetworkStatus`): the subnet and the gateway the network runs with. Only the status part is read. |

Replace them with real outputs from a Mac when a test records them.
