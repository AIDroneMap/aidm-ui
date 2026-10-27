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
/** A failure faster than this did not wait for the network: macOS refused the connection itself. */
const AT_ONCE_MS = 1000;

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

  constructor(private readonly deps: AppleNetworkDeps) {
    this.configFile = deps.configFile ?? appleConfigFile();
    this.knock = deps.knock ?? knockTcp;
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
    const uses = usesOf(network.subnet, table, { ignore: network.bridge === null ? [] : [network.bridge], winning: true });
    const listed = uses.map((use) => `${use.kind} ${use.network} on ${use.interface}`).join(", ");
    this.deps.log(
      `Network: the tool's subnet is ${formatCidr(network.subnet)} on ${network.bridge ?? "no interface of this Mac"}; ${uses.length === 0 ? "nothing else uses it" : `also used by ${listed}`}.`,
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
   * found with three checks, all from the Mac but the last one:
   *
   * 1. the route to the container's address leaves through another interface
   *    than the tool's bridge: a VPN took it;
   * 2. a connection to the container's address fails at once with "No route
   *    to host" while the route is right: macOS's Local Network permission;
   * 3. else the task API is asked inside the container with /bin/bash alone,
   *    which every engine image has (its postprocess script needs it).
   *
   * Each step goes to the diagnosis log.
   */
  async diagnose(container: string, port: number): Promise<ApiError> {
    const found = await this.containerAddress(container);
    if (found === null) {
      this.deps.log(`Connection check: the address of ${container} could not be read.`);
      return { code: "mac.engine_unreachable", data: { inside: await this.askInside(container, port) } };
    }
    const table = await this.table();
    const bridge = table === null ? null : interfaceWithAddress(table.interfaces, found.gateway);
    const routeResult = await this.deps.runner.run([ROUTE, "-n", "get", formatIpv4(found.address)], { timeoutMs: QUICK_TIMEOUT_MS });
    const route = routeResult.exitCode === 0 ? parseRouteGet(routeResult.stdout) : null;
    const address = formatIpv4(found.address);
    this.deps.log(
      `Connection check 1 (route): ${address} goes through ${route?.interface ?? "no route"}${route?.gateway ? ` via ${route.gateway}` : ""}; the tool's bridge is ${bridge ?? "not found"}.`,
    );
    if (route !== null && bridge !== null && route.interface !== bridge) {
      return { code: "mac.vpn_route", data: { address, interface: route.interface, bridge, subnet: formatCidr(found.network) } };
    }

    const knock = await this.knock(address, port, KNOCK_TIMEOUT_MS);
    this.deps.log(`Connection check 2 (direct): a connection to ${address}:${port} ${knock.ok ? "was answered" : `failed with ${knock.code}`} after ${seconds(knock.ms)}.`);
    if (!knock.ok && knock.code === "EHOSTUNREACH" && knock.ms < AT_ONCE_MS && (bridge === null || route?.interface === bridge)) {
      return { code: "mac.local_network_denied", data: { address } };
    }

    return { code: "mac.engine_unreachable", data: { inside: await this.askInside(container, port) } };
  }

  /** The container's address and gateway on the tool's network, from `container inspect`. */
  private async containerAddress(container: string): Promise<{ address: number; network: Cidr; gateway: number } | null> {
    const result = await this.deps.runner.run([APPLE_TOOL, "inspect", container], { timeoutMs: QUICK_TIMEOUT_MS });
    if (result.exitCode !== 0) return null;
    const parsed = parseJson(result.stdout);
    const status = asRecord(asRecord(Array.isArray(parsed) ? parsed[0] : parsed)?.status);
    const first = asRecord(Array.isArray(status?.networks) ? status.networks[0] : undefined);
    const cidr = typeof first?.ipv4Address === "string" ? parseCidr(first.ipv4Address) : null;
    const address = typeof first?.ipv4Address === "string" ? parseIpv4(first.ipv4Address.split("/")[0] ?? "") : null;
    const gateway = typeof first?.ipv4Gateway === "string" ? parseIpv4(first.ipv4Gateway) : null;
    if (cidr === null || address === null || gateway === null) return null;
    return { address, network: cidr, gateway };
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
