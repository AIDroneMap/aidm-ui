import type { ApiError } from "../../shared/api-error.ts";
import { MIN_TASK_API_VERSION, type EngineInfoView, type EngineView } from "../../shared/api-types.ts";
import {
  TaskClient,
  type EngineEndpoint,
  type EngineInfo,
  type TaskApiFailure,
  type TaskClientOptions,
} from "../task-api/task-client.ts";
import { checkEngineAddress, PLAIN_HTTP_WARNING, type AddressCheck, type Resolve } from "./address-rule.ts";
import { nextEngineStatus, type EngineEvent, type EngineStatus } from "./engine-state.ts";
import type { EngineRecord, EngineStore } from "./engine-store.ts";
import { problemFromFailure } from "./problems.ts";
import { isSupportedVersion } from "./versions.ts";

export const DEFAULT_POLL_INTERVAL_MS = 3000;
/** A local engine that has just started may take this long to answer before silence counts against it. */
export const DEFAULT_STARTING_GRACE_MS = 60_000;

export interface EngineMonitorDeps {
  store: EngineStore;
  intervalMs: number;
  log: (line: string) => void;
  /** Makes the client for one call. The options carry the log and the once-only log of this engine. */
  clientFor?: (endpoint: EngineEndpoint, options: TaskClientOptions) => TaskClient;
  /** Looks up a host name for the address rule; the system lookup when missing. */
  resolve?: Resolve;
  /** How long a freshly started local engine may stay silent and still be starting. */
  startingGraceMs?: number;
}

/** What the monitor remembers about one engine between polls. */
interface Entry {
  /** Address and token the rest of this entry was learned from. */
  source: string;
  status: EngineStatus;
  info: EngineInfoView | null;
  supported: boolean | null;
  problem: ApiError | null;
  /** While the clock is before this, a starting engine that does not answer is still starting. */
  startingUntil: number;
  /** The last line logged for each topic, so a value that stays wrong is logged once. */
  logged: Map<string, string>;
}

/** What one poll found: the engine's answer, or why there was none. */
type Outcome = { ok: true; value: EngineInfo } | { ok: false; problem: ApiError; event: EngineEvent };

function sourceOf(engine: EngineRecord): string {
  return JSON.stringify([engine.address, engine.token]);
}

function eventFor(failure: TaskApiFailure): EngineEvent {
  return failure.kind === "engine_error" ? { type: "refused" } : { type: "no_answer" };
}

/** Polls every enabled engine and keeps the picture the browser sees. */
export class EngineMonitor {
  private readonly store: EngineStore;
  private readonly intervalMs: number;
  private readonly log: (line: string) => void;
  private readonly clientFor: (endpoint: EngineEndpoint, options: TaskClientOptions) => TaskClient;
  private readonly resolve: Resolve | undefined;
  private readonly startingGraceMs: number;
  private readonly entries = new Map<number, Entry>();
  private readonly inFlight = new Map<number, Promise<void>>();
  private readonly listeners = new Set<(views: EngineView[]) => void>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private published: string | undefined;

  constructor(deps: EngineMonitorDeps) {
    this.store = deps.store;
    this.intervalMs = deps.intervalMs;
    this.log = deps.log;
    this.clientFor = deps.clientFor ?? ((endpoint, options) => new TaskClient(endpoint, options));
    this.resolve = deps.resolve;
    this.startingGraceMs = deps.startingGraceMs ?? DEFAULT_STARTING_GRACE_MS;
  }

  /** The address rule, with the name lookup this monitor was given. */
  checkAddress(input: string): Promise<AddressCheck> {
    return checkEngineAddress(input, this.resolve);
  }

  start(): void {
    if (this.timer !== undefined || this.stopped) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  /**
   * Stops polling and waits for the polls on their way. Their answers are
   * dropped, so nothing touches the database after this returns.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.listeners.clear();
    await Promise.allSettled([...this.inFlight.values()]);
  }

  /** The browser's picture of every engine. It never holds a token. */
  views(): EngineView[] {
    this.sync();
    return this.store.list().map((engine) => this.viewOf(engine, this.entries.get(engine.id) as Entry));
  }

  /**
   * True when later work may use this engine: it is on, answers, and speaks a
   * task API version the interface supports.
   */
  isUsable(id: number): boolean {
    const engine = this.store.get(id);
    if (engine === null || !engine.enabled) return false;
    const entry = this.entryFor(engine);
    return entry.supported === true && (entry.status.state === "ready" || entry.status.state === "busy");
  }

  /** Polls one engine now, so the page updates at once after an add or an edit. */
  async pollNow(id: number): Promise<void> {
    this.publish();
    await this.schedule(id, true);
  }

  /** The listener gets the new picture after every change. It returns the way to stop listening. */
  subscribe(listener: (views: EngineView[]) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * The engine manager says what it is doing with the local engine: installing
   * it, starting it, stopping it, or giving up. The monitor takes it from there
   * once the engine has an address and answers.
   */
  setLocalState(
    id: number,
    state: "installing" | "starting" | "stopped" | "failed",
    problem: ApiError | null = null,
  ): void {
    const engine = this.store.get(id);
    if (engine === null || this.stopped) return;
    const entry = this.entryFor(engine);
    entry.status = nextEngineStatus(entry.status, { type: state });
    entry.problem = problem;
    // What an engine said before it was stopped or started again is old news.
    entry.info = null;
    entry.supported = null;
    entry.startingUntil = state === "starting" ? Date.now() + this.startingGraceMs : 0;
    this.store.setLastState(id, entry.status.state);
    this.publish();
  }

  private tick(): void {
    this.publish();
    for (const engine of this.store.list()) {
      if (engine.enabled && engine.address !== "") void this.schedule(engine.id, false);
    }
  }

  /** The entry for an engine, made fresh when it is new or its address or token changed. */
  private entryFor(engine: EngineRecord): Entry {
    const existing = this.entries.get(engine.id);
    if (existing && existing.source === sourceOf(engine)) return existing;
    const fresh: Entry = {
      source: sourceOf(engine),
      // A switched-off engine keeps what we last knew, since nothing will update it.
      status: { state: engine.enabled ? "starting" : engine.lastState, failedPolls: 0 },
      info: null,
      supported: null,
      problem: null,
      startingUntil: engine.kind === "local" && engine.enabled ? Date.now() + this.startingGraceMs : 0,
      logged: new Map(),
    };
    this.entries.set(engine.id, fresh);
    return fresh;
  }

  /** Makes an entry for each engine in the store and drops those of removed engines. */
  private sync(): void {
    const present = new Set<number>();
    for (const engine of this.store.list()) {
      present.add(engine.id);
      this.entryFor(engine);
    }
    for (const id of [...this.entries.keys()]) {
      if (!present.has(id)) this.entries.delete(id);
    }
  }

  private viewOf(engine: EngineRecord, entry: Entry): EngineView {
    return {
      id: engine.id,
      kind: engine.kind,
      name: engine.name,
      address: engine.address,
      enabled: engine.enabled,
      state: entry.status.state,
      supported: entry.supported,
      info: entry.info,
      problem: entry.problem,
      // The address rule only lets plain http through for the local network, so a stored http address always earns the warning.
      warning: engine.kind === "remote" && engine.address.startsWith("http:") ? PLAIN_HTTP_WARNING : null,
    };
  }

  /** One poll at a time per engine. A forced poll waits for the one running and then goes. */
  private schedule(id: number, force: boolean): Promise<void> {
    const previous = this.inFlight.get(id);
    if (previous && !force) return previous;
    const run = (async () => {
      if (previous) await previous;
      await this.poll(id);
      this.publish();
    })();
    const tracked: Promise<void> = run.finally(() => {
      if (this.inFlight.get(id) === tracked) this.inFlight.delete(id);
    });
    this.inFlight.set(id, tracked);
    return tracked;
  }

  /** Never rejects: a failed poll is a log line, and the next one tries again. */
  private async poll(id: number): Promise<void> {
    try {
      const engine = this.store.get(id);
      // A local engine has no address until it has started, and nothing to ask before that.
      if (engine === null || !engine.enabled || engine.address === "" || this.stopped) return;
      const entry = this.entryFor(engine);
      const source = sourceOf(engine);

      const outcome = await this.ask(engine, entry);

      // Stopped, or edited, switched off or removed while we waited: the answer is about something else now.
      const now = this.store.get(id);
      if (this.stopped || now === null || !now.enabled || sourceOf(now) !== source || this.entries.get(id) !== entry) return;

      const before = entry.status.state;
      if (outcome.ok) {
        const { value } = outcome;
        entry.info = value;
        entry.supported = isSupportedVersion(value.version);
        entry.problem = entry.supported
          ? null
          : { code: "engine.unsupported_version", data: { version: value.version, minimum: MIN_TASK_API_VERSION } };
        entry.status = nextEngineStatus(entry.status, { type: "answered", queueCount: value.queueCount });
      } else if (
        outcome.event.type === "no_answer" &&
        entry.status.state === "starting" &&
        Date.now() < entry.startingUntil
      ) {
        // A local engine that was just started needs time to come up, so its silence is not counted yet.
        entry.problem = null;
      } else {
        // An engine that answers with an error has no usable numbers; one that is only silent keeps its last ones.
        if (outcome.event.type === "refused") {
          entry.info = null;
          entry.supported = null;
        }
        entry.problem = outcome.problem;
        entry.status = nextEngineStatus(entry.status, outcome.event);
      }

      if (entry.status.state !== before) {
        this.store.setLastState(id, entry.status.state);
        this.log(`Engine "${engine.name}" is now ${entry.status.state}.`);
      }
    } catch (error) {
      this.log(`Polling engine ${id} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * One call to the engine. A name the operator typed was allowed once, but
   * DNS can move it, so the address rule runs again first and a name that no
   * longer passes is not called at all.
   */
  private async ask(engine: EngineRecord, entry: Entry): Promise<Outcome> {
    const checked = await this.checkAddress(engine.address);
    if (!checked.ok) {
      this.logOnce(entry, "address", `Engine "${engine.name}" is not called: ${checked.error.code}`);
      return { ok: false, problem: checked.error, event: { type: "no_answer" } };
    }
    const client = this.clientFor(
      { address: engine.address, token: engine.token },
      { log: this.log, logOnce: (key, line) => this.logOnce(entry, key, line) },
    );
    const result = await client.info();
    if (result.ok) return result;
    return { ok: false, problem: problemFromFailure(result.failure), event: eventFor(result.failure) };
  }

  /** Logs a line unless it is the same as the last one logged for the topic. */
  private logOnce(entry: Entry, key: string, line: string): void {
    if (entry.logged.get(key) === line) return;
    entry.logged.set(key, line);
    this.log(line);
  }

  private publish(): void {
    if (this.stopped) return;
    let views: EngineView[];
    try {
      views = this.views();
    } catch {
      return;
    }
    const json = JSON.stringify(views);
    if (json === this.published) return;
    this.published = json;
    for (const listener of [...this.listeners]) {
      try {
        listener(views);
      } catch (error) {
        this.log(`An engine listener failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}
