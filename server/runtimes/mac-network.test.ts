import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  chooseSubnet,
  formatCidr,
  interfaceWithAddress,
  parseCidr,
  parseIfconfig,
  parseIpv4,
  parseNetstatDestination,
  parseNetstatRoutes,
  parseRouteGet,
  SUBNET_CANDIDATES,
  usesOf,
  type Cidr,
} from "./mac-network.ts";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "../../test-support/mac-network", name), "utf8");
const cidr = (text: string) => parseCidr(text) as Cidr;

test("netstat destinations follow BSD's short forms", () => {
  const shown = (text: string, flags = "UCS") => {
    const parsed = parseNetstatDestination(text, flags);
    return parsed === null ? null : formatCidr(parsed);
  };
  expect(shown("default", "UGScg")).toBe("0.0.0.0/0");
  expect(shown("127")).toBe("127.0.0.0/8");
  expect(shown("169.254")).toBe("169.254.0.0/16");
  expect(shown("192.168.64", "UC")).toBe("192.168.64.0/24");
  expect(shown("10.8/16")).toBe("10.8.0.0/16");
  expect(shown("172.16.0.0/12")).toBe("172.16.0.0/12");
  expect(shown("192.168.64.2", "UHLWIi")).toBe("192.168.64.2/32");
  expect(shown("192.168.1.1/32")).toBe("192.168.1.1/32");
  expect(shown("fe80::1%lo0")).toBeNull();
  expect(shown("link#20")).toBeNull();
});

test("the routing table of a Mac whose VPN took the tool's network", () => {
  const routes = parseNetstatRoutes(fixture("netstat-vpn-captured.txt"));
  const tool = routes.filter((route) => formatCidr(route.destination).startsWith("192.0.2."));
  expect(tool.map((route) => [formatCidr(route.destination), route.interface])).toEqual([
    ["192.0.2.0/24", "utun4"],
    ["192.0.2.0/24", "bridge100"],
    ["192.0.2.1/32", "bridge100"],
  ]);
});

test("netstat with the older Refs and Use columns is read by the header", () => {
  const text = [
    "Routing tables",
    "",
    "Internet:",
    "Destination        Gateway            Flags        Refs      Use   Netif Expire",
    "default            192.168.1.1        UGSc           91        0     en0",
    "10                 10.8.0.1           UGSc            0        0   utun2",
    "",
    "Internet6:",
    "Destination                             Gateway                         Flags         Netif Expire",
    "default                                 fe80::%utun0                    UGcIg         utun0",
  ].join("\n");
  expect(parseNetstatRoutes(text).map((route) => [formatCidr(route.destination), route.interface])).toEqual([
    ["0.0.0.0/0", "en0"],
    ["10.0.0.0/8", "utun2"],
  ]);
});

test("ifconfig gives each interface's IPv4 networks, and finds the tool's bridge by its gateway", () => {
  const interfaces = parseIfconfig(fixture("ifconfig.txt"));
  const named = (name: string) => interfaces.find((entry) => entry.name === name)?.addresses.map((entry) => formatCidr(entry.network));
  expect(named("en0")).toEqual(["192.168.1.0/24"]);
  expect(named("bridge100")).toEqual(["192.0.2.0/24"]);
  expect(named("utun4")).toEqual(["100.101.102.103/32"]);
  expect(interfaceWithAddress(interfaces, parseIpv4("192.0.2.1") as number)).toBe("bridge100");
  expect(interfaceWithAddress(interfaces, parseIpv4("10.1.1.1") as number)).toBeNull();
});

test("route -n get names the interface, so a route into a VPN's tunnel shows", () => {
  expect(parseRouteGet(fixture("route-get-bridge.txt"))).toEqual({ destination: "192.0.2.2", interface: "bridge100", gateway: null });
  expect(parseRouteGet(fixture("route-get-vpn.txt"))).toEqual({ destination: "192.0.2.0", interface: "utun4", gateway: "100.101.102.103" });
  expect(parseRouteGet("route: writing to routing socket: not in table\n")).toBeNull();
});

test("the tool's network is in use when a route of another interface wins over its bridge", () => {
  const table = { routes: parseNetstatRoutes(fixture("netstat-vpn-captured.txt")), interfaces: parseIfconfig(fixture("ifconfig.txt")) };
  expect(usesOf(cidr("192.0.2.0/24"), table, { ignore: ["bridge100"], winning: true })).toEqual([
    { kind: "route", network: "192.0.2.0/24", interface: "utun4" },
  ]);
  // The same Mac before the VPN reconnected: the bridge alone has the network.
  const healthy = { routes: parseNetstatRoutes(fixture("netstat-healthy.txt")), interfaces: table.interfaces };
  expect(usesOf(cidr("192.0.2.0/24"), healthy, { ignore: ["bridge100"], winning: true })).toEqual([]);
});

test("a default route, a VPN's 0/1 and 128.0/1 and multicast never rule out a network", () => {
  const routes = parseNetstatRoutes(
    [
      "Destination        Gateway            Flags               Netif Expire",
      "0/1                100.101.102.103    UGScg               utun4",
      "default            192.168.1.1        UGScg                 en0",
      "128.0/1            100.101.102.103    UGSc                utun4",
      "224.0.0/4          link#11            UmCS                  en0      !",
    ].join("\n"),
  );
  for (const candidate of SUBNET_CANDIDATES) expect(usesOf(cidr(candidate), { routes, interfaces: [] })).toEqual([]);
  expect(chooseSubnet({ routes, interfaces: [] })).toBe(SUBNET_CANDIDATES[0]);
});

test("a company VPN that routes all of 10.0.0.0/8 and the home network rule out the candidates inside them", () => {
  const routes = parseNetstatRoutes(
    [
      "Destination        Gateway            Flags               Netif Expire",
      "10                 10.8.0.1           UGSc                utun2",
      "172.16.0.0/12      10.8.0.1           UGSc                utun2",
      "192.168.213        link#11            UCS                   en0      !",
    ].join("\n"),
  );
  expect(chooseSubnet({ routes, interfaces: [] })).toBe("192.168.247.0/24");
  const everything = parseNetstatRoutes(
    [
      "Destination        Gateway            Flags               Netif Expire",
      "10                 10.8.0.1           UGSc                utun2",
      "172.16.0.0/12      10.8.0.1           UGSc                utun2",
      "192.168/16         10.8.0.1           UGSc                utun2",
    ].join("\n"),
  );
  expect(chooseSubnet({ routes: everything, interfaces: [] })).toBeNull();
});

test("an interface address in a candidate rules it out, and the tool's own bridge does not", () => {
  const interfaces = parseIfconfig(
    ["en7: flags=8863<UP,BROADCAST> mtu 1500", "\tinet 192.168.213.20 netmask 0xffffff00 broadcast 192.168.213.255", "bridge101: flags=8a63<UP> mtu 1500", "\tinet 192.168.247.1 netmask 0xffffff00 broadcast 192.168.247.255"].join(
      "\n",
    ),
  );
  expect(chooseSubnet({ routes: [], interfaces })).toBe("172.29.181.0/24");
  expect(chooseSubnet({ routes: [], interfaces }, { ignore: ["bridge101"] })).toBe("192.168.247.0/24");
  expect(chooseSubnet({ routes: [], interfaces: [] }, { avoid: ["192.168.213.0/24"] })).toBe("192.168.247.0/24");
});
