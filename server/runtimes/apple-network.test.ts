// The checks of an engine that runs on a Mac and does not answer, and the
// subnet of the network of Apple's container tool (ADR 0006). The commands
// answer with the recorded `container inspect` of the second Mac test, and
// with the routing tables seen on that Mac, written in macOS's formats.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedRunner, type ScriptedRule } from "../../test-support/scripted-runner.ts";
import type { CommandResult } from "../process/command-runner.ts";
import { APPLE_TOOL } from "./apple-container.ts";
import { AppleNetwork, appleConfigFile, configuredSubnet, decideConnection, knockTcp, withSubnet, type Knock, type PortAnswer } from "./apple-network.ts";

const network = (name: string): CommandResult => ({
  exitCode: 0,
  stdout: readFileSync(join(import.meta.dir, "../../test-support/mac-network", name), "utf8"),
  stderr: "",
});
const INSPECT = [APPLE_TOOL, "inspect", "aidm-local-engine"];
const ROUTE = ["/sbin/route", "-n", "get", "192.168.64.2"];
const NETSTAT = ["/usr/sbin/netstat", "-rn", "-f", "inet"];
const IFCONFIG = ["/sbin/ifconfig"];
const NETWORK = [APPLE_TOOL, "network", "inspect", "default"];
const STOP = [APPLE_TOOL, "system", "stop"];
const START = [APPLE_TOOL, "system", "start", "--disable-kernel-install"];
const ok: CommandResult = { exitCode: 0, stdout: "", stderr: "" };
const ANSWERS: CommandResult = { exitCode: 0, stdout: "HTTP/1.1 200 OK\r\n", stderr: "" };
const REFUSED: CommandResult = { exitCode: 1, stdout: "", stderr: "bash: connect: Connection refused\nbash: line 1: /dev/tcp/127.0.0.1/3000: Connection refused\n" };

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function setup(rules: ScriptedRule[], options: { knock?: Knock; port?: PortAnswer } = {}) {
  const folder = mkdtempSync(join(tmpdir(), "aidm-apple-network-"));
  folders.push(folder);
  const runner = new ScriptedRunner(rules);
  const lines: string[] = [];
  const knocks: string[] = [];
  const probed: number[] = [];
  const configFile = join(folder, "container", "config.toml");
  const apple = new AppleNetwork({
    runner,
    log: (line) => lines.push(line),
    configFile,
    knock: async (address, port) => {
      knocks.push(`${address}:${port}`);
      return options.knock ?? { ok: false, code: "ECONNREFUSED", ms: 1 };
    },
    probePort: async (hostPort) => {
      probed.push(hostPort);
      return options.port ?? "reset";
    },
  });
  return { apple, runner, lines, knocks, probed, configFile };
}

/** The Mac while the engine container runs: the recorded inspect, and the routing table and route given. */
function theMac(routes: string, route: string, inside: CommandResult = ANSWERS): ScriptedRule[] {
  return [
    { argv: INSPECT, result: network("container-inspect.txt") },
    { argv: NETSTAT, result: network(routes) },
    { argv: IFCONFIG, result: network("ifconfig.txt") },
    { argv: ROUTE, result: network(route) },
    { argv: NETWORK, result: network("network-inspect-default.txt") },
    { argv: [APPLE_TOOL, "exec", "aidm-local-engine", "/bin/bash", "-c", insideScript()], result: inside },
  ];
}

function insideScript(): string {
  return `exec 3<>/dev/tcp/127.0.0.1/3000 && printf 'GET /info HTTP/1.0\\r\\nHost: localhost\\r\\n\\r\\n' >&3 && IFS= read -r -t 5 line <&3 && printf '%s\\n' "$line"`;
}

// The table of ADR 0006, route first, one row at a time.

test("the subnet in the VPN's tunnel (LAN access off) is the VPN, whatever the rest says", async () => {
  const { apple, lines } = setup(theMac("netstat-vpn-lan-off.txt", "route-get-vpn-lan-off.txt"), { port: "timeout" });
  expect(await apple.diagnose("aidm-local-engine", 3000)).toEqual({ code: "mac.vpn_route", data: { interface: "utun4", via: "tunnel" } });
  expect(lines).toContain("Connection check 1 (route): 192.168.64.2 goes through utun4 <UP,DONE,STATIC,PRCLONING>; the tool's bridge is bridge100: away.");
});

test("the subnet towards the home router (LAN access on) is the VPN too, with the router said", async () => {
  const { apple } = setup(theMac("netstat-vpn-lan-on.txt", "route-get-vpn-lan-on.txt"), { port: "timeout", knock: { ok: false, code: "ECONNREFUSED", ms: 3 } });
  expect(await apple.diagnose("aidm-local-engine", 3000)).toEqual({ code: "mac.vpn_route", data: { interface: "en0", via: "router" } });
});

test("a gateway route through the bridge's own address is a loop", async () => {
  const { apple } = setup(theMac("netstat-route-loop.txt", "route-get-loop.txt"));
  expect(await apple.diagnose("aidm-local-engine", 3000)).toEqual({ code: "mac.route_loop", data: { gateway: "192.168.64.1" } });
});

test("the route right, the API answering inside and the published port reset is the Local Network permission", async () => {
  // The second Mac test: the direct connection was refused in no time, and the permission was the cause all the same.
  const { apple, lines, probed } = setup(theMac("netstat-healthy.txt", "route-get-bridge.txt"), { port: "reset", knock: { ok: false, code: "ECONNREFUSED", ms: 0 } });
  expect(await apple.diagnose("aidm-local-engine", 3000)).toEqual({ code: "mac.local_network_denied", data: {} });
  expect(probed).toEqual([54794]);
  expect(lines).toContain("Connection check (direct, for information only): a connection to 192.168.64.2:3000 failed with ECONNREFUSED after 0.0 s.");
  expect(lines).toContain("Connection check 3 (published port): 127.0.0.1:54794 reset.");
});

test("the direct connection never decides: answered or refused, the published port does", async () => {
  for (const knock of [{ ok: true, ms: 1 } as const, { ok: false, code: "EHOSTUNREACH", ms: 1 } as const]) {
    const { apple } = setup(theMac("netstat-healthy.txt", "route-get-bridge.txt"), { port: "reset", knock });
    expect((await apple.diagnose("aidm-local-engine", 3000))?.code).toBe("mac.local_network_denied");
  }
});

test("the route right, the API answering inside and the port timing out is not known, and the log is shown", async () => {
  const { apple } = setup(theMac("netstat-healthy.txt", "route-get-bridge.txt"), { port: "timeout" });
  expect(await apple.diagnose("aidm-local-engine", 3000)).toEqual({ code: "mac.engine_unreachable", data: { inside: "answers", port: "timeout" } });
});

test("an API that does not answer inside is the engine's problem, with the route right or not on the bridge", async () => {
  const { apple, runner } = setup(theMac("netstat-healthy.txt", "route-get-bridge.txt", REFUSED));
  expect(await apple.diagnose("aidm-local-engine", 3000)).toEqual({ code: "mac.engine_not_answering", data: {} });
  // Inside, only bash and its own /dev/tcp: 2.6 images have no Node.js, and curl is not relied on.
  const exec = runner.calls.find((argv) => argv.includes("exec")) ?? [];
  expect(exec.slice(0, 5)).toEqual([APPLE_TOOL, "exec", "aidm-local-engine", "/bin/bash", "-c"]);
  expect(exec.join(" ")).not.toMatch(/\b(node|curl|wget|python3?|perl)\b/);
});

test("a published port that answers after all is no problem", async () => {
  const { apple } = setup(theMac("netstat-healthy.txt", "route-get-bridge.txt"), { port: "answers" });
  expect(await apple.diagnose("aidm-local-engine", 3000)).toBeNull();
});

test("an exec that fails cannot tell whether the API answers inside, and the log is shown", async () => {
  const missing = { exitCode: 1, stdout: "", stderr: 'Error: internalError: "vmexec error: failed to find target executable /bin/bash"\n' };
  const { apple } = setup(theMac("netstat-healthy.txt", "route-get-bridge.txt", missing), { port: "reset" });
  expect(await apple.diagnose("aidm-local-engine", 3000)).toEqual({ code: "mac.engine_unreachable", data: { inside: "unknown", port: "reset" } });
});

test("the decision follows the table for every combination", () => {
  const away = { kind: "away", interface: "utun4", via: "tunnel", gateway: null } as const;
  const loop = { kind: "loop", gateway: "192.168.64.1" } as const;
  const bridge = { kind: "bridge" } as const;
  const unknown = { kind: "unknown" } as const;
  for (const inside of ["answers", "silent", "unknown"] as const) {
    for (const port of ["answers", "reset", "timeout", "failed ECONNREFUSED"] as const) {
      expect(decideConnection(away, inside, port)?.code).toBe("mac.vpn_route");
      expect(decideConnection(loop, inside, port)?.code).toBe("mac.route_loop");
    }
  }
  expect(decideConnection(bridge, "answers", "reset")?.code).toBe("mac.local_network_denied");
  expect(decideConnection(bridge, "answers", "timeout")?.code).toBe("mac.engine_unreachable");
  expect(decideConnection(bridge, "answers", "failed ECONNREFUSED")?.code).toBe("mac.engine_unreachable");
  expect(decideConnection(bridge, "silent", "reset")?.code).toBe("mac.engine_not_answering");
  // Without the route, a reset is not taken for the permission.
  expect(decideConnection(unknown, "answers", "reset")?.code).toBe("mac.engine_unreachable");
  expect(decideConnection(bridge, "answers", "answers")).toBeNull();
});

test("the tool's config file is under XDG_CONFIG_HOME when it is set, else under ~/.config", () => {
  expect(appleConfigFile({ XDG_CONFIG_HOME: "/x/config" }, "/Users/operator")).toBe("/x/config/container/config.toml");
  expect(appleConfigFile({}, "/Users/operator")).toBe("/Users/operator/.config/container/config.toml");
  expect(appleConfigFile({ XDG_CONFIG_HOME: "" }, "/Users/operator")).toBe("/Users/operator/.config/container/config.toml");
});

test("the subnet is read from [network] or the dotted key, and set with every other line kept", () => {
  const text = '# mine\n[build]\nrosetta = true\n\n[network]\nsubnetv6 = "fd00:abcd::/64"\nsubnet = "192.168.100.1/24"\n';
  expect(configuredSubnet(text)).toBe("192.168.100.1/24");
  expect(configuredSubnet('network.subnet = "10.1.2.0/24"\n')).toBe("10.1.2.0/24");
  expect(configuredSubnet('[build]\nsubnet = "10.1.2.0/24"\n')).toBeNull();
  expect(withSubnet(text, "192.168.213.0/24")).toBe(text.replace('subnet = "192.168.100.1/24"', 'subnet = "192.168.213.0/24"'));
  expect(withSubnet('[network]\nsubnetv6 = "fd00::/64"\n', "10.213.47.0/24")).toBe('[network]\nsubnet = "10.213.47.0/24"\nsubnetv6 = "fd00::/64"\n');
  expect(withSubnet("[build]\nrosetta = true", "10.213.47.0/24")).toBe('[build]\nrosetta = true\n\n[network]\nsubnet = "10.213.47.0/24"\n');
  expect(withSubnet("", "10.213.47.0/24")).toBe('[network]\nsubnet = "10.213.47.0/24"\n');
});

test("before the first start a subnet nothing on the Mac uses is written, and a config file that is there stays as it is", async () => {
  const fresh = setup([
    { argv: NETSTAT, result: network("netstat-healthy.txt") },
    { argv: IFCONFIG, result: network("ifconfig.txt") },
  ]);
  await fresh.apple.prepareFirstStart();
  expect(configuredSubnet(readFileSync(fresh.configFile, "utf8"))).toBe("192.168.213.0/24");
  expect(fresh.lines).toContain("Network: the tool's containers get the subnet 192.168.213.0/24, which no route or interface of this Mac uses.");

  const theirs = setup([]);
  await Bun.write(theirs.configFile, "[build]\nrosetta = true\n");
  await theirs.apple.prepareFirstStart();
  expect(readFileSync(theirs.configFile, "utf8")).toBe("[build]\nrosetta = true\n");
  expect(theirs.runner.calls).toEqual([]);
});

test("a VPN client's route into the tool's subnet is no collision, and another network with the same addresses is", async () => {
  const healthy = setup(theMac("netstat-healthy.txt", "route-get-bridge.txt"));
  expect((await healthy.apple.conflicts())?.uses).toEqual([]);
  const captured = setup(theMac("netstat-vpn-lan-off.txt", "route-get-vpn-lan-off.txt"));
  const found = await captured.apple.conflicts();
  expect(found?.network.bridge).toBe("bridge100");
  expect(found?.uses).toEqual([]);
  expect(captured.lines.at(-1)).toBe(
    "Network: the tool's subnet is 192.168.64.0/24 on bridge100; also used by route 192.168.64.0/24 on utun4, which is a route and no collision.",
  );
  // A second network adapter on a LAN that uses the same addresses.
  const ifconfig = readFileSync(join(import.meta.dir, "../../test-support/mac-network/ifconfig.txt"), "utf8") + "en7: flags=8863<UP,BROADCAST> mtu 1500\n\tinet 192.168.64.20 netmask 0xffffff00 broadcast 192.168.64.255\n";
  const collision = setup([...theMac("netstat-healthy.txt", "route-get-bridge.txt").filter((rule) => rule.argv !== IFCONFIG), { argv: IFCONFIG, result: { exitCode: 0, stdout: ifconfig, stderr: "" } }]);
  expect((await collision.apple.conflicts())?.uses).toEqual([{ kind: "address", network: "192.168.64.0/24", interface: "en7" }]);
});

test("the move writes a free subnet into the config file, keeps the rest of it, and restarts the tool's service", async () => {
  const { apple, runner, configFile } = setup([
    ...theMac("netstat-vpn-lan-off.txt", "route-get-vpn-lan-off.txt"),
    { argv: STOP, result: ok },
    { argv: START, result: ok },
  ]);
  await Bun.write(configFile, "[build]\nrosetta = true\n");
  expect(await apple.move()).toEqual({ ok: true, subnet: "192.168.213.0/24" });
  expect(readFileSync(configFile, "utf8")).toBe('[build]\nrosetta = true\n\n[network]\nsubnet = "192.168.213.0/24"\n');
  expect(runner.calls.filter((argv) => argv.includes("system"))).toEqual([STOP, START]);
});

test("a service that does not stop leaves the move half done, with its own message", async () => {
  const { apple, configFile } = setup([
    ...theMac("netstat-vpn-lan-off.txt", "route-get-vpn-lan-off.txt"),
    { argv: STOP, result: { exitCode: 1, stdout: "", stderr: "Error: timeout" } },
  ]);
  expect(await apple.move()).toEqual({ ok: false, error: { code: "mac.network_restart_failed", data: { exitCode: 1 } } });
  expect(existsSync(configFile)).toBe(true);
});

test("the knock on an address tells a refused port from one that answers", async () => {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  try {
    expect((await knockTcp("127.0.0.1", server.port, 2000)).ok).toBe(true);
  } finally {
    server.stop(true);
  }
  const closed = await knockTcp("127.0.0.1", server.port, 2000);
  expect(closed).toMatchObject({ ok: false, code: "ECONNREFUSED" });
});
