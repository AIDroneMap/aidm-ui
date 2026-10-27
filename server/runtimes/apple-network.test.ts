// The checks of an engine that runs on a Mac and does not answer, and the
// subnet of the network of Apple's container tool (ADR 0006). The commands
// answer with the outputs of the second Mac test: the recorded `container
// inspect`, and route, netstat and ifconfig written in macOS's formats.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recorded, ScriptedRunner, type ScriptedRule } from "../../test-support/scripted-runner.ts";
import type { CommandResult } from "../process/command-runner.ts";
import { APPLE_TOOL } from "./apple-container.ts";
import { AppleNetwork, appleConfigFile, configuredSubnet, knockTcp, withSubnet, type Knock } from "./apple-network.ts";

const network = (name: string): CommandResult => ({
  exitCode: 0,
  stdout: readFileSync(join(import.meta.dir, "../../test-support/mac-network", name), "utf8"),
  stderr: "",
});
const INSPECT = [APPLE_TOOL, "inspect", "aidm-local-engine"];
const ROUTE = ["/sbin/route", "-n", "get", "192.0.2.2"];
const NETSTAT = ["/usr/sbin/netstat", "-rn", "-f", "inet"];
const IFCONFIG = ["/sbin/ifconfig"];
const NETWORK = [APPLE_TOOL, "network", "inspect", "default"];
const STOP = [APPLE_TOOL, "system", "stop"];
const START = [APPLE_TOOL, "system", "start", "--disable-kernel-install"];
const ok: CommandResult = { exitCode: 0, stdout: "", stderr: "" };

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function setup(rules: ScriptedRule[], knock: Knock = { ok: false, code: "timeout", ms: 3000 }) {
  const folder = mkdtempSync(join(tmpdir(), "aidm-apple-network-"));
  folders.push(folder);
  const runner = new ScriptedRunner(rules);
  const lines: string[] = [];
  const knocks: string[] = [];
  const configFile = join(folder, "container", "config.toml");
  const apple = new AppleNetwork({
    runner,
    log: (line) => lines.push(line),
    configFile,
    knock: async (address, port) => {
      knocks.push(`${address}:${port}`);
      return knock;
    },
  });
  return { apple, runner, lines, knocks, configFile };
}

/** What the Mac answers while the engine container runs, with the routing table and the route to the container given. */
function theMac(routes: string, route: string, inside?: CommandResult): ScriptedRule[] {
  return [
    { argv: INSPECT, result: recorded("apple-container", "inspect-running") },
    { argv: NETSTAT, result: network(routes) },
    { argv: IFCONFIG, result: network("ifconfig.txt") },
    { argv: ROUTE, result: network(route) },
    { argv: NETWORK, result: network("network-inspect-default.txt") },
    ...(inside === undefined ? [] : [{ argv: [APPLE_TOOL, "exec", "aidm-local-engine", "/bin/bash", "-c", insideScript()], result: inside }]),
  ];
}

function insideScript(): string {
  return `exec 3<>/dev/tcp/127.0.0.1/3000 && printf 'GET /info HTTP/1.0\\r\\nHost: localhost\\r\\n\\r\\n' >&3 && IFS= read -r -t 5 line <&3 && printf '%s\\n' "$line"`;
}

test("a route to the container through the VPN's tunnel is the VPN, and nothing else is tried", async () => {
  const { apple, lines, knocks, runner } = setup(theMac("netstat-vpn-captured.txt", "route-get-vpn.txt"));
  expect(await apple.diagnose("aidm-local-engine", 3000)).toEqual({
    code: "mac.vpn_route",
    data: { address: "192.0.2.2", interface: "utun4", bridge: "bridge100", subnet: "192.0.2.0/24" },
  });
  expect(lines).toContain("Connection check 1 (route): 192.0.2.2 goes through utun4 via 100.101.102.103; the tool's bridge is bridge100.");
  expect(knocks).toEqual([]);
  expect(runner.calls.some((argv) => argv.includes("exec"))).toBe(false);
});

test("a connection refused at once while the route is on the bridge is the Local Network permission", async () => {
  const { apple, lines, knocks, runner } = setup(theMac("netstat-healthy.txt", "route-get-bridge.txt"), { ok: false, code: "EHOSTUNREACH", ms: 2 });
  expect(await apple.diagnose("aidm-local-engine", 3000)).toEqual({ code: "mac.local_network_denied", data: { address: "192.0.2.2" } });
  expect(knocks).toEqual(["192.0.2.2:3000"]);
  expect(lines).toContain("Connection check 2 (direct): a connection to 192.0.2.2:3000 failed with EHOSTUNREACH after 0.0 s.");
  expect(runner.calls.some((argv) => argv.includes("exec"))).toBe(false);
});

test("a No route to host that took the network's time is not the permission", async () => {
  const { apple } = setup(theMac("netstat-healthy.txt", "route-get-bridge.txt", { exitCode: 0, stdout: "HTTP/1.1 200 OK\r\n", stderr: "" }), {
    ok: false,
    code: "EHOSTUNREACH",
    ms: 2900,
  });
  expect((await apple.diagnose("aidm-local-engine", 3000)).code).toBe("mac.engine_unreachable");
});

test("with the route right and no refusal, the task API is asked inside the container with bash alone", async () => {
  const { apple, runner, lines } = setup(theMac("netstat-healthy.txt", "route-get-bridge.txt", { exitCode: 0, stdout: "HTTP/1.1 200 OK\r\n", stderr: "" }));
  expect(await apple.diagnose("aidm-local-engine", 3000)).toEqual({ code: "mac.engine_unreachable", data: { inside: "answers" } });
  const exec = runner.calls.find((argv) => argv.includes("exec")) ?? [];
  expect(exec.slice(0, 5)).toEqual([APPLE_TOOL, "exec", "aidm-local-engine", "/bin/bash", "-c"]);
  // Nothing but bash and its own /dev/tcp: 2.6 images have no Node.js, and curl is not relied on.
  expect(exec.join(" ")).not.toMatch(/\b(node|curl|wget|python3?|perl)\b/);
  expect(lines.at(-1)).toBe("Connection check 3 (inside the container): the task API answered: exit 0, HTTP/1.1 200 OK");
});

test("an API that refuses inside the container too is silent, and an exec that fails says nothing about it", async () => {
  const refused = { exitCode: 1, stdout: "", stderr: "bash: connect: Connection refused\nbash: line 1: /dev/tcp/127.0.0.1/3000: Connection refused\n" };
  expect((await setup(theMac("netstat-healthy.txt", "route-get-bridge.txt", refused)).apple.diagnose("aidm-local-engine", 3000)).data).toEqual({
    inside: "silent",
  });
  const missing = { exitCode: 1, stdout: "", stderr: "Error: internalError: \"vmexec error: failed to find target executable /bin/bash\"\n" };
  expect((await setup(theMac("netstat-healthy.txt", "route-get-bridge.txt", missing)).apple.diagnose("aidm-local-engine", 3000)).data).toEqual({
    inside: "unknown",
  });
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

test("the tool's subnet is in conflict once a route of another interface takes it, and not while only the bridge has it", async () => {
  const healthy = setup(theMac("netstat-healthy.txt", "route-get-bridge.txt"));
  expect((await healthy.apple.conflicts())?.uses).toEqual([]);
  const captured = setup(theMac("netstat-vpn-captured.txt", "route-get-vpn.txt"));
  const found = await captured.apple.conflicts();
  expect(found?.network.bridge).toBe("bridge100");
  expect(found?.uses).toEqual([{ kind: "route", network: "192.0.2.0/24", interface: "utun4" }]);
  expect(captured.lines.at(-1)).toBe("Network: the tool's subnet is 192.0.2.0/24 on bridge100; also used by route 192.0.2.0/24 on utun4.");
});

test("the move writes a free subnet into the config file, keeps the rest of it, and restarts the tool's service", async () => {
  const { apple, runner, configFile } = setup([
    ...theMac("netstat-vpn-captured.txt", "route-get-vpn.txt"),
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
    ...theMac("netstat-vpn-captured.txt", "route-get-vpn.txt"),
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
