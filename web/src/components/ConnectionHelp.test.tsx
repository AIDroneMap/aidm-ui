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

test("a VPN in the way says what to change in the VPN app and offers the move of the network", () => {
  const html = render(
    onMac({
      via: "port",
      problem: { code: "mac.vpn_route", data: { address: "192.0.2.2", interface: "utun4", bridge: "bridge100", subnet: "192.0.2.0/24" } },
      conflict: null,
      canMove: true,
    }),
  );
  expect(html).toContain("A VPN on this Mac sends the engine&#x27;s traffic into its tunnel (utun4)");
  expect(html).toContain("allow access to the local network");
  expect(html).toContain("Move the engine&#x27;s network</button>");
  expect(untranslatedText(html)).toEqual([]);
});

test("the Local Network permission says where to turn it on, and that it is checked again by itself", () => {
  const html = render(onMac({ via: "port", problem: { code: "mac.local_network_denied", data: { address: "192.0.2.2" } }, conflict: null, canMove: false }));
  expect(html).toContain("System Settings, then Privacy &amp; Security, then Local Network, and switch on &quot;container&quot;");
  expect(html).toContain("AIDM UI checks again every few seconds.");
  expect(html).not.toContain("Move the engine");
});

test("an engine that answers only inside its container says so and shows its log", () => {
  const html = render(onMac({ via: "port", problem: { code: "mac.engine_unreachable", data: { inside: "answers" } }, conflict: null, canMove: false }));
  expect(html).toContain("Inside its container the engine answers");
  expect(html).toContain('id="connection-log"');
});

test("a subnet another interface uses is a warning with the move", () => {
  const html = render(
    onMac({
      via: "port",
      problem: null,
      conflict: { code: "mac.subnet_conflict", data: { subnet: "192.0.2.0/24", interface: "utun4", network: "192.0.2.0/24" } },
      canMove: true,
    }),
  );
  expect(html).toContain("utun4 on this Mac uses 192.0.2.0/24 too");
  expect(html).toContain('class="warning"');
});
