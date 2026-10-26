import type { Settings } from "../settings/settings.ts";
import type { ManifestService } from "./manifest-service.ts";

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
export const DEFAULT_UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

export interface UpdateCheckDeps {
  settings: Settings;
  manifests: Pick<ManifestService, "refresh">;
  now: () => number;
  /** How often it looks at whether a check is due. */
  intervalMs?: number;
  log: (line: string) => void;
}

/**
 * Looks for a newer manifest once a day, and only while the operator chose
 * "daily". A look that failed is made again after an hour. With no answer
 * yet, or "never", it never touches the network.
 */
export class UpdateCheckScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private current: Promise<void> | undefined;
  private cancel: AbortController | undefined;

  constructor(private readonly deps: UpdateCheckDeps) {}

  /** Checks at once if one is due, then looks again every interval. */
  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => void this.tick(), this.deps.intervalMs ?? DEFAULT_UPDATE_CHECK_INTERVAL_MS);
    void this.tick();
  }

  /** Stops the timer and cancels a look that is under way, so that shutting down does not wait for the network. */
  async stop(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.cancel?.abort();
    await this.current;
  }

  isDue(): boolean {
    const { settings, now } = this.deps;
    if (settings.get("updates.check") !== "daily") return false;
    const last = settings.get("updates.lastCheck");
    if (last === null) return true;
    const checkedAt = Date.parse(last.at);
    const succeededAt = Date.parse(settings.get("updates.lastSuccess") ?? last.at);
    // A time we cannot read, or one in the future (the clock moved back), would never come due by itself.
    if (Number.isNaN(checkedAt) || Number.isNaN(succeededAt) || checkedAt > now() || succeededAt > now()) return true;
    if (last.problem !== null) return now() - checkedAt >= HOUR_MS;
    return now() - succeededAt >= DAY_MS;
  }

  /** One look at whether a check is due. Resolves when the check, if any, has ended. */
  tick(): Promise<void> {
    if (this.current !== undefined || !this.isDue()) return this.current ?? Promise.resolve();
    const cancel = new AbortController();
    this.cancel = cancel;
    this.current = this.deps.manifests
      .refresh(cancel.signal)
      .then((result) => {
        if (!result.ok && !cancel.signal.aborted) this.deps.log(`The daily check for a newer engine package failed: ${result.error.code}.`);
      })
      .catch((error: unknown) => {
        this.deps.log(`The daily check for a newer engine package failed: ${String(error)}.`);
      })
      .finally(() => {
        this.current = undefined;
        this.cancel = undefined;
      });
    return this.current;
  }
}
