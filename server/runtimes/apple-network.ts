import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import { dirname, join } from "node:path";
import type { ApiError } from "../../shared/api-error.ts";
import { excerpt, seconds } from "../app/diagnosis-log.ts";
import type { CommandRunner } from "../process/command-runner.ts";
import { APPLE_TOOL } from "./apple-container.ts";
import {
  chooseSubnet,
  formatCidr,
  formatIpv4,
  interfaceWithAddress,
  parseCidr,
  parseIfconfig,
  parseIpv4,
  parseNetstatRoutes,
  parseRouteGet,
  classifyRoute,
  type RouteKind,
  usesOf,
  type Cidr,
  type MacInterface,
  type MacRoute,
  type SubnetUse,
} from "./mac-network.ts";
import { asRecord, parseJson } from "./runtime.ts";

// macOS keeps these in the same place on every release.
const NETSTAT = "/usr/sbin/netstat";
const IFCONFIG = "/sbin/ifconfig";
const ROUTE = "/sbin/route";
const QUICK_TIMEOUT_MS = 10_000;
/** `system stop` stops every container on the tool, and each may take its time. */
const SYSTEM_STOP_TIMEOUT_MS = 120_000;
const SYSTEM_START_TIMEOUT_MS = 120_000;
/** How long the knock on the container's address waits. A refused permission fails at once. */
export const KNOCK_TIMEOUT_MS = 3000;

/** A TCP connection to an address, tried and closed again, with how long it took. */
export type Knock = { ok: true; ms: number } | { ok: false; code: string; ms: number };
export type Knocker = (address: string, port: number, timeoutMs: number) => Promise<Knock>;

export const knockTcp: Knocker = (address, port, timeoutMs) =>
  new Promise((resolve) => {
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    const socket = net.connect({ host: address, port });
    const done = (knock: Knock) => {
      socket.destroy();
      resolve(knock);
    };
    socket.setTimeout(timeoutMs, () => done({ ok: false, code: "timeout", ms: elapsed() }));
    socket.once("connect", () => done({ ok: true, ms: elapsed() }));
    socket.once("error", (error: NodeJS.ErrnoException) => done({ ok: false, code: error.code ?? error.message, ms: elapsed() }));
  });

/** What the published port did with one HTTP request: answered, reset the connection, said nothing in time, or something else. */
export type PortAnswer = "answers" | "reset" | "timeout" | `failed ${string}`;
export type PortProber = (hostPort: number) => Promise<PortAnswer>;

const PORT_TIMEOUT_MS = 5000;

export const probeHttpPort: PortProber = async (hostPort) => {
  try {
    const response = await fetch(`http://127.0.0.1:${hostPort}/info`, { signal: AbortSignal.timeout(PORT_TIMEOUT_MS), redirect: "manual" });
    await response.body?.cancel();
    return "answers";
  } catch (error) {
    const name = (error as { name?: unknown } | null)?.name;
    if (name === "TimeoutError" || name === "AbortError") return "timeout";
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "ECONNRESET" || /reset|closed unexpectedly/i.test(error instanceof Error ? error.message : "")) return "reset";
    return `failed ${typeof code === "string" ? code : error instanceof Error ? error.message : String(error)}`;
  }
};

/**
 * The table of ADR 0006, route first: what stands between the Mac and an
 * engine that runs. Null when the published port answers after all.
 */
export function decideConnection(route: RouteKind, inside: "answers" | "silent" | "unknown", published: PortAnswer | null): ApiError | null {
  if (route.kind === "away") return { code: "mac.vpn_route", data: { interface: route.interface, via: route.via } };
  if (route.kind === "loop") return { code: "mac.route_loop", data: { gateway: route.gateway } };
  if (inside === "silent") return { code: "mac.engine_not_answering", data: {} };
  if (published === "answers") return null;
  if (inside === "answers" && route.kind === "bridge" && published === "reset") return { code: "mac.local_network_denied", data: {} };
  return { code: "mac.engine_unreachable", data: { inside, port: published ?? "unknown" } };
}

/** The tool's own network as it runs now, and the interface of the Mac that carries it. */
export interface ToolNetwork {
  subnet: Cidr;
  gateway: number;
  /** For example "bridge100". Null when no interface of the Mac holds the gateway. */
  bridge: string | null;
}

export interface AppleNetworkDeps {
  runner: CommandRunner;
  log: (line: string) => void;
  /** Where the tool reads its configuration: `$XDG_CONFIG_HOME/container/config.toml`, else `~/.config/container/config.toml`. */
  configFile?: string;
  knock?: Knocker;
  /** Asks the published port on 127.0.0.1. Default: an HTTP request to the task API's /info. */
  probePort?: PortProber;
}

/** The tool's configuration file (1.6.1: PathUtils.BaseConfigPath.home). */
export function appleConfigFile(env: Record<string, string | undefined> = process.env, home = os.homedir()): string {
  const xdg = env.XDG_CONFIG_HOME;
  return join(xdg !== undefined && xdg !== "" ? xdg : join(home, ".config"), "container", "config.toml");
}

/**
 * The subnet `[network] subnet` sets in the tool's config.toml, or null when
 * there is none. Reads the plain form the tool documents (docs/networking.md)
 * and the dotted key `network.subnet` at the top.
 */
export function configuredSubnet(toml: string): string | null {
  let table = "";
  for (const line of toml.split("\n")) {
    const header = /^\s*\[\s*([^\]]+?)\s*\]\s*(#.*)?$/.exec(line);
    if (header !== null) {
      table = header[1] ?? "";
      continue;
    }
    const key = /^\s*([A-Za-z0-9_."-]+)\s*=\s*"([^"]*)"/.exec(line);
    if (key === null) continue;
    const name = table === "" ? key[1] : `${table}.${key[1]}`;
    if (name === "network.subnet") return key[2] ?? null;
  }
  return null;
}

/**
 * The text of config.toml with the subnet set and every other line kept: the
 * line that sets it now is replaced, else one goes under `[network]`, else a
 * `[network]` table is added at the end.
 */
export function withSubnet(toml: string, subnet: string): string {
  const lines = toml.split("\n");
  const setting = `subnet = "${subnet}"`;
  let table = "";
  let networkHeader = -1;
  for (const [index, line] of lines.entries()) {
    const header = /^\s*\[\s*([^\]]+?)\s*\]\s*(#.*)?$/.exec(line);
    if (header !== null) {
      table = header[1] ?? "";
      if (table === "network") networkHeader = index;
      continue;
    }
    if (table === "network" && /^\s*subnet\s*=/.test(line)) {
      lines[index] = setting;
      return lines.join("\n");
    }
    if (table === "" && /^\s*network\.subnet\s*=/.test(line)) {
      lines[index] = `network.${setting}`;
      return lines.join("\n");
    }
  }
  if (networkHeader !== -1) {
    lines.splice(networkHeader + 1, 0, setting);
    return lines.join("\n");
  }
  const body = toml === "" || toml.endsWith("\n") ? toml : `${toml}\n`;
  return `${body}${body === "" ? "" : "\n"}[network]\n${setting}\n`;
}

/**
 * The network of Apple's container tool seen from the Mac (ADR 0006): the
 * routing table, the tool's subnet and bridge, the three checks of an engine
 * that runs and does not answer, and the change of the subnet.
 */
export class AppleNetwork {
  private readonly configFile: string;
  private readonly knock: Knocker;
  private readonly probePort: PortProber;

  constructor(private readonly deps: AppleNetworkDeps) {
    this.configFile = deps.configFile ?? appleConfigFile();
    this.knock = deps.knock ?? knockTcp;
    this.probePort = deps.probePort ?? probeHttpPort;
  }

  /** The Mac's IPv4 routes and interfaces, or null when either command failed. */
  async table(): Promise<{ routes: MacRoute[]; interfaces: MacInterface[] } | null> {
    const [routes, interfaces] = await Promise.all([
      this.deps.runner.run([NETSTAT, "-rn", "-f", "inet"], { timeoutMs: QUICK_TIMEOUT_MS }),
      this.deps.runner.run([IFCONFIG], { timeoutMs: QUICK_TIMEOUT_MS }),
    ]);
    if (routes.exitCode !== 0 || interfaces.exitCode !== 0) return null;
    return { routes: parseNetstatRoutes(routes.stdout), interfaces: parseIfconfig(interfaces.stdout) };
  }

  /** The tool's default network as it runs (`container network inspect default`, the status part), or null. */
  async toolNetwork(interfaces?: MacInterface[]): Promise<ToolNetwork | null> {
    const result = await this.deps.runner.run([APPLE_TOOL, "network", "inspect", "default"], { timeoutMs: QUICK_TIMEOUT_MS });
    if (result.exitCode !== 0) return null;
    const parsed = parseJson(result.stdout);
    const status = asRecord(asRecord(Array.isArray(parsed) ? parsed[0] : parsed)?.status);
    const subnet = typeof status?.ipv4Subnet === "string" ? parseCidr(status.ipv4Subnet) : null;
    const gateway = typeof status?.ipv4Gateway === "string" ? parseIpv4(status.ipv4Gateway) : null;
    if (subnet === null || gateway === null) return null;
    const known = interfaces ?? (await this.table())?.interfaces ?? [];
    return { subnet, gateway, bridge: interfaceWithAddress(known, gateway) };
  }

  /** The subnet the tool's config.toml sets, or null when the file or the setting is missing. */
  configured(): string | null {
    try {
      return existsSync(this.configFile) ? configuredSubnet(readFileSync(this.configFile, "utf8")) : null;
    } catch {
      return null;
    }
  }

  /**
   * Before the first start of a tool that aidm-ui installed: picks a subnet
   * nothing on the Mac uses and writes it to the tool's config.toml. A
   * config.toml that is there already is the operator's, and is left as it is.
   */
  async prepareFirstStart(): Promise<void> {
    if (existsSync(this.configFile)) {
      this.deps.log(`Network: ${this.configFile} is there already, so the tool keeps the subnet it sets (${this.configured() ?? "none"}).`);
      return;
    }
    const table = await this.table();
    if (table === null) {
      this.deps.log("Network: the routing table could not be read, so the tool picks its own subnet.");
      return;
    }
    const subnet = chooseSubnet(table);
    if (subnet === null) {
      this.deps.log("Network: every subnet on the list is in use on this Mac, so the tool picks its own.");
      return;
    }
    try {
      this.write(`# The subnet of the containers of Apple's container tool. AIDM UI picked one that nothing else on this Mac uses.\n[network]\nsubnet = "${subnet}"\n`);
      this.deps.log(`Network: the tool's containers get the subnet ${subnet}, which no route or interface of this Mac uses.`);
    } catch (error) {
      this.deps.log(`Network: ${this.configFile} could not be written (${error instanceof Error ? error.message : String(error)}), so the tool picks its own subnet.`);
    }
  }

  /**
   * What on the Mac takes the tool's addresses now: a route of another
   * interface at least as specific as the tool's own, or another interface
   * with an address in it. Null when the tool's network cannot be read.
   */
  async conflicts(): Promise<{ network: ToolNetwork; uses: SubnetUse[] } | null> {
    const table = await this.table();
    if (table === null) return null;
    const network = await this.toolNetwork(table.interfaces);
    if (network === null) return null;
    const all = usesOf(network.subnet, table, { ignore: network.bridge === null ? [] : [network.bridge], winning: true });
    // Only another network with the same addresses is a collision a move can fix. A route of another
    // interface into the subnet is a VPN client's, and it takes whatever subnet sits on the bridge.
    const uses = all.filter((use) => use.kind === "address");
    const listed = all.map((use) => `${use.kind} ${use.network} on ${use.interface}`).join(", ");
    this.deps.log(
      `Network: the tool's subnet is ${formatCidr(network.subnet)} on ${network.bridge ?? "no interface of this Mac"}; ${all.length === 0 ? "nothing else uses it" : `also used by ${listed}${uses.length === 0 ? ", which is a route and no collision" : ""}`}.`,
    );
    return { network, uses };
  }

  /**
   * Moves the tool's network to a subnet nothing on the Mac uses. Only on the
   * operator's word: it stops the tool's service and every container on it,
   * and starts the service again. The caller starts the engine afterwards.
   */
  async move(): Promise<{ ok: true; subnet: string } | { ok: false; error: ApiError }> {
    const table = await this.table();
    if (table === null) return { ok: false, error: { code: "mac.network_unreadable", data: {} } };
    const current = await this.toolNetwork(table.interfaces);
    const subnet = chooseSubnet(table, {
      ignore: current?.bridge === null || current === null ? [] : [current.bridge],
      avoid: current === null ? [] : [formatCidr(current.subnet)],
    });
    if (subnet === null) return { ok: false, error: { code: "mac.no_free_subnet", data: {} } };
    try {
      const before = existsSync(this.configFile) ? readFileSync(this.configFile, "utf8") : "";
      this.write(withSubnet(before, subnet));
    } catch (error) {
      this.deps.log(`Network: ${this.configFile} could not be written: ${error instanceof Error ? error.message : String(error)}`);
      return { ok: false, error: { code: "mac.network_config_failed", data: {} } };
    }
    this.deps.log(`Network: moving the tool's containers from ${current === null ? "an unknown subnet" : formatCidr(current.subnet)} to ${subnet}. The tool's service stops and starts again.`);
    const stopped = await this.deps.runner.run([APPLE_TOOL, "system", "stop"], { timeoutMs: SYSTEM_STOP_TIMEOUT_MS });
    if (stopped.exitCode !== 0) {
      this.deps.log(`Network check failed: expected "container system stop" to exit 0, found exit ${stopped.exitCode}: ${excerpt(stopped.stderr || stopped.stdout)}`);
      return { ok: false, error: { code: "mac.network_restart_failed", data: { exitCode: stopped.exitCode } } };
    }
    const started = await this.deps.runner.run([APPLE_TOOL, "system", "start", "--disable-kernel-install"], { timeoutMs: SYSTEM_START_TIMEOUT_MS });
    if (started.exitCode !== 0) {
      this.deps.log(`Network check failed: expected "container system start" to exit 0, found exit ${started.exitCode}: ${excerpt(started.stderr || started.stdout)}`);
      return { ok: false, error: { code: "mac.network_restart_failed", data: { exitCode: started.exitCode } } };
    }
    return { ok: true, subnet };
  }

  /**
   * Why an engine container that runs does not answer on its published port,
   * or null when it answers now. ADR 0006 has the table; in short, route first:
   *
   * 1. the route to the container's address (`route -n get`) against the tool's
   *    bridge (the interface that holds the gateway, from `ifconfig`): another
   *    interface is a VPN client's work, and a gateway route on the bridge is a loop;
   * 2. the task API inside the container, asked with /bin/bash alone, which every
   *    engine image has (its postprocess script needs it): no answer there is the
   *    engine's own problem;
   * 3. the published port on 127.0.0.1: reset while the API answers inside and
   *    the route is right is macOS keeping "container" from the local network.
   *
   * A direct connection to the container's address is logged too, as
   * information only: it follows the Mac's route to the tool's network, so its
   * failures say nothing about the permission. Each step goes to the log.
   */
  async diagnose(container: string, port: number): Promise<ApiError | null> {
    const found = await this.containerAddress(container);
    let route: RouteKind = { kind: "unknown" };
    if (found === null) {
      this.deps.log(`Connection check: the address of ${container} could not be read.`);
    } else {
      const address = formatIpv4(found.address);
      const table = await this.table();
      const bridge = table === null ? null : interfaceWithAddress(table.interfaces, found.gateway);
      const routeResult = await this.deps.runner.run([ROUTE, "-n", "get", address], { timeoutMs: QUICK_TIMEOUT_MS });
      const answer = routeResult.exitCode === 0 ? parseRouteGet(routeResult.stdout) : null;
      route = classifyRoute(answer, bridge);
      this.deps.log(
        `Connection check 1 (route): ${address} goes through ${answer?.interface ?? "no route"}${answer?.gateway ? ` via ${answer.gateway}` : ""}${answer === null ? "" : ` <${answer.flags.join(",")}>`}; the tool's bridge is ${bridge ?? "not found"}: ${route.kind}.`,
      );
      const knock = await this.knock(address, port, KNOCK_TIMEOUT_MS);
      this.deps.log(
        `Connection check (direct, for information only): a connection to ${address}:${port} ${knock.ok ? "was answered" : `failed with ${knock.code}`} after ${seconds(knock.ms)}.`,
      );
    }
    const inside = await this.askInside(container, port);
    const published = found?.hostPort === null || found === null ? null : await this.probePort(found.hostPort);
    this.deps.log(`Connection check 3 (published port): ${published === null ? "not known" : `127.0.0.1:${found?.hostPort} ${published}`}.`);
    return decideConnection(route, inside, published);
  }

  /** The container's address, gateway and published port, from `container inspect`. */
  private async containerAddress(container: string): Promise<{ address: number; network: Cidr; gateway: number; hostPort: number | null } | null> {
    const result = await this.deps.runner.run([APPLE_TOOL, "inspect", container], { timeoutMs: QUICK_TIMEOUT_MS });
    if (result.exitCode !== 0) return null;
    const parsed = parseJson(result.stdout);
    const entry = asRecord(Array.isArray(parsed) ? parsed[0] : parsed);
    const status = asRecord(entry?.status);
    const first = asRecord(Array.isArray(status?.networks) ? status.networks[0] : undefined);
    const cidr = typeof first?.ipv4Address === "string" ? parseCidr(first.ipv4Address) : null;
    const address = typeof first?.ipv4Address === "string" ? parseIpv4(first.ipv4Address.split("/")[0] ?? "") : null;
    const gateway = typeof first?.ipv4Gateway === "string" ? parseIpv4(first.ipv4Gateway) : null;
    if (cidr === null || address === null || gateway === null) return null;
    const ports = asRecord(entry?.configuration)?.publishedPorts;
    const hostPort = asRecord(Array.isArray(ports) ? ports[0] : undefined)?.hostPort;
    return { address, network: cidr, gateway, hostPort: typeof hostPort === "number" ? hostPort : null };
  }

  /** Whether the task API answers inside the container: an HTTP status line from its port, read by bash alone. */
  private async askInside(container: string, port: number): Promise<"answers" | "silent" | "unknown"> {
    const script = `exec 3<>/dev/tcp/127.0.0.1/${port} && printf 'GET /info HTTP/1.0\\r\\nHost: localhost\\r\\n\\r\\n' >&3 && IFS= read -r -t 5 line <&3 && printf '%s\\n' "$line"`;
    const result = await this.deps.runner.run([APPLE_TOOL, "exec", container, "/bin/bash", "-c", script], { timeoutMs: QUICK_TIMEOUT_MS });
    const answer = result.exitCode === 0 && /^HTTP\/1\.[01] \d{3}/.test(result.stdout.trim()) ? "answers" : result.exitCode === 0 ? "silent" : null;
    // A bash that connected and read nothing, or a refused connection, is an API that is not there; a failed exec says nothing.
    const inside = answer ?? (/connection refused|connect:/i.test(result.stderr) ? "silent" : "unknown");
    this.deps.log(
      `Connection check 3 (inside the container): the task API ${inside === "answers" ? "answered" : inside === "silent" ? "did not answer" : "could not be asked"}: exit ${result.exitCode}, ${excerpt(result.stdout || result.stderr)}`,
    );
    return inside;
  }

  private write(text: string): void {
    mkdirSync(dirname(this.configFile), { recursive: true });
    const temporary = `${this.configFile}.aidm-ui-new`;
    writeFileSync(temporary, text);
    renameSync(temporary, this.configFile);
  }
}
