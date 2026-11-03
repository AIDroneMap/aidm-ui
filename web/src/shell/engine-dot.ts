import { useEffect, useState } from "react";
import type { EngineView } from "../../../shared/api-types.ts";
import { parseEngineList } from "../engines.ts";

/** The four states of the dot beside Engines in the sidebar (proposal section 3). */
export const ENGINE_DOTS = ["ready", "busy", "unreachable", "not_installed"] as const;
export type EngineDot = (typeof ENGINE_DOTS)[number];

/**
 * One state for every engine together. Busy comes first, because a run is
 * under way somewhere; then ready, because an engine can take a run. An engine
 * that is switched off, or too old for this interface, takes no run, so it
 * counts as one that does not answer. With no engine at all, or only one being
 * installed, the dot says not installed.
 */
export function engineDot(engines: readonly EngineView[]): EngineDot {
  const present = engines.filter((engine) => engine.state !== "not_installed" && engine.state !== "installing");
  if (present.length === 0) return "not_installed";
  const usable = present.filter((engine) => engine.enabled && engine.supported === true);
  if (usable.some((engine) => engine.state === "busy")) return "busy";
  if (usable.some((engine) => engine.state === "ready")) return "ready";
  return "unreachable";
}

/**
 * The dot, from the live list of engines the server pushes (the stream the
 * Engines screen reads too, which sends the whole list when it opens). Null
 * until the first list arrives. The browser reconnects on its own after a
 * break, and the last dot stays until then.
 */
export function useEngineDot(): EngineDot | null {
  const [dot, setDot] = useState<EngineDot | null>(null);
  useEffect(() => {
    const source = new EventSource("/api/engines/events");
    source.addEventListener("engines", (event) => {
      const list = parseEngineList((event as MessageEvent<string>).data);
      if (list) setDot(engineDot(list));
    });
    return () => source.close();
  }, []);
  return dot;
}
