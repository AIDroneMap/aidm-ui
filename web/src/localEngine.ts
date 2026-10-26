import { useEffect, useRef, useState } from "react";
import { api, ApiFailure, asApiFailure } from "./api.ts";
import {
  ENGINE_STATES,
  SETUP_PHASES,
  type CapsRequest,
  type CapsView,
  type EnginePackageOffer,
  type LocalEngineView,
  type RuntimeSetupView,
} from "../../shared/api-types.ts";

const GIB = 1024 ** 3;

/** The engine log keeps this many lines in the page, the newest ones. */
export const MAX_LOG_LINES = 2000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads the data of one "local-engine" server-sent event. Returns null when it is not a local engine view. */
export function parseLocalEngine(data: string): LocalEngineView | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const { caps, runtime, warnings } = parsed;
  if (!(ENGINE_STATES as readonly unknown[]).includes(parsed["state"])) return null;
  if (!isRecord(caps) || typeof caps["memoryBytes"] !== "number" || typeof caps["cpus"] !== "number") return null;
  if (!isRecord(runtime) || !Array.isArray(runtime["available"])) return null;
  if (!Array.isArray(warnings)) return null;
  return parsed as unknown as LocalEngineView;
}

/** Reads the data of one "runtime-setup" server-sent event. Returns null when it is not a setup view. */
export function parseRuntimeSetup(data: string): RuntimeSetupView | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (!(SETUP_PHASES as readonly unknown[]).includes(parsed["phase"])) return null;
  const problem = parsed["problem"];
  if (problem !== null && (!isRecord(problem) || typeof problem["code"] !== "string")) return null;
  return parsed as unknown as RuntimeSetupView;
}

/** Reads the data of one "log" server-sent event: the new lines. Returns null when it holds no lines. */
export function parseLogLines(data: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const lines = parsed["lines"];
  if (!Array.isArray(lines) || !lines.every((line) => typeof line === "string")) return null;
  return lines as string[];
}

/** The old lines followed by the new ones, cut to the newest `max`. */
export function appendLogLines(existing: string[], incoming: string[], max: number = MAX_LOG_LINES): string[] {
  const all = incoming.length === 0 ? existing : [...existing, ...incoming];
  return all.length > max ? all.slice(all.length - max) : all;
}

export type InstallStatus =
  | { kind: "none" }
  | { kind: "downloading"; size: number; done: number | null; total: number | null; attempt: number; maxAttempts: number }
  | { kind: "starting" }
  | { kind: "ready" }
  | { kind: "failed" }
  | { kind: "state" };

/** What the install screen says about the local engine, from its view. */
export function installStatus(view: LocalEngineView | null): InstallStatus {
  if (!view) return { kind: "none" };
  const { install } = view;
  if (install?.phase === "pulling") {
    return {
      kind: "downloading",
      size: install.size,
      done: install.layersDone,
      total: install.layersTotal,
      attempt: install.attempt,
      maxAttempts: install.maxAttempts,
    };
  }
  if (install?.phase === "starting") return { kind: "starting" };
  if (view.state === "ready" || view.state === "busy") return { kind: "ready" };
  if (install?.phase === "failed" || view.state === "failed") return { kind: "failed" };
  if (install?.phase === "done") return { kind: "starting" };
  if (view.installed) return { kind: "state" };
  return { kind: "none" };
}

/** True when the install button should be offered: nothing is installed and no install is under way. */
export function canInstall(view: LocalEngineView | null): boolean {
  if (!view || view.installed) return false;
  return view.install === null || view.install.phase === "failed";
}

/**
 * True when the wizard should offer to install Podman: a Linux package is on
 * offer, nothing is installed, and no container tool works. The server checks
 * all of this again when the operator clicks.
 */
export function needsRuntimeSetup(local: LocalEngineView | null, offer: EnginePackageOffer | null): boolean {
  if (local === null || offer === null) return false;
  return offer.variant.startsWith("linux-") && local.installed === null && local.runtime.available.length === 0;
}

/** True while the approval, the install or the check of Podman is under way. */
export function setupUnderWay(setup: RuntimeSetupView | null): boolean {
  return setup !== null && setup.phase !== "failed" && setup.phase !== "done";
}

/** Memory in GiB as the number input shows it. */
export function gibDraft(bytes: number): string {
  return String(Math.round((bytes / GIB) * 100) / 100);
}

/** The memory limit for a draft in GiB. An untouched draft keeps the exact bytes it came from. */
export function memoryBytesFromDraft(draft: string, current: number): number {
  if (draft.trim() === gibDraft(current)) return current;
  return draft.trim() === "" ? Number.NaN : Math.round(Number(draft) * GIB);
}

/** The biggest value the memory input accepts: the limit rounded down to a tenth of a GiB. */
export function memoryInputMax(maxBytes: number): number {
  return Math.floor((maxBytes / GIB) * 10) / 10;
}

/** The request for the two drafts, or the refusal the server would give, so a wrong number is explained at once. */
export function capsRequest(
  memoryDraft: string,
  cpusDraft: string,
  caps: CapsView,
): { request: CapsRequest } | { failure: ApiFailure } {
  const memoryBytes = memoryBytesFromDraft(memoryDraft, caps.memoryBytes);
  if (!Number.isFinite(memoryBytes) || memoryBytes < GIB || memoryBytes > caps.maxMemoryBytes) {
    return { failure: new ApiFailure(0, "caps.memory_invalid", { min: GIB, max: caps.maxMemoryBytes }) };
  }
  const cpus = cpusDraft.trim() === "" ? Number.NaN : Number(cpusDraft);
  if (!Number.isInteger(cpus) || cpus < 1 || cpus > caps.maxCpus) {
    return { failure: new ApiFailure(0, "caps.cpus_invalid", { min: 1, max: caps.maxCpus }) };
  }
  return { request: { memoryBytes, cpus } };
}

/**
 * The local engine as the server last said it: read once, then kept current
 * by the server's live updates. Does nothing while `enabled` is false.
 */
export function useLocalEngine(enabled: boolean, onAuthRequired: () => void) {
  const [view, setView] = useState<LocalEngineView | null>(null);
  const [setup, setSetup] = useState<RuntimeSetupView | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const authRequired = useRef(onAuthRequired);
  authRequired.current = onAuthRequired;

  useEffect(() => {
    if (!enabled) return;
    let current = true;
    api<LocalEngineView>("GET", "/api/local-engine").then(
      (loaded) => {
        // A live update may have arrived first and is newer.
        if (current) setView((existing) => existing ?? loaded);
      },
      (error: unknown) => {
        const result = asApiFailure(error);
        if (result.code === "auth.passphrase_required") authRequired.current();
        if (current) setFailure(result);
      },
    );
    const source = new EventSource("/api/local-engine/events");
    source.addEventListener("local-engine", (event) => {
      const next = parseLocalEngine((event as MessageEvent<string>).data);
      if (next && current) setView(next);
    });
    source.addEventListener("runtime-setup", (event) => {
      const next = parseRuntimeSetup((event as MessageEvent<string>).data);
      if (next && current) setSetup(next);
    });
    return () => {
      current = false;
      source.close();
    };
  }, [enabled]);

  return { view, setView, setup, setSetup, failure };
}

/** The engine log lines, streamed while `open` is true. Each new connection starts the list again. */
export function useEngineLog(open: boolean): string[] {
  const [lines, setLines] = useState<string[]>([]);
  useEffect(() => {
    if (!open) return;
    const source = new EventSource("/api/local-engine/logs");
    source.onopen = () => setLines([]);
    source.addEventListener("log", (event) => {
      const incoming = parseLogLines((event as MessageEvent<string>).data);
      if (incoming) setLines((existing) => appendLogLines(existing, incoming));
    });
    return () => source.close();
  }, [open]);
  return lines;
}
