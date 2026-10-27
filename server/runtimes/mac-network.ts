/**
 * The Mac's own view of its IPv4 network, read from the text of `route -n get`,
 * `netstat -rn -f inet` and `ifconfig`, and the choice of a subnet for the
 * network of Apple's container tool that nothing else on the Mac uses (ADR 0006).
 * Nothing here runs a command: the callers pass the output in.
 */

/** An IPv4 network: the address as a 32-bit number with the host bits cleared, and the prefix length. */
export interface Cidr {
  base: number;
  prefix: number;
}

/** A route of the routing table. */
export interface MacRoute {
  destination: Cidr;
  /** The text of the gateway column, such as "192.168.1.1" or "link#20". */
  gateway: string;
  flags: string;
  interface: string;
}

/** One interface with its IPv4 addresses and their networks. */
export interface MacInterface {
  name: string;
  addresses: Array<{ address: number; network: Cidr }>;
}

/** What `route -n get <address>` says about the way to one address. */
export interface RouteAnswer {
  /** "default", or the route's destination as the tool prints it. */
  destination: string;
  interface: string;
  gateway: string | null;
}

/**
 * Uncommon /24 networks, tried in this order. None is the tool's default
 * (192.168.64.0/24), a home router's usual one, a Docker default or a range
 * a VPN client is known to take for itself. Each is checked against the
 * Mac's routes and interfaces before it is used: a company VPN that routes
 * all of 10.0.0.0/8 or 172.16.0.0/12 rules out every candidate in it.
 */
export const SUBNET_CANDIDATES = [
  "192.168.213.0/24",
  "192.168.247.0/24",
  "172.29.181.0/24",
  "172.27.143.0/24",
  "10.213.47.0/24",
  "10.157.92.0/24",
] as const;

/**
 * Routes shorter than this cover so much that every network overlaps them: a
 * default route, or a VPN's 0/1 and 128.0/1 pair. A /24 of the tool is more
 * specific than all of them, so they never take its traffic.
 */
const SHORTEST_COUNTED_PREFIX = 8;

export function parseIpv4(text: string): number | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

export function formatIpv4(value: number): string {
  return [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join(".");
}

function maskOf(prefix: number): number {
  return prefix === 0 ? 0 : (0xffffffff - (2 ** (32 - prefix) - 1)) >>> 0;
}

function network(address: number, prefix: number): Cidr {
  return { base: (address & maskOf(prefix)) >>> 0, prefix };
}

/** "10.213.47.0/24", or null for anything else. */
export function parseCidr(text: string): Cidr | null {
  const [address, prefixText, extra] = text.trim().split("/");
  if (address === undefined || prefixText === undefined || extra !== undefined || !/^\d{1,2}$/.test(prefixText)) return null;
  const value = parseIpv4(address);
  const prefix = Number(prefixText);
  if (value === null || prefix > 32) return null;
  return network(value, prefix);
}

export function formatCidr(cidr: Cidr): string {
  return `${formatIpv4(cidr.base)}/${cidr.prefix}`;
}

export function overlaps(a: Cidr, b: Cidr): boolean {
  const prefix = Math.min(a.prefix, b.prefix);
  return network(a.base, prefix).base === network(b.base, prefix).base;
}

export function containsAddress(cidr: Cidr, address: number): boolean {
  return network(address, cidr.prefix).base === cidr.base;
}

/** The classful mask BSD's netstat leaves out when a route has it (route.c, forgemask). */
function naturalPrefix(address: number): number {
  const first = Math.floor(address / 2 ** 24);
  if (first < 128) return 8;
  if (first < 192) return 16;
  if (first < 224) return 24;
  return 32;
}

/**
 * A destination as netstat prints it. Trailing zero octets are left out
 * ("192.168.64"), a mask is printed only when it is not the address's
 * classful one ("10.8/16", "172.16.0.0/12"), and a host route has no mask at
 * all (flag H). Null for anything else, such as an IPv6 or a link address.
 */
export function parseNetstatDestination(text: string, flags: string): Cidr | null {
  if (text === "default") return { base: 0, prefix: 0 };
  const [address, prefixText, extra] = text.split("/");
  if (address === undefined || extra !== undefined) return null;
  const parts = address.split(".");
  if (parts.length < 1 || parts.length > 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const value = parseIpv4([...parts, "0", "0", "0"].slice(0, 4).join("."));
  if (value === null) return null;
  if (prefixText !== undefined) {
    if (!/^\d{1,2}$/.test(prefixText) || Number(prefixText) > 32) return null;
    return network(value, Number(prefixText));
  }
  if (flags.includes("H")) return { base: value, prefix: 32 };
  return network(value, naturalPrefix(value));
}

/**
 * The IPv4 routes of `netstat -rn -f inet`. The columns are found from the
 * header line, since older macOS releases print Refs and Use between Flags
 * and Netif.
 */
export function parseNetstatRoutes(text: string): MacRoute[] {
  const lines = text.split("\n");
  const header = lines.findIndex((line) => /^Destination\s+Gateway\s+Flags/.test(line));
  if (header === -1) return [];
  const names = (lines[header] ?? "").trim().split(/\s+/);
  const flagsAt = names.indexOf("Flags");
  const netifAt = names.indexOf("Netif");
  if (flagsAt === -1 || netifAt === -1) return [];
  const routes: MacRoute[] = [];
  for (const line of lines.slice(header + 1)) {
    // A blank line or another table ("Internet6:") ends this one.
    if (line.trim() === "" || /^\S+:$/.test(line.trim())) break;
    const fields = line.trim().split(/\s+/);
    const flags = fields[flagsAt] ?? "";
    const destination = parseNetstatDestination(fields[0] ?? "", flags);
    const name = fields[netifAt];
    if (destination === null || name === undefined) continue;
    routes.push({ destination, gateway: fields[1] ?? "", flags, interface: name });
  }
  return routes;
}

/** The IPv4 addresses of each interface in `ifconfig`, with the network each one is on. */
export function parseIfconfig(text: string): MacInterface[] {
  const interfaces: MacInterface[] = [];
  let current: MacInterface | null = null;
  for (const line of text.split("\n")) {
    const start = /^([A-Za-z0-9]+):\s+flags=/.exec(line);
    if (start !== null) {
      current = { name: start[1] ?? "", addresses: [] };
      interfaces.push(current);
      continue;
    }
    const inet = /^\s+inet\s+(\d+\.\d+\.\d+\.\d+)(?:\s+-->\s+\S+)?\s+netmask\s+0x([0-9a-f]{8})/i.exec(line);
    if (inet === null || current === null) continue;
    const address = parseIpv4(inet[1] ?? "");
    if (address === null) continue;
    const mask = Number.parseInt(inet[2] ?? "", 16);
    const prefix = mask.toString(2).replace(/0+$/, "").length;
    current.addresses.push({ address, network: network(address, prefix) });
  }
  return interfaces;
}

/** The interface that holds an address, such as "bridge100" for the gateway of the tool's network. */
export function interfaceWithAddress(interfaces: MacInterface[], address: number): string | null {
  return interfaces.find((candidate) => candidate.addresses.some((entry) => entry.address === address))?.name ?? null;
}

/** The "key: value" lines of `route -n get`, or null when it names no interface. */
export function parseRouteGet(text: string): RouteAnswer | null {
  const field = (name: string) => new RegExp(`^\\s*${name}:\\s*(\\S+)`, "m").exec(text)?.[1] ?? null;
  const name = field("interface");
  if (name === null) return null;
  return { destination: field("destination") ?? "", interface: name, gateway: field("gateway") };
}

/** Something on the Mac that uses part of a network: a route through another interface, or an address of another interface. */
export interface SubnetUse {
  kind: "route" | "address";
  /** The route's destination or the address's network, as "a.b.c.d/n". */
  network: string;
  interface: string;
}

/**
 * Everything on the Mac that would fight with the tool's network over these
 * addresses, outside the interfaces named in `ignore` (the tool's own bridge).
 * A route counts when it is at least as specific as the network itself
 * (`winning`) or, for a network not in use yet, when it covers any part of it
 * at /8 or longer: a VPN that routes all of 10.0.0.0/8 would take a 10.x
 * network the moment the tool's bridge goes down and up.
 */
export function usesOf(
  subnet: Cidr,
  table: { routes: MacRoute[]; interfaces: MacInterface[] },
  options: { ignore?: string[]; winning?: boolean } = {},
): SubnetUse[] {
  const ignore = new Set(options.ignore ?? []);
  const uses: SubnetUse[] = [];
  for (const route of table.routes) {
    if (ignore.has(route.interface) || route.interface.startsWith("lo")) continue;
    if (route.destination.prefix < SHORTEST_COUNTED_PREFIX) continue;
    if (options.winning === true && route.destination.prefix < subnet.prefix) continue;
    // Multicast and broadcast are on every interface and carry no unicast traffic.
    if (route.destination.base >= 0xe0000000) continue;
    if (overlaps(route.destination, subnet)) uses.push({ kind: "route", network: formatCidr(route.destination), interface: route.interface });
  }
  for (const entry of table.interfaces) {
    if (ignore.has(entry.name) || entry.name.startsWith("lo")) continue;
    for (const address of entry.addresses) {
      if (overlaps(address.network, subnet)) uses.push({ kind: "address", network: formatCidr(address.network), interface: entry.name });
    }
  }
  return uses;
}

/** The first candidate nothing on the Mac uses, or null when every one of them is taken. */
export function chooseSubnet(
  table: { routes: MacRoute[]; interfaces: MacInterface[] },
  options: { ignore?: string[]; avoid?: string[] } = {},
): string | null {
  const avoid = new Set(options.avoid ?? []);
  for (const candidate of SUBNET_CANDIDATES) {
    if (avoid.has(candidate)) continue;
    const cidr = parseCidr(candidate) as Cidr;
    if (usesOf(cidr, table, { ignore: options.ignore }).length === 0) return candidate;
  }
  return null;
}
