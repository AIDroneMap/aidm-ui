import type { MachineCheckView } from "../../shared/api-types.ts";
import type { Settings } from "../settings/settings.ts";
import { checkMachine } from "./check.ts";
import type { MachineFacts } from "./facts.ts";

/** A read older than this runs the check again. */
export const MACHINE_CHECK_MAX_AGE_MS = 60_000;

export interface MachineChecksDeps {
  machine: { gather(): Promise<MachineFacts> };
  settings: Settings;
  now: () => number;
}

/**
 * The machine check as the server runs it: one at a time, and a recent answer
 * is reused. Everything that wants to know the state of the computer goes
 * through here, so that a check after the computer changed is seen by all.
 */
export class MachineChecks {
  private last: { view: MachineCheckView; at: number } | null = null;
  private running: Promise<MachineCheckView> | null = null;
  /** The check that waits for the one in flight to finish. */
  private queued: Promise<MachineCheckView> | null = null;

  constructor(private readonly deps: MachineChecksDeps) {}

  /** The last answer while it is fresh, joining a check that is already running. */
  read(): Promise<MachineCheckView> | MachineCheckView {
    if (this.last !== null && this.deps.now() - this.last.at <= MACHINE_CHECK_MAX_AGE_MS) return this.last.view;
    return this.running ?? this.start();
  }

  /** "Check again" must see the computer as it is after the click, so it never shares an answer that began before it. */
  fresh(): Promise<MachineCheckView> {
    if (this.running === null) return this.start();
    this.queued ??= this.running
      .catch(() => {})
      .then(() => {
        this.queued = null;
        // A read that began in the gap also began after the click, so it may be joined.
        return this.running ?? this.start();
      });
    return this.queued;
  }

  private async execute(): Promise<MachineCheckView> {
    const facts = await this.deps.machine.gather();
    const at = this.deps.now();
    const view = checkMachine(facts, { preferredRuntime: this.deps.settings.get("runtime.preferred"), now: at });
    this.last = { view, at };
    return view;
  }

  private start(): Promise<MachineCheckView> {
    const run = this.execute().finally(() => {
      if (this.running === run) this.running = null;
    });
    this.running = run;
    return run;
  }
}
