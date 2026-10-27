import type { ApiError } from "../../shared/api-error.ts";
import { CONTAINER_NAME, ENGINE_PORT } from "../packages/container-package.ts";
import type { AppleNetwork } from "../runtimes/apple-network.ts";
import { formatCidr } from "../runtimes/mac-network.ts";

/** How often the checks run again while the engine runs and does not answer. A permission turned on is seen within this time. */
export const CONNECTION_CHECK_INTERVAL_MS = 5000;

export interface MacConnectionDeps {
  network: Pick<AppleNetwork, "diagnose" | "conflicts" | "move">;
  /** Whether the engine container runs now. The checks are about a running engine that does not answer. */
  running: () => Promise<boolean>;
  /** What the view shows changed. */
  onChange: () => void;
  log: (line: string) => void;
  intervalMs?: number;
}

/**
 * Why the local engine on a Mac runs and cannot be reached on its published
 * port, and whether the tool's network fights with another one (ADR 0006).
 * The manager says when the engine stops or starts answering; while it does
 * not answer, the checks run again by themselves every few seconds, so a
 * permission or a VPN setting the operator changes shows without a click.
 */
export class MacConnection {
  private problem: ApiError | null = null;
  private conflict: ApiError | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private checking: Promise<void> | undefined;
  private closed = false;

  constructor(private readonly deps: MacConnectionDeps) {}

  /** What the page shows: why the engine does not answer, and a conflict of the tool's subnet. */
  view(): { problem: ApiError | null; conflict: ApiError | null } {
    return { problem: this.problem, conflict: this.conflict };
  }

  /** The engine runs and does not answer from the Mac: check now, and again every few seconds. */
  notAnswering(): void {
    if (this.closed || this.timer !== undefined) return;
    this.timer = setInterval(() => void this.check(), this.deps.intervalMs ?? CONNECTION_CHECK_INTERVAL_MS);
    void this.check();
  }

  /** The engine answers again, or is not running at all: the checks stop and their finding goes. */
  settled(answering: boolean): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    if (this.problem === null) return;
    if (answering) this.deps.log(`Connection: the engine answers again (it did not because of ${this.problem.code}).`);
    this.problem = null;
    this.deps.onChange();
  }

  /** Whether the tool's subnet is taken by another interface. Runs at every start of the engine on a Mac. */
  async checkSubnet(): Promise<void> {
    try {
      const found = await this.deps.network.conflicts();
      if (this.closed) return;
      const use = found?.uses[0];
      const conflict: ApiError | null =
        found === null || use === undefined
          ? null
          : { code: "mac.subnet_conflict", data: { subnet: formatCidr(found.network.subnet), interface: use.interface, network: use.network } };
      if (JSON.stringify(conflict) === JSON.stringify(this.conflict)) return;
      this.conflict = conflict;
      this.deps.onChange();
    } catch (error) {
      this.deps.log(`Network: checking the tool's subnet failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Moves the tool's network, on the operator's word. The service and every container on it restart; the caller starts the engine. */
  async move(): Promise<{ ok: true } | { ok: false; error: ApiError }> {
    const moved = await this.deps.network.move();
    if (!moved.ok) return moved;
    this.conflict = null;
    this.problem = null;
    this.deps.onChange();
    return { ok: true };
  }

  close(): void {
    this.closed = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One round of the checks. A round still on its way is not doubled. */
  private check(): Promise<void> {
    this.checking ??= this.round().finally(() => {
      this.checking = undefined;
    });
    return this.checking;
  }

  private async round(): Promise<void> {
    try {
      if (!(await this.deps.running())) return;
      const found = await this.deps.network.diagnose(CONTAINER_NAME, ENGINE_PORT);
      // The engine may have answered, stopped or been closed while the checks ran.
      if (this.closed || this.timer === undefined) return;
      if (JSON.stringify(found) === JSON.stringify(this.problem)) return;
      this.deps.log(`Connection: the engine runs and does not answer from this Mac: ${found.code} ${JSON.stringify(found.data)}.`);
      this.problem = found;
      this.deps.onChange();
    } catch (error) {
      this.deps.log(`Connection: the checks failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
