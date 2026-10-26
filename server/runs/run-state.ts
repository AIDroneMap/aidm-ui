import { FINISHED_RUN_STATES, type RunState } from "../../shared/api-types.ts";

/** The task API's status codes (aidm-api, libs/statusCodes.js). */
export const TASK_STATUS = { QUEUED: 10, RUNNING: 20, FAILED: 30, COMPLETED: 40, CANCELED: 50 } as const;

/**
 * The one place that turns the engine's status code into a run state. The
 * engine reports RUNNING with a processing time of -1 while it reads the
 * uploaded images; nothing is processing yet, so that is queued.
 */
export function runStateFromTask(statusCode: unknown, processingTime: number | null): RunState {
  switch (statusCode) {
    case TASK_STATUS.QUEUED:
      return "queued";
    case TASK_STATUS.RUNNING:
      return processingTime === null || processingTime < 0 ? "queued" : "processing";
    case TASK_STATUS.FAILED:
      return "failed";
    case TASK_STATUS.COMPLETED:
      return "completed";
    case TASK_STATUS.CANCELED:
      return "cancelled";
    default:
      return "unknown";
  }
}

export function isFinished(state: RunState): boolean {
  return FINISHED_RUN_STATES.includes(state);
}
