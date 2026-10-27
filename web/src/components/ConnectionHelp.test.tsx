import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { LocalConnectionView, LocalEngineView } from "../../../shared/api-types.ts";
import { fresh } from "../localEngine.fixtures.ts";
import { untranslatedText } from "../test-helpers.ts";
import { ConnectionHelp } from "./ConnectionHelp.tsx";

const onMac = (connection: LocalConnectionView | null): LocalEngineView => ({
  ...fresh,
  platform: "darwin",
  installed: { packageVersion: "2.6.1", variant: "darwin-arm64", kind: "container", runtime: "apple-container" },
  engineId: 1,
  state: "unreachable",
  connection,
});
const render = (view: LocalEngineView) => renderToStaticMarkup(<ConnectionHelp view={view} onView={() => {}} onAuthRequired={() => {}} />);

test("nothing shows while the engine answers, or when it is reached through the socket", () => {
  expect(render(onMac(null))).toBe("");
  expect(render(onMac({ via: "socket", problem: null, conflict: null, canMove: false }))).toBe("");
  expect(render(onMac({ via: "port", problem: null, conflict: null, canMove: false }))).toBe("");
});

test("a VPN that changed the route says what it did, the one setting to try, and offers no move, which would not help", () => {
  const tunnel = render(onMac({ via: "port", problem: { code: "mac.vpn_route", data: { interface: "utun4", via: "tunnel" } }, conflict: null, canMove: false }));
  expect(tunnel).toContain("A VPN on this Mac changed the route to the engine&#x27;s network");
  expect(tunnel).toContain("into its own tunnel (utun4)");
  expect(tunnel).toContain("Turn the exit node off");
  expect(tunnel).not.toContain("Move the engine");
  expect(tunnel).not.toMatch(/route (add|delete)|sudo/);
  const router = render(onMac({ via: "port", problem: { code: "mac.vpn_route", data: { interface: "en0", via: "router" } }, conflict: null, canMove: false }));
  expect(router).toContain("to your router through en0");
  expect(untranslatedText(tunnel)).toEqual([]);
});

test("a route that loops says so, and an engine that is silent inside shows its log", () => {
  expect(render(onMac({ via: "port", problem: { code: "mac.route_loop", data: { gateway: "192.168.64.1" } }, conflict: null, canMove: false }))).toContain(
    "goes round in a loop",
  );
  const silent = render(onMac({ via: "port", problem: { code: "mac.engine_not_answering", data: {} }, conflict: null, canMove: false }));
  expect(silent).toContain("not even inside its container");
  expect(silent).toContain('id="connection-log"');
});

test("the Local Network permission says where to turn it on, and that it is checked again by itself", () => {
  const html = render(onMac({ via: "port", problem: { code: "mac.local_network_denied", data: {} }, conflict: null, canMove: false }));
  expect(html).toContain("System Settings, then Privacy &amp; Security, then Local Network, and switch on &quot;container&quot;");
  expect(html).toContain("AIDM UI checks again every few seconds.");
  expect(html).not.toContain("Move the engine");
});

test("an engine that answers only inside its container says so and shows its log", () => {
  const html = render(onMac({ via: "port", problem: { code: "mac.engine_unreachable", data: { inside: "answers", port: "timeout" } }, conflict: null, canMove: false }));
  expect(html).toContain("Inside its container the engine answers");
  expect(html).toContain('id="connection-log"');
});

test("a subnet another interface uses is a warning with the move", () => {
  const html = render(
    onMac({
      via: "port",
      problem: null,
      conflict: { code: "mac.subnet_conflict", data: { subnet: "192.168.64.0/24", interface: "en7", network: "192.168.64.0/24" } },
      canMove: true,
    }),
  );
  expect(html).toContain("en7 on this Mac has addresses in 192.168.64.0/24 too");
  expect(html).toContain('class="warning"');
});
