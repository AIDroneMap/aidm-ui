import { expect, test } from "bun:test";
import type { ApiError } from "../../shared/api-error.ts";
import { parseCidr, type Cidr } from "../runtimes/mac-network.ts";
import { eventually } from "../testing/harness.ts";
import { MacConnection } from "./mac-connection.ts";

function watcher(answers: ApiError[], options: { running?: boolean } = {}) {
  const asked: string[] = [];
  const lines: string[] = [];
  let changes = 0;
  const connection = new MacConnection({
    network: {
      diagnose: async (container, port) => {
        asked.push(`${container}:${port}`);
        return answers[Math.min(asked.length - 1, answers.length - 1)] as ApiError;
      },
      conflicts: async () => ({
        network: { subnet: parseCidr("192.0.2.0/24") as Cidr, gateway: 0, bridge: "bridge100" },
        uses: [{ kind: "route", network: "192.0.2.0/24", interface: "utun4" }],
      }),
      move: async () => ({ ok: true, subnet: "192.168.213.0/24" }),
    },
    running: async () => options.running ?? true,
    onChange: () => changes++,
    log: (line) => lines.push(line),
    intervalMs: 20,
  });
  return { connection, asked, lines, changes: () => changes };
}

const DENIED: ApiError = { code: "mac.local_network_denied", data: { address: "192.0.2.2" } };
const VPN: ApiError = { code: "mac.vpn_route", data: { address: "192.0.2.2", interface: "utun4", bridge: "bridge100", subnet: "192.0.2.0/24" } };

test("while the engine runs and does not answer, the checks run again by themselves until it answers", async () => {
  const { connection, asked, lines } = watcher([DENIED, DENIED, VPN]);
  connection.notAnswering();
  await eventually(async () => connection.view().problem?.code === "mac.local_network_denied");
  // The operator turns the permission on, and then the VPN reconnects: the next rounds see it without a click.
  await eventually(async () => connection.view().problem?.code === "mac.vpn_route");
  expect(asked[0]).toBe("aidm-local-engine:3000");
  // A finding that stays the same is logged once.
  expect(lines.filter((line) => line.includes("mac.local_network_denied"))).toHaveLength(1);

  connection.settled(true);
  expect(connection.view().problem).toBeNull();
  expect(lines.at(-1)).toBe("Connection: the engine answers again (it did not because of mac.vpn_route).");
  const rounds = asked.length;
  await Bun.sleep(80);
  expect(asked.length).toBe(rounds);
  connection.close();
});

test("an engine container that does not run is not checked: the restart of the engine is the answer there", async () => {
  const { connection, asked } = watcher([DENIED], { running: false });
  connection.notAnswering();
  await Bun.sleep(60);
  expect(asked).toEqual([]);
  expect(connection.view().problem).toBeNull();
  connection.close();
});

test("a subnet another interface takes is a conflict, and the move clears it", async () => {
  const { connection, changes } = watcher([]);
  await connection.checkSubnet();
  expect(connection.view().conflict).toEqual({
    code: "mac.subnet_conflict",
    data: { subnet: "192.0.2.0/24", interface: "utun4", network: "192.0.2.0/24" },
  });
  expect(changes()).toBe(1);
  // The same conflict found again changes nothing.
  await connection.checkSubnet();
  expect(changes()).toBe(1);
  expect(await connection.move()).toEqual({ ok: true });
  expect(connection.view()).toEqual({ problem: null, conflict: null });
  connection.close();
});
