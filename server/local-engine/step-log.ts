import type { ApiError } from "../../shared/api-error.ts";
import type { InstallProgressView } from "../../shared/api-types.ts";
import { seconds } from "../app/diagnosis-log.ts";

/** The name of the step a progress is in, as the diagnosis log says it. */
function stepName(progress: InstallProgressView): string | null {
  switch (progress.phase) {
    case "preparing":
      return {
        installer: "download of Apple's installer",
        approve: "approval of the installer",
        network: "Local Network permission",
        service: "start of Apple's tool",
        kernel: "Linux system for Apple's tool",
        init: "startup files of Apple's tool",
        engine: "engine",
      }[progress.step];
    case "pulling":
      return `download of the engine ${progress.variant}`;
    case "loading":
      return "load of the engine into the runtime";
    case "checking_gpu":
      return "test run on the graphics card";
    case "removing_gpu_package":
      return "removal of the graphics card package";
    case "starting":
      return "start of the engine";
    default:
      return null;
  }
}

/**
 * Writes the steps of an install or an update to the diagnosis log: a line
 * when one starts, and one when it ends with how long it took and how it
 * ended. It follows the progress the manager publishes, so every step is
 * seen however it is reached.
 */
export class StepLog {
  private current: { name: string; at: number } | null = null;

  constructor(
    private readonly what: string,
    private readonly log: (line: string) => void,
    private readonly now: () => number,
  ) {}

  observe(progress: InstallProgressView | null, failure: ApiError | null): void {
    const at = this.now();
    if (progress === null || progress.phase === "done" || progress.phase === "failed") {
      if (this.current !== null) {
        const how = progress?.phase === "failed" ? `failed: ${describe(failure)}` : "done";
        this.log(`${this.what} step ${this.current.name}: ${how}, after ${seconds(at - this.current.at)}`);
        this.current = null;
      }
      return;
    }
    const name = stepName(progress);
    if (name === this.current?.name) return;
    if (this.current !== null) this.log(`${this.what} step ${this.current.name}: done, after ${seconds(at - this.current.at)}`);
    this.current = name === null ? null : { name, at };
    if (name !== null) this.log(`${this.what} step ${name}: started`);
  }
}

/** A message code with its data, as one line. */
export function describe(error: ApiError | null): string {
  if (error === null) return "no reason given";
  const data = Object.keys(error.data).length === 0 ? "" : ` ${JSON.stringify(error.data)}`;
  return `${error.code}${data}`;
}
