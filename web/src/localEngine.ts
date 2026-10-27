import { useEffect, useRef, useState } from "react";
import { api, ApiFailure, asApiFailure } from "./api.ts";
import type { ApiError } from "../../shared/api-error.ts";
import {
  ENGINE_STATES,
  SETUP_PHASES,
  type CapsRequest,
  type CapsView,
  type EnginePackageOffer,
  type InstallProgressView,
  type InstallStepId,
  type InstallStepView,
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
  const { caps, runtime, warnings, update } = parsed;
  if (!(ENGINE_STATES as readonly unknown[]).includes(parsed["state"])) return null;
  if (!isRecord(caps) || typeof caps["memoryBytes"] !== "number" || typeof caps["cpus"] !== "number") return null;
  if (!isRecord(runtime) || !Array.isArray(runtime["available"])) return null;
  if (!Array.isArray(warnings)) return null;
  if (!isRecord(update)) return null;
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
  /** A Mac setting up Apple's container tool: the step, its size when it has one, and the bytes received so far. */
  | { kind: "preparing"; step: InstallStepId; size: number | null; received: number | null }
  | {
      kind: "downloading";
      /** True for the graphics card package. */
      graphics: boolean;
      size: number;
      /** Bytes on disk so far, when the download reports them. */
      received: number | null;
      /** Bytes per second over the last seconds, or null. */
      speed: number | null;
      done: number | null;
      total: number | null;
      /** How often the connection broke and the download went on, and why it last broke. */
      retries: number;
      lastRetry: ApiError | null;
    }
  | { kind: "loading" }
  | { kind: "checking_gpu" }
  | { kind: "removing_gpu_package"; size: number }
  | { kind: "starting" }
  | { kind: "ready" }
  | { kind: "failed" }
  | { kind: "state" };

/** What the install screen says about the local engine, from its view. */
export function installStatus(view: LocalEngineView | null): InstallStatus {
  if (!view) return { kind: "none" };
  const { install } = view;
  const stepped = progressStatus(install);
  if (stepped.kind !== "none") return stepped;
  if (view.state === "ready" || view.state === "busy") return { kind: "ready" };
  if (install?.phase === "failed" || view.state === "failed") return { kind: "failed" };
  if (install?.phase === "done") return { kind: "starting" };
  if (view.installed) return { kind: "state" };
  return { kind: "none" };
}

export type StepState = "done" | "current" | "pending" | "failed";

/**
 * The steps of an install with where each stands. They are listed only when
 * there is more than the engine to do, and before the click from the plan.
 */
export function installSteps(view: LocalEngineView | null): Array<InstallStepView & { state: StepState }> {
  const install = view?.install ?? null;
  const steps = install?.steps ?? view?.plan ?? [];
  if (steps.length < 2) return [];
  const current = install === null ? -1 : steps.findIndex((candidate) => candidate.id === install.step);
  return steps.map((step, index) => {
    let state: StepState = "pending";
    if (install !== null) {
      if (install.phase === "done" || index < current) state = "done";
      else if (index === current) state = install.phase === "failed" ? "failed" : "current";
    }
    return { ...step, state };
  });
}

/** Where a download stands, in the same words for an install and an update: the step, the bytes, the speed, why it last broke, and the graphics card's test run. */
export function progressStatus(progress: InstallProgressView | null): InstallStatus {
  if (progress?.phase === "preparing") {
    const size = progress.steps.find((candidate) => candidate.id === progress.step)?.size ?? null;
    return { kind: "preparing", step: progress.step, size, received: progress.stepReceived };
  }
  if (progress?.phase === "pulling") {
    return {
      kind: "downloading",
      graphics: progress.variant.endsWith("-gpu"),
      size: progress.size,
      received: progress.stepReceived,
      speed: progress.speed,
      done: progress.layersDone,
      total: progress.layersTotal,
      retries: progress.retries,
      lastRetry: progress.lastRetry,
    };
  }
  if (progress?.phase === "loading") return { kind: "loading" };
  if (progress?.phase === "checking_gpu") return { kind: "checking_gpu" };
  if (progress?.phase === "removing_gpu_package") return { kind: "removing_gpu_package", size: progress.size };
  if (progress?.phase === "starting") return { kind: "starting" };
  return { kind: "none" };
}

/**
 * The problem the update block shows: what an update or a rollback says about
 * itself, and what stopped it before the engine was touched (a download that
 * failed, no room). A problem of the engine that failed to start is on the
 * engines list already.
 */
export function updateProblem(view: LocalEngineView): ApiError | null {
  const problem = view.problem;
  if (problem === null) return null;
  if (problem.code.startsWith("update.")) return problem;
  const download =
    problem.code.startsWith("install.") || problem.code.startsWith("runtime.") || problem.code.startsWith("download.");
  return download && view.state !== "failed" ? problem : null;
}

/** The version the engine changed to between two views, when an update or a rollback has just ended well; else null. */
export function finishedVersion(before: LocalEngineView, after: LocalEngineView): string | null {
  if (before.update.applying === null || after.update.applying !== null) return null;
  const version = after.installed?.packageVersion ?? null;
  return version !== null && version !== before.installed?.packageVersion ? version : null;
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
