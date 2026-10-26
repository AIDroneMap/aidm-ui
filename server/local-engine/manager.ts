import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { isAbsolute, join } from "node:path";
import type { ApiError } from "../../shared/api-error.ts";
import type { CapsRequest, EngineState, LocalEngineView, InstallProgressView, RuntimeId } from "../../shared/api-types.ts";
import type { EngineMonitor } from "../engines/engine-monitor.ts";
import type { EngineStore } from "../engines/engine-store.ts";
import type { FreeBytes } from "../machine/disk.ts";
import { MEMORY_CAP_MIN } from "../machine/thresholds.ts";
import type { ManifestService } from "../manifest/manifest-service.ts";
import { ContainerPackage, PULL_ATTEMPTS } from "../packages/container-package.ts";
import { fail, ok, type EnginePackage, type PackageResult } from "../packages/engine-package.ts";
import { preferredRuntime } from "../runtimes/registry.ts";
import type { ContainerRuntime, RuntimeDetection } from "../runtimes/runtime.ts";
import type { InstalledPackage, Settings } from "../settings/settings.ts";
import { checkCaps, defaultCaps, type Caps } from "./caps.ts";
import { EngineLog, type EngineLogDeps } from "./engine-log.ts";

/** What the engines list calls the local engine. The page shows its own translated name. */
export const LOCAL_ENGINE_NAME = "This computer";
/** The port may be taken between the moment it is found free and the moment the container binds it. */
const PORT_TRIES = 3;
/** A start does not ask the runtimes again if they answered this recently. */
const DETECTION_MAX_AGE_MS = 10_000;

export type InstallOutcome = { ok: true } | { ok: false; status: number; error: ApiError };

export interface LocalEngineDeps {
  settings: Settings;
  engineStore: EngineStore;
  monitor: EngineMonitor;
  manifests: ManifestService;
  /** Null for a runtime this version cannot drive yet. */
  runtimes: (id: RuntimeId) => ContainerRuntime | null;
  detectRuntimes: () => Promise<RuntimeDetection[]>;
  machine: { platform: string; arch: string; totalMemory: number; cpuCount: number };
  dataFolder: string;
  freeBytes: FreeBytes;
  log: (line: string) => void;
  /** The token for a new install. 32 random bytes in hex by default. */
  random?: () => string;
  freePort?: () => Promise<number>;
  /** Waits between pull attempts; a test passes one that does not wait. */
  sleep?: (ms: number) => Promise<void>;
  logOptions?: Pick<EngineLogDeps, "rotateBytes" | "retryBackoffMs">;
}

function randomToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
}

/** A port on the loopback interface that nothing holds right now. */
function loopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => (port === 0 ? reject(new Error("No port.")) : resolve(port)));
    });
  });
}

function refusal(status: number, code: ApiError["code"], data: Record<string, unknown> = {}): InstallOutcome {
  return { ok: false, status, error: { code, data } };
}

/**
 * Installs, starts, stops and watches the local engine. It keeps no state the
 * database does not also hold, except what is happening right now.
 */
export class LocalEngineManager {
  private readonly settings: Settings;
  private readonly store: EngineStore;
  private readonly monitor: EngineMonitor;
  private readonly engineLog: EngineLog;
  private readonly listeners = new Set<(view: LocalEngineView) => void>();
  private readonly unsubscribeMonitor: () => void;
  private readonly abort = new AbortController();

  private detections: RuntimeDetection[] = [];
  private detectedAt = 0;
  private detecting: Promise<void> | undefined;
  /** One install, start or stop at a time. */
  private busy = false;
  private installing = false;
  private progress: InstallProgressView | null = null;
  /** Why the last install or start failed; cleared by the next one. */
  private failure: ApiError | null = null;
  private background: Promise<unknown> = Promise.resolve();
  private published: string | undefined;
  private closed = false;
  private token: string | null = null;

  constructor(private readonly deps: LocalEngineDeps) {
    this.settings = deps.settings;
    this.store = deps.engineStore;
    this.monitor = deps.monitor;
    this.engineLog = new EngineLog({ dataFolder: deps.dataFolder, token: () => this.token, log: deps.log, ...deps.logOptions });
    this.unsubscribeMonitor = this.monitor.subscribe(() => this.publish());
  }

  /** The log of the engine, for the logs route. */
  get logs(): EngineLog {
    return this.engineLog;
  }

  // What the page sees ------------------------------------------------------

  view(): LocalEngineView {
    const installedPackage = this.settings.get("local.package");
    const engine = this.store.local();
    const caps = this.capsNow();
    const limits = this.limits();

    let state: EngineState;
    let problem: ApiError | null = this.failure;
    if (this.installing) {
      state = "installing";
    } else if (engine === null) {
      state = this.failure === null ? "not_installed" : "failed";
    } else {
      const seen = this.monitor.views().find((candidate) => candidate.id === engine.id);
      state = seen?.state ?? engine.lastState;
      problem ??= seen?.problem ?? null;
    }

    const available = this.drivable().filter((detection) => detection.available);
    const preferred = this.settings.get("runtime.preferred");
    const chosen = installedPackage?.runtime ?? preferredRuntime(available, preferred)?.id ?? null;
    const detection = this.detections.find((candidate) => candidate.id === chosen);
    const warnings: ApiError[] = [];
    if (detection !== undefined && detection.available) {
      if (detection.memoryCapEnforced === false) {
        warnings.push({ code: "local.memory_cap_not_enforced", data: { runtime: detection.id } });
      }
      if (detection.cpuCapEnforced === false) {
        warnings.push({ code: "local.cpu_cap_not_enforced", data: { runtime: detection.id } });
      }
    }

    return {
      installed:
        installedPackage === null
          ? null
          : {
              packageVersion: installedPackage.packageVersion,
              variant: installedPackage.variant,
              kind: "container",
              runtime: installedPackage.runtime,
            },
      engineId: engine?.id ?? null,
      state,
      install: this.progress,
      caps: {
        memoryBytes: caps.memoryBytes,
        cpus: caps.cpus,
        maxMemoryBytes: limits.memoryBytes,
        maxCpus: limits.cpus,
        applied: this.settings.get("local.applied"),
      },
      runtime: { chosen, available: available.map((candidate) => candidate.id), preferred },
      warnings,
      problem,
    };
  }

  /** The listener gets the new picture after every change. It returns the way to stop listening. */
  subscribe(listener: (view: LocalEngineView) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * The memory the local engine may use, for the sample job: what it was
   * started with while it runs, else what it would get. Null: no cap applies.
   */
  memoryCap(): number | null {
    const applied = this.settings.get("local.applied");
    return applied === null ? this.capsNow().memoryBytes : applied.memoryBytes;
  }

  // Runtimes and caps -------------------------------------------------------

  /** Asks the runtimes what they can do, unless the last answer is younger than maxAgeMs. */
  async refreshRuntimes(maxAgeMs = 0): Promise<void> {
    if (this.detecting !== undefined) return this.detecting;
    if (Date.now() - this.detectedAt < maxAgeMs) return;
    this.detecting = (async () => {
      try {
        this.detections = await this.deps.detectRuntimes();
        this.detectedAt = Date.now();
      } catch (error) {
        this.deps.log(`Looking for container runtimes failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    })().finally(() => {
      this.detecting = undefined;
      this.publish();
    });
    return this.detecting;
  }

  /** The operator's choice of runtime; null for automatic. One that does not work is refused. */
  async chooseRuntime(choice: RuntimeId | null): Promise<{ ok: true } | { ok: false; error: ApiError }> {
    await this.refreshRuntimes();
    if (choice !== null && !this.drivable().some((detection) => detection.id === choice && detection.available)) {
      return { ok: false, error: { code: "runtime.not_available", data: { runtime: choice } } };
    }
    this.settings.set("runtime.preferred", choice);
    this.publish();
    return { ok: true };
  }

  /** Lowers (or restores) the caps. They apply at the next start. */
  setCaps(request: CapsRequest): { ok: true } | { ok: false; error: ApiError } {
    const checked = checkCaps(request, this.limits());
    if (!checked.ok) return checked;
    this.settings.set("local.memoryBytes", request.memoryBytes);
    this.settings.set("local.cpus", request.cpus);
    this.publish();
    return { ok: true };
  }

  // Installing and running --------------------------------------------------

  /** Answers once the install has started; the work goes on in the background. */
  async install(): Promise<InstallOutcome> {
    if (this.busy) return refusal(409, "install.already_running");
    // An install over a running engine would pull a package next to it and swap tokens under it. Updates come with ticket #14.
    if (this.settings.get("local.package") !== null) return refusal(409, "install.already_installed");
    this.busy = true;
    let started = false;
    try {
      const { machine } = this.deps;
      const offered = await this.deps.manifests.offerWithVariant({ platform: machine.platform, arch: machine.arch });
      const { offer } = offered.view;
      const variant = offered.variant;
      if (offer === null || variant === null || variant.kind !== "container") {
        return refusal(409, "install.not_offered", { reason: offered.view.reason });
      }

      await this.refreshRuntimes();
      const runtime = preferredRuntime(
        this.drivable().filter((detection) => detection.available),
        this.settings.get("runtime.preferred"),
      );
      const driver = runtime === null ? null : this.deps.runtimes(runtime.id);
      if (runtime === null || driver === null) return refusal(409, "install.no_runtime");

      const pkg = new ContainerPackage({
        runtime: driver,
        variant,
        freeBytes: this.deps.freeBytes,
        storagePath: runtime.storagePath,
        dataFolder: this.deps.dataFolder,
        sleep: this.deps.sleep,
      });
      // Refused here, before anything is pulled, so the operator hears it in the answer to the click.
      const space = await pkg.preflight();
      if (!space.ok) return { ok: false, status: 409, error: space.error };

      const installed: InstalledPackage = {
        packageVersion: offer.packageVersion,
        variant: offer.variant,
        runtime: runtime.id,
        container: variant,
      };
      const existing = this.store.local();
      if (existing !== null) this.monitor.setLocalState(existing.id, "installing");
      this.failure = null;
      this.installing = true;
      started = true;
      this.progress = {
        phase: "pulling",
        size: variant.size,
        layersDone: null,
        layersTotal: null,
        attempt: 1,
        maxAttempts: PULL_ATTEMPTS,
      };
      this.background = this.runInstall(pkg, installed)
        .catch((error: unknown) => {
          this.deps.log(`Installing the local engine failed: ${error instanceof Error ? error.message : String(error)}`);
          this.failInstall({ code: "server.internal_error", data: {} });
        })
        .finally(() => {
          this.busy = false;
        });
      this.publish();
      return { ok: true };
    } finally {
      if (!started) this.busy = false;
    }
  }

  /** Starts the installed engine, or starts it again after a stop. */
  async start(): Promise<PackageResult<void>> {
    if (this.busy) return fail("install.already_running");
    this.busy = true;
    // A start on its own is not an install, so there is no install progress to show.
    this.progress = null;
    try {
      return await this.startEngine();
    } finally {
      this.busy = false;
    }
  }

  /** Stops the container and leaves the engine switched off. */
  async stop(): Promise<PackageResult<void>> {
    if (this.busy) return fail("install.already_running");
    this.busy = true;
    try {
      const installed = this.settings.get("local.package");
      const engine = this.store.local();
      if (installed === null || engine === null) return fail("local.not_installed");
      const pkg = this.packageFor(installed);
      if (pkg === null) return fail("runtime.not_available", { runtime: installed.runtime });
      const stopped = await pkg.stop();
      if (!stopped.ok) return stopped;
      // The log ends by itself when the container does; this only makes sure.
      await this.engineLog.stop();
      this.token = null;
      this.store.update(engine.id, { enabled: false });
      this.settings.set("local.applied", null);
      this.monitor.setLocalState(engine.id, "stopped");
      this.publish();
      return ok(undefined);
    } finally {
      this.busy = false;
    }
  }

  /** After aidm-ui starts again: follows the log of an engine that is still running. */
  async resume(): Promise<void> {
    const installed = this.settings.get("local.package");
    const engine = this.store.local();
    if (installed === null || engine === null || !engine.enabled || engine.address === "") return;
    try {
      const pkg = this.packageFor(installed);
      if (pkg === null) return;
      const status = await pkg.status();
      if (this.closed || !status.ok || status.value.state !== "running") return;
      this.token = engine.token;
      this.engineLog.follow(pkg, { fresh: false });
    } catch (error) {
      this.deps.log(`Following the engine log again failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Stops following the log and the pull in progress. The container is left running. */
  async close(): Promise<void> {
    this.closed = true;
    this.abort.abort();
    this.unsubscribeMonitor();
    this.listeners.clear();
    await this.background.catch(() => {});
    await this.engineLog.stop();
  }

  /** Resolves when the install in the background has ended. For tests. */
  settled(): Promise<unknown> {
    return this.background;
  }

  // Inside ------------------------------------------------------------------

  private async runInstall(pkg: ContainerPackage, installed: InstalledPackage): Promise<void> {
    const pulled = await pkg.install({
      signal: this.abort.signal,
      onProgress: (progress) => {
        this.progress = progress;
        this.publish();
      },
    });
    if (!pulled.ok) return this.failInstall(pulled.error);

    // Every install gets a token of its own, so an old one learned anywhere is worth nothing.
    const token = (this.deps.random ?? randomToken)();
    let engine = this.store.local();
    if (engine === null) {
      engine = this.store.addLocal({
        name: LOCAL_ENGINE_NAME,
        token,
        packageKind: "container",
        installedVersion: installed.packageVersion,
      });
    } else {
      this.store.update(engine.id, { token });
      this.store.setInstalledVersion(engine.id, "container", installed.packageVersion);
    }
    this.settings.set("local.package", installed);
    this.installing = false;
    await this.startEngine();
  }

  private failInstall(error: ApiError): void {
    this.installing = false;
    this.failure = error;
    if (this.progress !== null) this.progress = { ...this.progress, phase: "failed" };
    const engine = this.store.local();
    if (engine !== null && !this.closed) this.monitor.setLocalState(engine.id, "failed", error);
    this.publish();
  }

  private failStart(engineId: number, cause: ApiError): PackageResult<void> {
    const error: ApiError = { code: "install.start_failed", data: { cause } };
    this.failure = error;
    this.settings.set("local.applied", null);
    this.token = null;
    if (this.progress !== null) this.progress = { ...this.progress, phase: "failed" };
    this.monitor.setLocalState(engineId, "failed", error);
    this.publish();
    return { ok: false, error };
  }

  private async startEngine(): Promise<PackageResult<void>> {
    const installed = this.settings.get("local.package");
    const engine = this.store.local();
    if (installed === null || engine === null) return fail("local.not_installed");

    this.failure = null;
    if (this.progress !== null) this.progress = { ...this.progress, phase: "starting" };
    // No address until the new container is up, so nothing polls the old one.
    this.store.update(engine.id, { address: "", enabled: true });
    this.settings.set("local.applied", null);
    this.monitor.setLocalState(engine.id, "starting");
    await this.engineLog.stop();

    const pkg = this.packageFor(installed);
    if (pkg === null) return this.failStart(engine.id, { code: "runtime.not_available", data: { runtime: installed.runtime } });
    await this.refreshRuntimes(DETECTION_MAX_AGE_MS);
    const detection = this.detections.find((candidate) => candidate.id === installed.runtime);

    // A cap is left out where the runtime cannot enforce it, each one on its own.
    const caps = this.capsNow();
    const applied = {
      memoryBytes: detection?.memoryCapEnforced === false ? null : caps.memoryBytes,
      cpus: detection?.cpuCapEnforced === false ? null : caps.cpus,
    };

    let engineDataFolder: string;
    try {
      engineDataFolder = this.settings.get("engine.dataFolder") ?? join(this.deps.dataFolder, "engine-data");
      // The folder goes into "-v host:container", where a colon would cut it in two, and a relative one means a named volume.
      if (!isAbsolute(engineDataFolder) || engineDataFolder.includes(":")) {
        this.deps.log("The engine data folder must be a full path without a colon. The engine was not started.");
        return this.failStart(engine.id, { code: "server.internal_error", data: {} });
      }
      mkdirSync(engineDataFolder, { recursive: true });
    } catch (error) {
      this.deps.log(`The engine data folder could not be made: ${error instanceof Error ? error.message : String(error)}`);
      return this.failStart(engine.id, { code: "server.internal_error", data: {} });
    }

    let started: PackageResult<{ address: string }> = fail("runtime.start_failed");
    for (let attempt = 1; attempt <= PORT_TRIES; attempt++) {
      let hostPort: number;
      try {
        hostPort = await (this.deps.freePort ?? loopbackPort)();
      } catch {
        return this.failStart(engine.id, { code: "runtime.start_failed", data: {} });
      }
      started = await pkg.start({
        hostPort,
        token: engine.token,
        memoryBytes: applied.memoryBytes,
        cpus: applied.cpus,
        engineDataFolder,
        gpu: installed.container.gpu,
      });
      if (started.ok || started.error.code !== "runtime.port_in_use") break;
    }
    if (!started.ok) return this.failStart(engine.id, started.error);

    // The container runs now. If recording it fails, nothing would know about it, so it is taken away again.
    try {
      this.token = engine.token;
      this.settings.set("local.applied", applied);
      this.store.update(engine.id, { address: started.value.address });
    } catch (error) {
      this.deps.log(`The engine started but could not be recorded: ${error instanceof Error ? error.message : String(error)}`);
      await this.discard(pkg);
      return this.failStart(engine.id, { code: "server.internal_error", data: {} });
    }
    this.engineLog.follow(pkg, { fresh: true });
    if (this.progress !== null) this.progress = { ...this.progress, phase: "done" };
    this.publish();
    await this.monitor.pollNow(engine.id);
    return ok(undefined);
  }

  /** Stops and removes a container that must not keep running. Whatever fails here is logged, since the start has failed already. */
  private async discard(pkg: EnginePackage): Promise<void> {
    try {
      const stopped = await pkg.stop();
      if (!stopped.ok) this.deps.log(`The engine container could not be stopped (${stopped.error.code}).`);
      const removed = await pkg.removeContainer();
      if (!removed.ok) this.deps.log(`The engine container could not be removed (${removed.error.code}).`);
    } catch (error) {
      this.deps.log(`Clearing away the engine container failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The package of what is installed, driven by the runtime that pulled it. Null when this version cannot drive that runtime. */
  private packageFor(installed: InstalledPackage): EnginePackage | null {
    const runtime = this.deps.runtimes(installed.runtime);
    if (runtime === null) return null;
    return new ContainerPackage({
      runtime,
      variant: installed.container,
      freeBytes: this.deps.freeBytes,
      storagePath: this.detections.find((candidate) => candidate.id === installed.runtime)?.storagePath ?? null,
      dataFolder: this.deps.dataFolder,
      sleep: this.deps.sleep,
    });
  }

  /** The runtimes this version can drive. */
  private drivable(): RuntimeDetection[] {
    return this.detections.filter((detection) => this.deps.runtimes(detection.id) !== null);
  }

  /** The most the operator may give the engine. */
  private limits(): Caps {
    return defaultCaps(this.deps.machine.totalMemory, this.deps.machine.cpuCount);
  }

  /** The caps for the next start: the operator's, kept inside the limits, else the limits. */
  private capsNow(): Caps {
    const limits = this.limits();
    const memory = this.settings.get("local.memoryBytes");
    const cpus = this.settings.get("local.cpus");
    return {
      memoryBytes: memory === null ? limits.memoryBytes : Math.min(Math.max(memory, MEMORY_CAP_MIN), limits.memoryBytes),
      cpus: cpus === null ? limits.cpus : Math.min(Math.max(cpus, 1), limits.cpus),
    };
  }

  private publish(): void {
    if (this.closed) return;
    let view: LocalEngineView;
    try {
      view = this.view();
    } catch {
      return;
    }
    const json = JSON.stringify(view);
    if (json === this.published) return;
    this.published = json;
    for (const listener of [...this.listeners]) {
      try {
        listener(view);
      } catch (error) {
        this.deps.log(`A local engine listener failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}
