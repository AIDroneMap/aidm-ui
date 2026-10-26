import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { isAbsolute, join } from "node:path";
import type { ApiError } from "../../shared/api-error.ts";
import type {
  CapsRequest,
  EngineState,
  EngineView,
  InstallProgressView,
  InstallStepView,
  LocalEngineView,
  MachineCheckView,
  PackagesView,
  RuntimeId,
} from "../../shared/api-types.ts";
import type { EngineMonitor } from "../engines/engine-monitor.ts";
import type { EngineStore } from "../engines/engine-store.ts";
import type { FreeBytes } from "../machine/disk.ts";
import { gpuApplies, inImageFailed, NOT_CHECKED, precheckGpu, type GpuPrecheck } from "../machine/gpu.ts";
import { DOWNLOAD_FREE_DISK_MARGIN, MEMORY_CAP_MIN } from "../machine/thresholds.ts";
import type { ManifestService, OfferFacts } from "../manifest/manifest-service.ts";
import type { CommandRunner } from "../process/command-runner.ts";
import { ContainerPackage, PULL_ATTEMPTS, type ContainerVariant } from "../packages/container-package.ts";
import { fail, ok, type EnginePackage, type PackageResult } from "../packages/engine-package.ts";
import type { MacNeed, MacSetup } from "../runtimes/apple-container-installer.ts";
import { preferredRuntime } from "../runtimes/registry.ts";
import type { ContainerRuntime, RuntimeDetection } from "../runtimes/runtime.ts";
import type { InstalledPackage, Settings } from "../settings/settings.ts";
import { checkCaps, defaultCaps, type Caps } from "./caps.ts";
import { EngineLog, type EngineLogDeps } from "./engine-log.ts";

/** What the engines list calls the local engine. The page shows its own translated name. */
export const LOCAL_ENGINE_NAME = "This computer";
/** The port may be taken between the moment it is found free and the moment the container binds it. */
const PORT_TRIES = 3;
/** A page load reuses a look at the graphics card this young. An install and a start always look again. */
const GPU_PRECHECK_MAX_AGE_MS = 60_000;
/** A start does not ask the runtimes again if they answered this recently. */
const DETECTION_MAX_AGE_MS = 10_000;
/** Seconds to wait before each try to bring back a crashed engine: 2, 4, 8, 16, 32. */
export const RESTART_BACKOFF_SECONDS = [2, 4, 8, 16, 32] as const;
/** The most tries in a row. The next one waits for the operator. */
export const RESTART_MAX_ATTEMPTS = RESTART_BACKOFF_SECONDS.length;
/** The count of tries starts again only after the engine has answered this long without a break. A flapping engine keeps counting. */
export const RESTART_COUNT_RESET_MS = 5 * 60_000;

/** What the manager knows about the tries to bring back a crashed engine. */
interface Restart {
  /** The try that is waiting or running, from 1; 0 when there is none. */
  attempts: number;
  /** When the next try starts, on the manager's clock. */
  nextAt: number | null;
  /** True after the last try. Nothing restarts the engine again until the operator acts. */
  gaveUp: boolean;
  task: Promise<void> | undefined;
  /** Counts the times the operator started or stopped the engine, so a restart that waited knows it is out of date. */
  epoch: number;
  /** Since when the engine has answered without a break, or null. */
  answeringSince: number | null;
  /** True once the container was looked at in the unreachable spell that is going on. A container that runs but is silent is not looked at again until the state changes. */
  checked: boolean;
  /** Ends the wait before the next try at once. */
  endWait: (() => void) | null;
}

/** What an install pulls, and what it records once the pull works. */
interface InstallPlan {
  pkg: ContainerPackage;
  installed: InstalledPackage;
  variant: ContainerVariant;
}

/** What a Mac still lacks, and the service that supplies it. */
interface MacPlan {
  need: MacNeed;
  setup: MacSetup;
}

export type InstallOutcome = { ok: true } | { ok: false; status: number; error: ApiError };

export interface LocalEngineDeps {
  settings: Settings;
  engineStore: EngineStore;
  monitor: EngineMonitor;
  manifests: ManifestService;
  /** Null for a runtime this version cannot drive yet. */
  runtimes: (id: RuntimeId) => ContainerRuntime | null;
  detectRuntimes: () => Promise<RuntimeDetection[]>;
  /** Runs the NVIDIA driver and toolkit commands of the graphics card checks. */
  runner: CommandRunner;
  machine: { platform: string; arch: string; totalMemory: number; cpuCount: number };
  dataFolder: string;
  freeBytes: FreeBytes;
  log: (line: string) => void;
  /** On a Mac: puts Apple's container tool there first when it is missing or was never started. */
  macSetup?: MacSetup;
  /**
   * What the machine check says about the local engine. On a Mac the install
   * refuses with its reason (an Intel Mac, macOS 15), so the route and the
   * wizard cannot disagree.
   */
  localEngineOffer?: () => Promise<MachineCheckView["localEngine"]>;
  /** The token for a new install. 32 random bytes in hex by default. */
  random?: () => string;
  freePort?: () => Promise<number>;
  /** Waits between pull attempts and before each restart; a test passes one that does not wait. */
  sleep?: (ms: number) => Promise<void>;
  /** The clock for the time of the next restart and for how long the engine has answered. */
  now?: () => number;
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
  /** Ends the wait for the password of macOS, at the operator's request. Set while an install sets up a Mac. */
  private stopWaiting: AbortController | null = null;
  /** One install, start or stop at a time. */
  private busy = false;
  private installing = false;
  private progress: InstallProgressView | null = null;
  /** What an install would take now, when it is more than the engine. See LocalEngineView. */
  private plan: InstallStepView[] | null = null;
  /** The bytes of the installer last published, so a fast download does not make an event for every chunk. */
  private publishedReceived = 0;
  /** Why the last install or start failed; cleared by the next one. */
  private failure: ApiError | null = null;
  private background: Promise<unknown> = Promise.resolve();
  private published: string | undefined;
  private closed = false;
  private token: string | null = null;
  /** The last look at the graphics card, as the promise of its answer, so that page loads share one. */
  private precheck: { at: number; runtime: RuntimeId | null; value: Promise<GpuPrecheck> } | undefined;
  /** Set when the graphics card package failed its test run and could not be deleted. Cleared by the next install. */
  private packageLeft: ApiError | null = null;
  private readonly restart: Restart = {
    attempts: 0,
    nextAt: null,
    gaveUp: false,
    task: undefined,
    epoch: 0,
    answeringSince: null,
    checked: false,
    endWait: null,
  };

  constructor(private readonly deps: LocalEngineDeps) {
    this.settings = deps.settings;
    this.store = deps.engineStore;
    this.monitor = deps.monitor;
    this.engineLog = new EngineLog({ dataFolder: deps.dataFolder, token: () => this.token, log: deps.log, ...deps.logOptions });
    this.unsubscribeMonitor = this.monitor.subscribe((views) => {
      this.publish();
      this.watch(views);
    });
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

    warnings.push(...this.gpuWarnings(installedPackage));

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
      enabled: this.isEnabled(),
      startAgain: installedPackage !== null && engine !== null && this.isEnabled() && state === "failed",
      state,
      install: this.progress,
      plan: this.plan,
      caps: {
        memoryBytes: caps.memoryBytes,
        cpus: caps.cpus,
        maxMemoryBytes: limits.memoryBytes,
        maxCpus: limits.cpus,
        applied: this.settings.get("local.applied"),
      },
      runtime: { chosen, available: available.map((candidate) => candidate.id), preferred },
      warnings,
      forceCpu: this.settings.get("local.forceCpu"),
      problem,
      restarts:
        this.restart.attempts > 0 && !this.restart.gaveUp && (this.restart.task !== undefined || state === "starting")
          ? {
              attempts: this.restart.attempts,
              max: RESTART_MAX_ATTEMPTS,
              nextAt: this.restart.nextAt === null ? null : new Date(this.restart.nextAt).toISOString(),
            }
          : null,
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
    await this.lookAtRuntimes();
  }

  /**
   * Asks the runtimes now. Returns whether they answered. Each failure has a
   * line of its own in the log: the look at the runtimes, and then the work of
   * finding out what an install would take.
   */
  private lookAtRuntimes(): Promise<boolean> {
    let answered = false;
    this.detecting = (async () => {
      try {
        this.detections = await this.deps.detectRuntimes();
        this.detectedAt = Date.now();
        answered = true;
      } catch (error) {
        this.deps.log(`Looking for container runtimes failed: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      try {
        await this.refreshPlan();
      } catch (error) {
        this.deps.log(`Working out the install steps failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    })().finally(() => {
      this.detecting = undefined;
      this.publish();
    });
    return this.detecting.then(() => answered);
  }

  /**
   * A look at the runtimes that begins now. One that is under way began
   * earlier, so its answer may be older than a change the caller just made:
   * it is waited for, and then a new one is made.
   */
  private async lookAtRuntimesAgain(): Promise<boolean> {
    while (this.detecting !== undefined) await this.detecting;
    return this.lookAtRuntimes();
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

  /** The processor package whatever the checks say. A start then leaves the card out too. */
  setForceCpu(forceCpu: boolean): void {
    this.settings.set("local.forceCpu", forceCpu);
    this.publish();
  }

  /**
   * Checks a and b for the graphics card, with the runtime that would be used.
   * Nothing runs when the computer cannot use the graphics card package. An
   * answer younger than maxAgeMs is reused.
   */
  async gpuPrecheck(facts: { platform: string; arch: string }, maxAgeMs = 0): Promise<GpuPrecheck> {
    if (!gpuApplies(facts)) return NOT_CHECKED;
    await this.refreshRuntimes(Math.min(maxAgeMs, DETECTION_MAX_AGE_MS));
    return this.lookAtGpu(facts, maxAgeMs);
  }

  /** Like gpuPrecheck, for a caller that has just looked at the runtimes. */
  private lookAtGpu(facts: { platform: string; arch: string }, maxAgeMs: number): Promise<GpuPrecheck> {
    if (!gpuApplies(facts)) return Promise.resolve(NOT_CHECKED);
    const runtime = this.chosenRuntime()?.id ?? null;
    const seen = this.precheck;
    if (seen !== undefined && seen.runtime === runtime && Date.now() - seen.at < maxAgeMs) return seen.value;
    const entry = { at: Date.now(), runtime, value: precheckGpu(this.deps.runner, facts, runtime) };
    this.precheck = entry;
    entry.value.catch(() => {
      if (this.precheck === entry) this.precheck = undefined;
    });
    return entry.value;
  }

  /** What decides the package: the computer, the checks, the operator's choice and a test run that failed before. */
  private offerFacts(facts: { platform: string; arch: string }, gpu: GpuPrecheck): OfferFacts {
    return {
      platform: facts.platform,
      arch: facts.arch,
      gpu,
      forceCpu: this.settings.get("local.forceCpu"),
      gpuFailedDigest: this.settings.get("local.gpuCheckFailed")?.digest ?? null,
    };
  }

  /** The offer for this computer, with what the graphics card checks found. For the packages route. */
  async packages(facts: { platform: string; arch: string }): Promise<PackagesView> {
    const gpu = await this.gpuPrecheck(facts, GPU_PRECHECK_MAX_AGE_MS);
    return this.deps.manifests.offer(this.offerFacts(facts, gpu));
  }

  // Installing and running --------------------------------------------------

  /** Answers once the install has started; the work goes on in the background. */
  async install(): Promise<InstallOutcome> {
    // An install over a running engine would pull a package next to it and swap tokens under it. Updates come with ticket #14.
    // This comes first, so a restart in progress is never answered with "already being installed".
    if (this.settings.get("local.package") !== null) return refusal(409, "install.already_installed");
    if (this.busy) return refusal(409, "install.already_running");
    this.busy = true;
    let started = false;
    try {
      const { machine } = this.deps;
      if (machine.platform === "darwin" && this.deps.localEngineOffer !== undefined) {
        const local = await this.deps.localEngineOffer();
        if (!local.offered) return { ok: false, status: 409, error: local.reason ?? { code: "install.not_offered", data: {} } };
      }
      // Checks a and b come before anything is downloaded. Check c needs the image and comes after the pull.
      await this.refreshRuntimes();
      const gpu = await this.lookAtGpu(machine, 0);
      const offered = await this.deps.manifests.offerWithVariant(this.offerFacts(machine, gpu));
      const { offer } = offered.view;
      const variant = offered.variant;
      if (offer === null || variant === null || variant.kind !== "container") {
        return refusal(409, "install.not_offered", { reason: offered.view.reason });
      }

      const runtime = this.chosenRuntime();
      // A Mac without a working container tool gets it set up first.
      const mac = runtime === null ? this.macNeed() : null;
      if (runtime === null && mac === null) return refusal(409, "install.no_runtime");
      const driver = this.deps.runtimes(runtime?.id ?? "apple-container");
      if (driver === null) return refusal(409, "install.no_runtime");

      // Only a missing passthrough is stored as a note. The other reasons are read from the settings when the view is made.
      const reason = offered.view.gpu.reason;
      const plan = this.planFor({
        driver,
        runtime,
        offer,
        variant,
        gpuNote: reason?.code === "gpu.no_passthrough" ? reason : null,
      });
      // The processor package of this same manifest, for when the test run inside the graphics card package fails.
      const { processor } = offered;
      const fallback =
        variant.gpu && processor !== null && processor.variant.kind === "container"
          ? this.planFor({
              driver,
              runtime,
              offer: { packageVersion: offer.packageVersion, variant: processor.id },
              variant: processor.variant,
              gpuNote: null,
            })
          : null;
      const steps: InstallStepView[] = [...(mac?.setup.steps(mac.need) ?? []), { id: "engine", size: variant.size }];
      // Refused here, before anything is pulled, so the operator hears it in the answer to the click.
      const space = await plan.pkg.preflight();
      if (!space.ok) return { ok: false, status: 409, error: space.error };
      if (mac !== null) {
        // The installer and the kernel come on top of the engine, and the engine's own check above counted only itself.
        const downloads = steps.reduce((sum, step) => sum + (step.size ?? 0), 0);
        const needed = Math.ceil(downloads * (1 + DOWNLOAD_FREE_DISK_MARGIN));
        const free = this.deps.freeBytes(this.deps.dataFolder);
        if (free < needed) return refusal(409, "install.not_enough_space", { needed, free });
      }

      const existing = this.store.local();
      if (existing !== null) this.monitor.setLocalState(existing.id, "installing");
      this.failure = null;
      this.packageLeft = null;
      this.installing = true;
      started = true;
      this.publishedReceived = 0;
      this.progress = {
        phase: mac === null ? "pulling" : "preparing",
        variant: offer.variant,
        steps,
        step: steps[0]?.id ?? "engine",
        stepReceived: null,
        size: variant.size,
        layersDone: null,
        layersTotal: null,
        attempt: 1,
        maxAttempts: PULL_ATTEMPTS,
      };
      this.background = this.runInstall(plan, fallback, mac, steps)
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

  /**
   * Ends the wait for the password of macOS. The install stops at that step
   * with mac.install_not_finished. Does nothing when no install waits for it.
   */
  stopWaitingForApproval(): void {
    if (this.installing && this.progress?.step === "approve") this.stopWaiting?.abort();
  }

  /** The switch on the engines page. Turning it on while it is on changes nothing, unless the manager gave up. */
  async setEnabled(enabled: boolean): Promise<PackageResult<void>> {
    if (this.settings.get("local.package") === null) return fail("local.not_installed");
    if (this.isEnabled() === enabled && !(enabled && this.restart.gaveUp)) return ok(undefined);
    return enabled ? this.start() : this.stop();
  }

  /** Starts the installed engine, or starts it again after a stop. Also what the operator does after the manager gave up. */
  async start(): Promise<PackageResult<void>> {
    const claimed = await this.claim();
    if (!claimed.ok) return claimed;
    // A start on its own is not an install, so there is no install progress to show.
    this.progress = null;
    try {
      await this.recheckGpuNote();
      return await this.startEngine();
    } finally {
      this.busy = false;
    }
  }

  /** Stops the container and leaves the engine switched off. */
  async stop(): Promise<PackageResult<void>> {
    const claimed = await this.claim();
    if (!claimed.ok) return claimed;
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
      this.failure = null;
      this.setSwitch(engine.id, false);
      this.settings.set("local.applied", null);
      this.monitor.setLocalState(engine.id, "stopped");
      this.publish();
      return ok(undefined);
    } finally {
      this.busy = false;
    }
  }

  /**
   * After aidm-ui starts: looks for the container by its fixed name. One that
   * still runs keeps its address and token and gets its log followed again. One
   * that is stopped or gone is started again, unless the operator switched the
   * engine off. Nothing here runs at boot: it runs only because aidm-ui started.
   */
  async resume(): Promise<void> {
    try {
      await this.recheckGpuNote();
    } catch (error) {
      this.deps.log(`Looking at the graphics card again failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const installed = this.settings.get("local.package");
    const engine = this.store.local();
    if (installed === null || engine === null || !this.isEnabled()) return;
    try {
      const pkg = this.packageFor(installed);
      if (pkg === null) return;
      const status = await pkg.status();
      if (this.closed) return;
      if (status.ok && status.value.state === "running" && engine.address !== "") {
        this.token = engine.token;
        this.engineLog.follow(pkg, { fresh: false });
        return;
      }
      if (this.busy) return;
      this.busy = true;
      try {
        this.progress = null;
        await this.startEngine();
      } finally {
        this.busy = false;
      }
    } catch (error) {
      this.deps.log(`Bringing the engine back after the start failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Stops following the log and the pull in progress. The container is left running. */
  async close(): Promise<void> {
    this.closed = true;
    this.abort.abort();
    this.unsubscribeMonitor();
    this.listeners.clear();
    await this.background.catch(() => {});
    await this.restart.task?.catch(() => {});
    await this.engineLog.stop();
  }

  /** Resolves when the install in the background has ended. For tests. */
  settled(): Promise<unknown> {
    return this.background;
  }

  // Inside ------------------------------------------------------------------

  private async runInstall(
    first: InstallPlan,
    fallback: InstallPlan | null,
    mac: MacPlan | null,
    steps: InstallStepView[],
  ): Promise<void> {
    if (mac !== null) {
      const ready = await this.setUpMac(mac);
      if (!ready) return;
    }
    let plan = first;
    const pulled = await this.pull(plan, steps);
    if (!pulled.ok) return this.failInstall(pulled.error);

    if (plan.variant.gpu) {
      // Check c. The image is the same one the engine will run, with the same flag.
      this.showStep("checking_gpu", plan, steps);
      const confirmed = await plan.pkg.confirmGpu(this.abort.signal);
      // Closing aborts the test run, and that says nothing about the graphics card.
      if (this.closed) return;
      if (confirmed.ok) {
        this.settings.set("local.gpuCheckFailed", null);
      } else {
        const detail = confirmed.error.data.exitCode;
        this.deps.log(`The graphics card does not work inside the engine image (exit code ${String(detail ?? "unknown")}). The processor package is used instead.`);
        // Remembered, so that the next install does not download the same package again.
        this.settings.set("local.gpuCheckFailed", { digest: plan.variant.digest, at: new Date().toISOString() });
        // The image is 5.7 GB. It goes before the processor image comes, so the disk holds only one of them.
        this.showStep("removing_gpu_package", plan, steps);
        const removed = await plan.pkg.removeImage();
        if (!removed.ok) {
          this.deps.log(`The graphics card image could not be removed (${removed.error.code}).`);
          this.packageLeft = { code: "gpu.package_not_removed", data: { size: plan.variant.size } };
        }
        if (fallback === null) return this.failInstall({ code: "install.not_offered", data: { reason: null } });
        plan = { ...fallback, installed: { ...fallback.installed, gpuPackageLeft: this.packageLeft } };
        const again = await this.pull(plan, steps);
        if (!again.ok) return this.failInstall(again.error);
      }
    }
    const { installed } = plan;

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

  private pull(plan: InstallPlan, steps: InstallStepView[]): Promise<PackageResult<void>> {
    // The package knows only its own step, the page wants all of them. The engine step has the size of the package being pulled.
    const all = steps.map((step) => (step.id === "engine" ? { ...step, size: plan.variant.size } : step));
    return plan.pkg.install({
      signal: this.abort.signal,
      onProgress: (progress) => {
        this.progress = { ...progress, steps: all };
        this.publish();
      },
    });
  }

  /** Shows a step of the install that has no layers to count. */
  private showStep(phase: "checking_gpu" | "removing_gpu_package", plan: InstallPlan, steps: InstallStepView[]): void {
    this.progress = {
      phase,
      variant: plan.installed.variant,
      steps,
      step: "engine",
      stepReceived: null,
      size: plan.variant.size,
      layersDone: null,
      layersTotal: null,
      attempt: 1,
      maxAttempts: PULL_ATTEMPTS,
    };
    this.publish();
  }

  /** What the operator is told about the graphics card, from the stored state each time the picture is made. */
  private gpuWarnings(installed: InstalledPackage | null): ApiError[] {
    if (installed?.container.gpu) {
      return this.settings.get("local.forceCpu") ? [{ code: "gpu.forced_cpu", data: {} }] : [];
    }
    const notes: ApiError[] = [];
    if (this.settings.get("local.gpuCheckFailed") !== null && (installed !== null || this.installing)) {
      notes.push(inImageFailed());
    }
    if (installed?.gpuNote) notes.push(installed.gpuNote);
    const left = installed === null ? this.packageLeft : (installed.gpuPackageLeft ?? null);
    if (left !== null) notes.push(left);
    return notes;
  }

  /** The note that the container tool cannot hand over the card goes once it can, since the operator may have set it up since. */
  private async recheckGpuNote(): Promise<void> {
    const installed = this.settings.get("local.package");
    if (installed?.gpuNote?.code !== "gpu.no_passthrough" || this.settings.get("local.forceCpu")) return;
    const precheck = await this.gpuPrecheck(this.deps.machine);
    if (precheck.state === "no_passthrough") return;
    const latest = this.settings.get("local.package");
    if (latest === null) return;
    this.settings.set("local.package", { ...latest, gpuNote: null });
    this.publish();
  }

  private planFor(input: {
    driver: ContainerRuntime;
    /** Null on a Mac whose container tool is set up during this install. */
    runtime: RuntimeDetection | null;
    offer: { packageVersion: string; variant: InstalledPackage["variant"] };
    variant: ContainerVariant;
    gpuNote: ApiError | null;
  }): InstallPlan {
    const pkg = new ContainerPackage({
      runtime: input.driver,
      variant: input.variant,
      variantId: input.offer.variant,
      freeBytes: this.deps.freeBytes,
      storagePath: input.runtime?.storagePath ?? null,
      dataFolder: this.deps.dataFolder,
      sleep: this.deps.sleep,
    });
    const installed: InstalledPackage = {
      packageVersion: input.offer.packageVersion,
      variant: input.offer.variant,
      runtime: input.runtime?.id ?? "apple-container",
      container: input.variant,
      gpuNote: input.gpuNote,
    };
    return { pkg, installed, variant: input.variant };
  }

  /** The runtime that would be used: the operator's choice if it works, else Podman before Docker. */
  private chosenRuntime(): RuntimeDetection | null {
    return preferredRuntime(
      this.drivable().filter((detection) => detection.available),
      this.settings.get("runtime.preferred"),
    );
  }

  /** The Mac steps before the engine. Returns false when one failed; the failure is already recorded. */
  private async setUpMac({ need, setup }: MacPlan): Promise<boolean> {
    const steps = this.progress?.steps ?? [];
    const show = (change: Partial<InstallProgressView>) => {
      if (this.progress === null) return;
      this.progress = { ...this.progress, ...change };
      this.publish();
    };
    const stopWaiting = new AbortController();
    this.stopWaiting = stopWaiting;
    let result: Awaited<ReturnType<MacSetup["run"]>>;
    try {
      result = await setup.run(need, {
        signal: this.abort.signal,
        stopWaiting: stopWaiting.signal,
        onStep: (step) => {
          this.publishedReceived = 0;
          show({ step, stepReceived: null });
        },
        onReceived: (received) => {
          const size = steps.find((candidate) => candidate.id === "installer")?.size ?? 0;
          // About two hundred events for the whole download.
          if (received < size && received - this.publishedReceived < size / 200) return;
          this.publishedReceived = received;
          show({ stepReceived: received });
        },
      });
    } finally {
      this.stopWaiting = null;
    }
    if (!result.ok) {
      show({ step: result.step });
      this.failInstall(result.error);
      return false;
    }
    // The service started just now, so what the runtimes said before it is out of date. The look is made anew, after any that was under way.
    const answered = await this.lookAtRuntimesAgain();
    const failedAt = this.progress?.step ?? "init";
    if (!answered) {
      this.deps.log("Apple's container tool was started, but it could not be looked at again after it started. The engine was not pulled.");
      this.failInstall({ code: "mac.start_failed", data: { step: failedAt } });
      return false;
    }
    const found = this.drivable().find((detection) => detection.id === "apple-container");
    if (found === undefined || !found.available) {
      this.deps.log("Apple's container tool was started, but it does not answer as running. The engine was not pulled.");
      this.failInstall({ code: "mac.start_failed", data: { step: failedAt } });
      return false;
    }
    show({ phase: "pulling", step: "engine", stepReceived: null });
    return true;
  }

  /** The steps an install would take now. Only a Mac that lacks Apple's tool has more than one. */
  private async refreshPlan(): Promise<void> {
    const mac = this.macNeed();
    const { platform, arch } = this.deps.machine;
    const variant = mac === null ? null : (await this.deps.manifests.offerWithVariant({ platform, arch })).variant;
    this.plan =
      mac === null || variant === null || variant.kind !== "container"
        ? null
        : [...mac.setup.steps(mac.need), { id: "engine", size: variant.size }];
  }

  /** What a Mac still lacks for Apple's container tool, or null when nothing (or when this is no Mac). */
  private macNeed(): MacPlan | null {
    const setup = this.deps.macSetup;
    if (this.deps.machine.platform !== "darwin" || setup === undefined) return null;
    const apple = this.detections.find((detection) => detection.id === "apple-container");
    if (apple?.problem?.code === "runtime.not_installed") return { need: "tool_missing", setup };
    if (apple?.problem?.code === "runtime.apple_not_started") return { need: "service_stopped", setup };
    return null;
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
    this.setSwitch(engine.id, true);
    if (this.progress !== null) this.progress = { ...this.progress, phase: "starting" };
    // No address until the new container is up, so nothing polls the old one.
    this.store.update(engine.id, { address: "" });
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
        // With the processor-only choice the card stays out, and the engine runs on the processor.
        gpu: installed.container.gpu && !this.settings.get("local.forceCpu"),
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

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /**
   * Whether the switch is on. The setting decides. An install from before the
   * switch existed has no setting, and there the engine's own flag was the record.
   */
  private isEnabled(): boolean {
    if (this.settings.getRaw("local.enabled") === null) {
      const engine = this.store.local();
      if (engine !== null) return engine.enabled;
    }
    return this.settings.get("local.enabled");
  }

  /** The one place the switch is written: the engine's flag first, then the setting that decides. */
  private setSwitch(engineId: number, enabled: boolean): void {
    this.store.update(engineId, { enabled });
    this.settings.set("local.enabled", enabled);
  }

  /**
   * Takes the manager for an operator action. A restart that is waiting or
   * running is ended first, and the action goes on once it has let go. Refused
   * with a code only when an install or another action holds the manager.
   */
  private async claim(): Promise<PackageResult<void>> {
    if (this.installing) return fail("install.already_running");
    if (this.busy && this.restart.task === undefined) return fail("local.busy");
    await this.cancelRestart();
    if (this.busy) return fail("local.busy");
    this.busy = true;
    return ok(undefined);
  }

  /** The operator started or stopped the engine: whatever the manager was doing about a crash is out of date. */
  private async cancelRestart(): Promise<void> {
    const restart = this.restart;
    restart.epoch++;
    restart.attempts = 0;
    restart.nextAt = null;
    restart.gaveUp = false;
    restart.endWait?.();
    await restart.task?.catch(() => {});
  }

  /** Looks at every change the monitor reports: a crash starts the restarts, and the count ends only after a long stay. */
  private watch(views: EngineView[]): void {
    if (this.closed) return;
    try {
      const engine = this.store.local();
      const state = views.find((candidate) => candidate.id === engine?.id)?.state;
      if (engine === null || state === undefined) return;
      const restart = this.restart;
      const now = this.now();
      if (state === "ready" || state === "busy") {
        restart.answeringSince ??= now;
        restart.checked = false;
        return;
      }
      if (restart.answeringSince !== null) {
        // A break in answering. The count of tries starts again only if the engine had answered for long enough before it.
        if (restart.task === undefined && now - restart.answeringSince >= RESTART_COUNT_RESET_MS) restart.attempts = 0;
        restart.answeringSince = null;
      }
      if (state !== "unreachable") {
        restart.checked = false;
        return;
      }
      if (
        !restart.checked &&
        restart.task === undefined &&
        !this.busy &&
        !this.installing &&
        !restart.gaveUp &&
        this.isEnabled() &&
        engine.address !== "" &&
        this.settings.get("local.package") !== null
      ) {
        restart.checked = true;
        restart.task = this.restartLoop().finally(() => {
          restart.task = undefined;
          this.publish();
        });
      }
    } catch (error) {
      this.deps.log(`Watching the local engine failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Brings back a local engine that does not answer, when its container is
   * stopped or gone: after 2, 4, 8, 16 and 32 seconds, at most five tries in a
   * row. A container that runs but does not answer is left alone, the engine
   * shows as not answering. The runtime's own restart policy is never used.
   */
  private async restartLoop(): Promise<void> {
    const restart = this.restart;
    const epoch = restart.epoch;
    const wanted = () => !this.closed && restart.epoch === epoch && this.isEnabled();
    try {
      while (wanted()) {
        const installed = this.settings.get("local.package");
        const engine = this.store.local();
        const pkg = installed === null ? null : this.packageFor(installed);
        if (engine === null || pkg === null) return;
        const status = await pkg.status();
        if (!wanted()) return;
        if (!status.ok) {
          this.deps.log(`Looking at the engine container failed (${status.error.code}).`);
          return;
        }
        if (status.value.state === "running") return;

        if (restart.attempts >= RESTART_MAX_ATTEMPTS) {
          await this.giveUp(engine.id);
          return;
        }
        const delayMs = (RESTART_BACKOFF_SECONDS[restart.attempts] ?? 32) * 1000;
        restart.attempts++;
        restart.nextAt = this.now() + delayMs;
        this.deps.log(`The engine container is ${status.value.state}. Starting it again, try ${restart.attempts} of ${RESTART_MAX_ATTEMPTS}.`);
        this.publish();
        await this.pause(delayMs);
        if (!wanted()) return;
        restart.nextAt = null;
        // The operator may be starting or stopping the engine right now.
        if (this.busy) return;
        this.busy = true;
        let started: PackageResult<void>;
        try {
          this.progress = null;
          started = await this.startEngine();
        } finally {
          this.busy = false;
        }
        this.publish();
        // A start that worked is judged by the engine: ready ends the loop, silence starts the next try.
        if (started.ok) return;
      }
    } catch (error) {
      this.deps.log(`Restarting the engine failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async giveUp(engineId: number): Promise<void> {
    this.restart.gaveUp = true;
    this.restart.nextAt = null;
    const error: ApiError = { code: "local.restart_gave_up", data: { attempts: this.restart.attempts } };
    this.deps.log(`The engine did not come back after ${this.restart.attempts} tries. It stays stopped until the operator starts it.`);
    this.failure = error;
    // No address, so nothing polls a container that is gone and turns the failure into "not answering".
    this.store.update(engineId, { address: "" });
    this.settings.set("local.applied", null);
    this.token = null;
    this.monitor.setLocalState(engineId, "failed", error);
    await this.engineLog.stop();
    this.publish();
  }

  /** Waits, but not past close() or the end of a restart. The timer and the listener are gone when the wait ends. */
  private pause(ms: number): Promise<void> {
    if (this.abort.signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const end = () => {
        clearTimeout(timer);
        this.abort.signal.removeEventListener("abort", end);
        if (this.restart.endWait === end) this.restart.endWait = null;
        resolve();
      };
      this.abort.signal.addEventListener("abort", end, { once: true });
      this.restart.endWait = end;
      if (this.deps.sleep === undefined) timer = setTimeout(end, ms);
      else this.deps.sleep(ms).then(end, end);
    });
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
      variantId: installed.variant,
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
