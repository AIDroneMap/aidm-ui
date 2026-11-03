import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { EngineView } from "../../../shared/api-types.ts";
import en from "../i18n/en.json";
import { Shell } from "./Shell.tsx";
import { ENGINE_DOTS, engineDot, type EngineDot } from "./engine-dot.ts";

const remote: EngineView = {
  id: 2,
  kind: "remote",
  name: "Barn engine",
  address: "http://192.168.1.20:3000",
  enabled: true,
  state: "ready",
  supported: true,
  info: null,
  problem: null,
  warning: null,
};

const local: EngineView = { ...remote, id: 1, kind: "local", name: "local", address: "http://127.0.0.1:3001" };

test("with no engine at all, or one still being installed, the dot says not installed", () => {
  expect(engineDot([])).toBe("not_installed");
  expect(engineDot([{ ...local, state: "not_installed" }])).toBe("not_installed");
  expect(engineDot([{ ...local, state: "installing" }])).toBe("not_installed");
});

test("an engine that can take a run makes the dot ready", () => {
  expect(engineDot([remote])).toBe("ready");
  expect(engineDot([{ ...local, state: "stopped", enabled: false }, remote])).toBe("ready");
});

test("an engine with work waiting or running makes the dot busy, even beside a ready one", () => {
  expect(engineDot([{ ...remote, state: "busy" }])).toBe("busy");
  expect(engineDot([local, { ...remote, state: "busy" }])).toBe("busy");
});

test("engines that are there but none answers make the dot unreachable", () => {
  for (const state of ["unreachable", "starting", "stopped", "failed"] as const) {
    expect(engineDot([{ ...remote, state }]), state).toBe("unreachable");
  }
  // Switched off, or too old for this interface: it cannot take a run, whatever it last said.
  expect(engineDot([{ ...remote, enabled: false }])).toBe("unreachable");
  expect(engineDot([{ ...remote, state: "busy", enabled: false }])).toBe("unreachable");
  expect(engineDot([{ ...remote, supported: false }])).toBe("unreachable");
});

function engines(dot: EngineDot | null): string {
  const html = renderToStaticMarkup(
    <Shell route={{ screen: "projects" }} project={null} engineDot={dot}>
      <p>content</p>
    </Shell>,
  );
  return /<a class="nav-item" href="#\/engines"[^>]*>(.*?)<\/a>/.exec(html)?.[1] ?? "";
}

test("the Engines item shows each of the four dots, with its state in words for screen readers", () => {
  for (const dot of ENGINE_DOTS) {
    const item = engines(dot);
    expect(item, dot).toContain(`class="shell-engine-dot shell-engine-dot-${dot}"`);
    expect(item, dot).toContain(`<span class="visually-hidden">${(en as Record<string, string>)[`nav.engines_${dot}`]}</span>`);
  }
  const words = ENGINE_DOTS.map((dot) => (en as Record<string, string>)[`nav.engines_${dot}`]);
  expect(new Set(words).size).toBe(4);
});

test("before the engines are known the Engines item has no dot", () => {
  const item = engines(null);
  expect(item).toContain("Engines");
  expect(item).not.toContain("shell-engine-dot");
  expect(item).not.toContain("visually-hidden");
});
