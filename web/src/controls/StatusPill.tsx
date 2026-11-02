import type { ReactNode } from "react";
import type { EngineState, RunState } from "../../../shared/api-types.ts";

export type StatusTone = "neutral" | "running" | "ok" | "warn" | "danger" | "info";

export const RUN_STATE_TONES: Record<RunState, StatusTone> = {
  created: "neutral",
  uploading: "running",
  queued: "neutral",
  processing: "running",
  completed: "ok",
  failed: "danger",
  cancelled: "neutral",
  engine_unreachable: "warn",
  unknown: "warn",
};

export const ENGINE_STATE_TONES: Record<EngineState, StatusTone> = {
  not_installed: "neutral",
  installing: "running",
  starting: "running",
  ready: "ok",
  busy: "running",
  unreachable: "warn",
  stopped: "neutral",
  failed: "danger",
};

/** A short state in words with a dot in its colour. The words carry the state; the colour repeats it. */
export function StatusPill({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  return (
    <span className={`status-pill status-${tone}`}>
      <span className="status-dot" aria-hidden="true" />
      {children}
    </span>
  );
}
