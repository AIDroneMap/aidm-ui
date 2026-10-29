import type { ApiError } from "../../shared/api-error.ts";
import type { TaskApiFailure } from "../task-api/task-client.ts";

/**
 * What the browser is told about a failed call to an engine. The one mapping
 * for the monitor and the routes; details stay in the log.
 */
export function problemFromFailure(failure: TaskApiFailure): ApiError {
  switch (failure.kind) {
    case "invalid_options":
      return { code: "option.invalid_value", data: { name: failure.name } };
    case "unreachable":
      return { code: "engine.unreachable", data: {} };
    case "engine_error":
      return { code: "engine.error", data: { message: failure.message } };
    case "bad_response":
      return { code: "engine.bad_response", data: {} };
  }
}
