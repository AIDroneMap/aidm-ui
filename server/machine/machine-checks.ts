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

/** A machine check's answer and the facts it was made from. */
export interface CheckedMachine {
  view: MachineCheckView;
  facts: MachineFacts;
}

/**
 * The machine check as the server runs it: one at a time, and a recent answer
 * is reused. Everything that wants to know the state of the computer goes
 * through here, so that a check after the computer changed is seen by all.
 */
export class MachineChecks {
  private last: (CheckedMachine & { at: number }) | null = null;
  private running: Promise<CheckedMachine> | null = null;
  /** The check that waits for the one in flight to finish. */
  private queued: Promise<CheckedMachine> | null = null;

  constructor(private readonly deps: MachineChecksDeps) {}

  /** The last answer while it is fresh, joining a check that is already running. */
  async read(): Promise<MachineCheckView> {
    return (await this.readWithFacts()).view;
  }

  /** Like read, with the facts the answer was made from, so a caller can act on what the check saw. */
  readWithFacts(): Promise<CheckedMachine> | CheckedMachine {
    if (this.last !== null && this.deps.now() - this.last.at <= MACHINE_CHECK_MAX_AGE_MS) return this.last;
    return this.running ?? this.start();
  }

  /** "Check again" must see the computer as it is after the click, so it never shares an answer that began before it. */
  async fresh(): Promise<MachineCheckView> {
    return (await this.freshWithFacts()).view;
  }

  private freshWithFacts(): Promise<CheckedMachine> {
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

  private async execute(): Promise<CheckedMachine> {
    const facts = await this.deps.machine.gather();
    const at = this.deps.now();
    const view = checkMachine(facts, { preferredRuntime: this.deps.settings.get("runtime.preferred"), now: at });
    this.last = { view, facts, at };
    return { view, facts };
  }

  private start(): Promise<CheckedMachine> {
    const run = this.execute().finally(() => {
      if (this.running === run) this.running = null;
    });
    this.running = run;
    return run;
  }
}
