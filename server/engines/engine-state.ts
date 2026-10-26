import type { EngineState } from "../../shared/api-types.ts";

/** How many polls in a row must get no answer before an engine counts as unreachable. */
export const UNREACHABLE_AFTER_FAILED_POLLS = 3;

export interface EngineStatus {
  state: EngineState;
  /** Polls in a row that got no answer. */
  failedPolls: number;
}

export type EngineEvent =
  | { type: "answered"; queueCount: number | null }
  /** The engine answered with an error body, for example because the token is wrong. */
  | { type: "refused" }
  /** Nothing usable came back: no connection, a timeout, or a reply that is not task API. */
  | { type: "no_answer" }
  | { type: "installing" }
  | { type: "starting" }
  | { type: "stopped" }
  | { type: "failed" };

/** The one place that decides what state an engine is in. Remote engines never get installing or stopped. */
export function nextEngineStatus(current: EngineStatus, event: EngineEvent): EngineStatus {
  switch (event.type) {
    case "answered":
      return { state: event.queueCount !== null && event.queueCount > 0 ? "busy" : "ready", failedPolls: 0 };
    case "refused":
      return { state: "failed", failedPolls: 0 };
    case "no_answer": {
      const failedPolls = current.failedPolls + 1;
      return {
        state: failedPolls >= UNREACHABLE_AFTER_FAILED_POLLS ? "unreachable" : current.state,
        failedPolls,
      };
    }
    case "installing":
    case "starting":
    case "stopped":
    case "failed":
      return { state: event.type, failedPolls: 0 };
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}
