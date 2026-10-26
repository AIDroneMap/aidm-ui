import { TaskClient } from "../task-api/task-client.ts";
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
import type { EngineRecord, EngineStore } from "../engines/engine-store.ts";
import { compareVersions } from "../engines/versions.ts";
import type { FreeBytes } from "../machine/disk.ts";
import { gpuApplies, inImageFailed, NOT_CHECKED, precheckGpu, type GpuPrecheck } from "../machine/gpu.ts";
import { DOWNLOAD_FREE_DISK_MARGIN, MEMORY_CAP_MIN } from "../machine/thresholds.ts";
import type { ManifestService, OfferFacts } from "../manifest/manifest-service.ts";
import { ContainerPackage, PULL_ATTEMPTS, type ContainerVariant } from "../packages/container-package.ts";
import { fail, ok, type EnginePackage, type PackageResult } from "../packages/engine-package.ts";
import { NativePackage, type ChildState, type NativeOptions } from "../packages/native-package.ts";
import { systemRunner, type CommandRunner } from "../process/command-runner.ts";
import type { MacNeed, MacSetup } from "../runtimes/apple-container-installer.ts";
import type { RunStore } from "../runs/run-store.ts";
import { preferredRuntime } from "../runtimes/registry.ts";
import type { ContainerRuntime, RuntimeDetection } from "../runtimes/runtime.ts";
import {
  isNativePackage,
  type InstalledNativePackage,
  type InstalledPackage,
  type PendingSwitch,
  type Settings,
} from "../settings/settings.ts";
import type { ManifestVariant } from "../manifest/schema.ts";
import { checkCaps, defaultCaps, type Caps } from "./caps.ts";
import { EngineLog, type EngineLogDeps } from "./engine-log.ts";

/** What the engines list calls the local engine. The page shows its own translated name. */
export const LOCAL_ENGINE_NAME = "This computer";
/** The port may be taken between the moment it is found free and the moment the container binds it. */
const PORT_TRIES = 3;
/** A page load reuses a look at the graphics card this young. An install and a start always look again. */
const GPU_PRECHECK_MAX_AGE_MS = 60_000;
/** Looking for systemd, and trying a scope, each wait this long. */
const SYSTEMD_TIMEOUT_MS = 10_000;
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
  /** Bytes the download takes, from the manifest. */
  size: number;
}

/** What an install of a native package downloads, and what it records once the download works. */
interface NativePlan {
  pkg: EnginePackage;
  installed: InstalledNativePackage;
  /** Bytes the download takes, from the manifest. */
  size: number;
}

/** What a Mac still lacks, and the service that supplies it. */
interface MacPlan {
  need: MacNeed;
  setup: MacSetup;
}

/** How long a new version may take to answer the info route before the update is undone. */
export const UPDATE_READY_TIMEOUT_MS = 120_000;
/** How often the info route is asked while waiting for a new version. */
const READY_POLL_MS = 250;

/** The view may use an answer about unfinished runs this old. */
const RUN_CHECK_MAX_AGE_MS = 1000;

/** A newer package the installed variant could be updated to. */
interface UpdateOffer {
  packageVersion: string;
  size: number;
  variant: ManifestVariant;
}

/** What differs between the two kinds of package, so that the rest of the manager does not switch on the kind. */
interface KindView {
  kind: "container" | "native";
  /** The runtime that pulled the image; null for a program. */
  runtime: RuntimeId | null;
  gpu: boolean;
  /** The bytes a package downloads, from the manifest entry it was installed from. */
  size: number;
  /** What a package is, apart from the others: the image it pins, or the folder of its version. */
  identity: string;
}

function kindOf(installed: InstalledPackage): KindView {
  return isNativePackage(installed)
    ? { kind: "native", runtime: null, gpu: installed.native.gpu, size: installed.native.size, identity: `native:${installed.packageVersion}` }
    : {
        kind: "container",
        runtime: installed.runtime,
        gpu: installed.container.gpu,
        size: installed.container.size,
        identity: `${installed.container.image}@${installed.container.digest}`,
      };
}

/** The progress at the start of a download or of a start, before the package says more. */
function firstProgress(phase: "pulling" | "starting", size: number, installed: InstalledPackage): InstallProgressView {
  return {
    phase,
    variant: installed.variant,
    steps: [{ id: "engine", size }],
    step: "engine",
    stepReceived: null,
    size,
    layersDone: null,
    layersTotal: null,
    attempt: 1,
    maxAttempts: kindOf(installed).kind === "native" ? 1 : PULL_ATTEMPTS,
  };
}

/**
 * True when the engine reports the release the manifest names. The manifest's
 * packageVersion is, by its schema, the task API release, which is what the
 * info route reports, so the two are compared as versions and not as text.
 */
function reportsRelease(reported: string | undefined, expected: string): boolean {
  if (reported === undefined) return false;
  try {
    return compareVersions(reported, expected) === 0;
  } catch {
    // A version that cannot be read is not the one that was asked for.
    return false;
  }
}

export type InstallOutcome = { ok: true } | { ok: false; status: number; error: ApiError };

export interface LocalEngineDeps {
  settings: Settings;
  engineStore: EngineStore;
  monitor: EngineMonitor;
  manifests: ManifestService;
  /** Where the unfinished runs are, so no update starts under one. */
  runs: Pick<RunStore, "listUnfinished">;
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
  /** How long a new version may take to answer before an update or a rollback is undone; default 120 seconds. */
  updateReadyTimeoutMs?: number;
  /** Runs tar to unpack a native package, and systemctl and systemd-run to look for systemd. Default: the real programs. */
  nativeRunner?: CommandRunner;
  /** For native packages; a test swaps the way the program is started and the way the archive is fetched. */
  native?: NativeOptions;
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
/** How long the reattach waits for the running engine to confirm the stored token. */
const CONFIRM_TIMEOUT_MS = 5_000;

export class LocalEngineManager {
  private readonly settings: Settings;
  private readonly store: EngineStore;
  private readonly monitor: EngineMonitor;
  private readonly engineLog: EngineLog;
  private readonly listeners = new Set<(view: LocalEngineView) => void>();
  private readonly unsubscribeMonitor: () => void;
  private readonly abort = new AbortController();
  private readonly runner: CommandRunner;

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
  /** Whether systemd can give a native package a memory limit; null until it has been looked for once. */
  private systemd: boolean | null = null;
  private systemdLookup: Promise<void> | undefined;
  /** The programs this run of aidm-ui started, so that a silent one is still known to be ours. */
  private readonly children = new Map<number, ChildState>();
  /** The package objects of native versions, made once each. */
  private readonly nativePackages = new Map<string, NativePackage>();
  /** The update or the way back under way, shown like an install. */
  private updateProgress: InstallProgressView | null = null;
  private offer: UpdateOffer | null = null;
  private offerLookup: Promise<void> = Promise.resolve();
  /** The last look at whether a run is going on the local engine, and when it was made. */
  private runCheck: { at: number; found: boolean } | null = null;
  private runRecheck: ReturnType<typeof setTimeout> | undefined;
  private readonly unsubscribeManifests: () => void;
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
    this.runner = deps.nativeRunner ?? systemRunner();
    this.store = deps.engineStore;
    this.monitor = deps.monitor;
    this.engineLog = new EngineLog({ dataFolder: deps.dataFolder, token: () => this.token, log: deps.log, ...deps.logOptions });
    this.unsubscribeMonitor = this.monitor.subscribe((views) => {
      this.publish();
      this.watch(views);
    });
    // A newer manifest that arrives while the page is open is offered at once.
    this.unsubscribeManifests = deps.manifests.subscribe(() => void this.refreshUpdateOffer());
    void this.refreshUpdateOffer();
  }

  /** The log of the engine, for the logs route. */
  get logs(): EngineLog {
    return this.engineLog;
  }

  // What the page sees ------------------------------------------------------

  view(): LocalEngineView {
    const installedPackage = this.settings.get("local.package");
    const previous = installedPackage === null ? null : this.settings.get("local.previous");
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
    const installedKind = installedPackage === null ? null : kindOf(installedPackage);
    const native = installedKind?.kind === "native";
    const chosen = native ? null : (installedKind?.runtime ?? preferredRuntime(available, preferred)?.id ?? null);
    const detection = this.detections.find((candidate) => candidate.id === chosen);
    const warnings: ApiError[] = [];
    if (native) {
      // Systemd limits the memory, nothing limits the cores. Once it is known that systemd is missing, the limit has no effect.
      if (this.systemd === false) warnings.push({ code: "local.memory_cap_not_enforced", data: {} });
      if (caps.cpus < limits.cpus) warnings.push({ code: "local.cpu_cap_not_enforced", data: {} });
    } else if (detection !== undefined && detection.available) {
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
        installedPackage === null || installedKind === null
          ? null
          : {
              packageVersion: installedPackage.packageVersion,
              variant: installedPackage.variant,
              kind: installedKind.kind,
              runtime: installedKind.runtime,
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
      update: {
        available: this.offer === null || installedPackage === null ? null : { packageVersion: this.offer.packageVersion, size: this.offer.size },
        previous: previous === null ? null : { packageVersion: previous.packageVersion },
        // While a switch runs, its progress says what is going on.
        blockedBy: installedPackage === null || this.updateProgress !== null ? null : this.updateBlock(false, state),
        applying: this.updateProgress,
      },
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
        // The view warns about a missing memory limit only once it knows.
        const installed = this.settings.get("local.package");
        if (installed !== null && kindOf(installed).kind === "native") await this.lookForSystemd();
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

  /**
   * Looks once for systemd's user manager, which gives a native package its
   * memory limit, and tries a scope with a limit, since a manager that runs
   * can still refuse one (no user bus, no permission). Linux only.
   */
  private lookForSystemd(): Promise<void> {
    this.systemdLookup ??= (async () => {
      if (this.deps.machine.platform !== "linux") {
        this.systemd = false;
        return;
      }
      const found = await this.runner.run(["systemctl", "--user", "show-environment"], { timeoutMs: SYSTEMD_TIMEOUT_MS });
      if (found.exitCode !== 0) {
        this.systemd = false;
        return;
      }
      const scope = await this.runner.run(["systemd-run", "--user", "--scope", "--quiet", "-p", "MemoryMax=1G", "--", "true"], {
        timeoutMs: SYSTEMD_TIMEOUT_MS,
      });
      this.systemd = scope.exitCode === 0;
      if (!this.systemd) this.deps.log(`systemd cannot start a scope with a memory limit (exit ${scope.exitCode}): ${scope.stderr.trim().slice(0, 300)}`);
    })().catch((error: unknown) => {
      this.deps.log(`Looking for systemd failed: ${error instanceof Error ? error.message : String(error)}`);
      this.systemd = false;
    });
    return this.systemdLookup;
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
    // An install over a running engine would pull a package next to it and swap tokens under it. Updating goes through update().
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
      if (offer === null || variant === null) return refusal(409, "install.not_offered", { reason: offered.view.reason });

      let plan: InstallPlan | NativePlan;
      let fallback: InstallPlan | null = null;
      let mac: MacPlan | null = null;
      if (variant.kind === "native") {
        // A program on this computer needs no container tool.
        const installed: InstalledNativePackage = { packageVersion: offer.packageVersion, variant: offer.variant, native: variant };
        const pkg = this.packageFor(installed);
        if (pkg === null) return refusal(409, "install.no_runtime");
        plan = { pkg, installed, size: variant.size };
      } else {
        const runtime = this.chosenRuntime();
        // A Mac without a working container tool gets it set up first.
        mac = runtime === null ? this.macNeed() : null;
        if (runtime === null && mac === null) return refusal(409, "install.no_runtime");
        const driver = this.deps.runtimes(runtime?.id ?? "apple-container");
        if (driver === null) return refusal(409, "install.no_runtime");

        // Only a missing passthrough is stored as a note. The other reasons are read from the settings when the view is made.
        const reason = offered.view.gpu.reason;
        plan = this.planFor({
          driver,
          runtime,
          offer,
          variant,
          gpuNote: reason?.code === "gpu.no_passthrough" ? reason : null,
        });
        // The processor package of this same manifest, for when the test run inside the graphics card package fails.
        const { processor } = offered;
        fallback =
          variant.gpu && processor !== null && processor.variant.kind === "container"
            ? this.planFor({
                driver,
                runtime,
                offer: { packageVersion: offer.packageVersion, variant: processor.id },
                variant: processor.variant,
                gpuNote: null,
              })
            : null;
      }
      const steps: InstallStepView[] = [...(mac?.setup.steps(mac.need) ?? []), { id: "engine", size: variant.size }];
      // Refused here, before anything is downloaded, so the operator hears it in the answer to the click.
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
        maxAttempts: variant.kind === "native" ? 1 : PULL_ATTEMPTS,
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

  // Updates ---------------------------------------------------------------

  /** Looks at the newest manifest again and keeps what it says about an update. */
  refreshUpdateOffer(): Promise<void> {
    // Looks one after the other, so the last one to start has the last word.
    this.offerLookup = this.offerLookup.then(() => this.lookForUpdate());
    return this.offerLookup;
  }

  private async lookForUpdate(): Promise<void> {
    if (this.closed) return;
    try {
      const installed = this.settings.get("local.package");
      let next: UpdateOffer | null = null;
      if (installed !== null) {
        const release = await this.deps.manifests.releaseFor(installed.variant);
        if (
          release !== null &&
          // A release is an update of the same kind of package. Moving from a container to a program is a new install.
          release.variant.kind === kindOf(installed).kind &&
          compareVersions(release.packageVersion, installed.packageVersion) > 0
        ) {
          next = { packageVersion: release.packageVersion, size: release.variant.size, variant: release.variant };
        }
      }
      if (this.closed) return;
      this.offer = next;
    } catch (error) {
      this.deps.log(`Looking for an engine update failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.publish();
  }

  /**
   * Why an update or a rollback is refused right now, or null when it may go on.
   * With `exact` the runs are read from the database. Without it the answer
   * may be a second old, which is good enough to show on the page.
   */
  private updateBlock(exact: boolean, state: EngineState | null): ApiError | null {
    if (this.runOnLocalEngine(exact)) return { code: "update.run_in_progress", data: {} };
    // The new version is judged by its answer, so the engine has to be on and answering.
    if (!this.isEnabled() || (state !== "ready" && state !== "busy")) return { code: "update.engine_not_ready", data: {} };
    return null;
  }

  /** True when a run that is not finished sits on the local engine. */
  private runOnLocalEngine(exact: boolean): boolean {
    const engine = this.store.local();
    if (engine === null) return false;
    const now = Date.now();
    const known = this.runCheck;
    if (!exact && known !== null && now - known.at < RUN_CHECK_MAX_AGE_MS) {
      // Nothing tells the manager that a run began or ended, so a view built from an answer that is still young asks again when it has aged.
      this.recheckRunsLater(RUN_CHECK_MAX_AGE_MS - (now - known.at));
      return known.found;
    }
    const found = this.deps.runs.listUnfinished().some((run) => run.engineId === engine.id);
    this.runCheck = { at: now, found };
    return found;
  }

  private recheckRunsLater(ms: number): void {
    if (this.runRecheck !== undefined || this.closed) return;
    this.runRecheck = setTimeout(() => {
      this.runRecheck = undefined;
      this.publish();
    }, ms);
  }

  /** The state of the local engine as the page sees it, or null when there is none. */
  private engineState(): EngineState | null {
    const engine = this.store.local();
    if (engine === null) return null;
    return this.monitor.views().find((candidate) => candidate.id === engine.id)?.state ?? engine.lastState;
  }

  /**
   * Answers once the update has started; the work goes on in the background.
   * The new package is pulled next to the old one, the engine is stopped, and
   * the new version is started on the same data folder. Only an answer from
   * the new version to the info route makes it current. Otherwise the old
   * version is started again.
   */
  update(): Promise<InstallOutcome> {
    return this.beginSwitch("update");
  }

  /** Goes back to the previous version while it exists. Answers once it has started, like update. */
  rollback(): Promise<InstallOutcome> {
    return this.beginSwitch("rollback");
  }

  /**
   * The steps both share. Every refusal comes before the manager is taken,
   * because taking it ends the wait before the restart of a crashed engine.
   */
  private async beginSwitch(kind: PendingSwitch["kind"]): Promise<InstallOutcome> {
    const from = this.settings.get("local.package");
    if (from === null) return refusal(409, "local.not_installed");
    const plan = await this.planSwitch(kind, from);
    if ("refused" in plan) return plan.refused;

    const claimed = await this.claim();
    if (!claimed.ok) return { ok: false, status: 409, error: claimed.error };
    let started = false;
    try {
      // A run may have started, or the engine may have stopped answering, while the claim waited for a restart.
      const again = this.updateBlock(true, this.engineState());
      if (again !== null) return { ok: false, status: 409, error: again };
      const engine = this.store.local();
      if (engine === null) return refusal(409, "local.not_installed");
      this.failure = null;
      this.updateProgress = plan.progress;
      this.monitor.setHeld(engine.id, true);
      started = true;
      this.background = this.runSwitch(kind, from, plan.to)
        .catch((error: unknown) => this.switchCrashed(error))
        .finally(() => {
          this.monitor.setHeld(engine.id, false);
          this.busy = false;
        });
      this.publish();
      return { ok: true };
    } finally {
      if (!started) this.letGo();
    }
  }

  /** Looks at everything that can refuse, and says what the switch would go to and how it begins. */
  private async planSwitch(
    kind: PendingSwitch["kind"],
    from: InstalledPackage,
  ): Promise<{ to: InstalledPackage; progress: InstallProgressView } | { refused: InstallOutcome }> {
    const blocked = this.updateBlock(true, this.engineState());
    if (blocked !== null) return { refused: { ok: false, status: 409, error: blocked } };
    const progress = (phase: "pulling" | "starting", size: number, to: InstalledPackage): InstallProgressView =>
      firstProgress(phase, size, to);

    if (kind === "rollback") {
      const previous = this.settings.get("local.previous");
      if (previous === null) return { refused: refusal(409, "update.no_previous") };
      return { to: previous, progress: progress("starting", kindOf(previous).size, previous) };
    }

    await this.refreshUpdateOffer();
    const offer = this.offer;
    if (offer === null) return { refused: refusal(409, "install.not_offered", { reason: null }) };
    let to: InstalledPackage;
    if (isNativePackage(from)) {
      if (offer.variant.kind !== "native") return { refused: refusal(409, "install.not_offered", { reason: null }) };
      to = { packageVersion: offer.packageVersion, variant: from.variant, native: offer.variant };
    } else {
      if (offer.variant.kind !== "container") return { refused: refusal(409, "install.not_offered", { reason: null }) };
      if (this.deps.runtimes(from.runtime) === null) {
        return { refused: refusal(409, "runtime.not_available", { runtime: from.runtime }) };
      }
      await this.refreshRuntimes(DETECTION_MAX_AGE_MS);
      to = { packageVersion: offer.packageVersion, variant: from.variant, runtime: from.runtime, container: offer.variant };
    }
    const space = await this.packageFor(to)?.preflight();
    if (space !== undefined && !space.ok) return { refused: { ok: false, status: 409, error: space.error } };
    return { to, progress: progress("pulling", offer.size, to) };
  }

  /** Gives the manager back after a refusal that came once it was taken, and lets the watch look at a crashed engine again. */
  private letGo(): void {
    this.busy = false;
    this.restart.checked = false;
    this.watch(this.monitor.views());
  }

  private switchCrashed(error: unknown): void {
    this.deps.log(`Switching the engine version failed: ${error instanceof Error ? error.message : String(error)}`);
    this.endSwitch({ code: "server.internal_error", data: {} });
  }

  private endSwitch(failure: ApiError | null): void {
    this.updateProgress = null;
    if (failure !== null) this.failure = failure;
    this.publish();
  }

  /**
   * Moves the engine from `from` to `to`. Settings name `to` as current only
   * after the new engine has answered with its version. When it does not, the
   * container of `to` is removed and `from` runs again.
   */
  private async runSwitch(kind: PendingSwitch["kind"], from: InstalledPackage, to: InstalledPackage): Promise<void> {
    const engine = this.store.local();
    const oldPkg = this.packageFor(from);
    const newPkg = this.packageFor(to);
    if (engine === null || oldPkg === null || newPkg === null) {
      return this.endSwitch({ code: "runtime.not_available", data: { runtime: kindOf(from).runtime } });
    }

    if (kind === "update") {
      const pulled = await newPkg.install({
        signal: this.abort.signal,
        onProgress: (progress) => {
          this.updateProgress = progress;
          this.publish();
        },
      });
      if (!pulled.ok) return this.endSwitch(pulled.error);
      // The pull takes minutes. A run may have started in the meantime.
      if (this.runOnLocalEngine(true)) {
        await this.dropVersion(to, from);
        return this.endSwitch({ code: "update.run_in_progress", data: {} });
      }
    }

    const pending: PendingSwitch = { kind, from, to, startedAt: new Date(this.now()).toISOString() };
    // Written before the old engine stops, so that if aidm-ui stops from here on, the next start can finish the switch or undo it.
    this.settings.set("local.switch", pending);
    if (this.updateProgress !== null) this.updateProgress = { ...this.updateProgress, phase: "starting" };
    this.publish();
    const stopped = await oldPkg.stop();
    if (!stopped.ok) {
      this.settings.set("local.switch", null);
      await this.dropVersion(to, from);
      return this.endSwitch(stopped.error);
    }
    const started = await this.startEngine(to);
    return this.concludeSwitch(pending, engine.id, newPkg, started.ok);
  }

  /**
   * Ends a switch whose new engine was started: the new version becomes
   * current when it answers with its version, and otherwise the old one runs
   * again. A closing aidm-ui leaves the switch as it is for the next start.
   */
  private async concludeSwitch(pending: PendingSwitch, engineId: number, newPkg: EnginePackage, started: boolean): Promise<void> {
    const { from, to } = pending;
    if (started && (await this.waitForVersion(engineId, to, newPkg))) {
      const droppable = this.settings.get("local.previous");
      this.commitSwitch(engineId, pending);
      // Exactly one previous version is kept. The one before it goes, unless it is one of the two that stay.
      if (droppable !== null) await this.dropVersion(droppable);
      this.updateProgress = null;
      this.publish();
      await this.refreshUpdateOffer();
      return;
    }

    if (this.closed) {
      this.deps.log("aidm-ui is closing while the engine changes version. The next start will finish or undo the change.");
      return this.endSwitch(null);
    }
    this.deps.log(`The engine ${to.packageVersion} did not become ready. Starting ${from.packageVersion} again.`);
    await this.discard(newPkg);
    await this.dropVersion(to, from);
    const restored = await this.startEngine(from);
    this.settings.set("local.switch", null);
    // A start that failed has its own failure, and the engine shows failed with the way to start it again.
    const failure: ApiError = {
      code: pending.kind === "update" ? "update.failed_rolled_back" : "update.rollback_failed",
      data: { version: to.packageVersion },
    };
    this.endSwitch(restored.ok ? failure : null);
  }

  /** The new package becomes current, the old one the previous, in one step. */
  private commitSwitch(engineId: number, pending: PendingSwitch): void {
    this.settings.atomically(() => {
      this.settings.set("local.package", pending.to);
      this.settings.set("local.previous", pending.from);
      this.store.setInstalledVersion(engineId, "container", pending.to.packageVersion);
      this.settings.set("local.switch", null);
    });
  }

  /**
   * aidm-ui stopped while the engine was changing version. The new engine is
   * judged the way it would have been: it becomes current if it answers with
   * its version, and otherwise whatever runs is stopped and the old version
   * is started again.
   */
  private async resumeSwitch(pending: PendingSwitch, engine: EngineRecord): Promise<void> {
    const newPkg = this.packageFor(pending.to);
    if (newPkg === null || this.busy) return;
    this.busy = true;
    this.monitor.setHeld(engine.id, true);
    this.failure = null;
    this.updateProgress = firstProgress("starting", kindOf(pending.to).size, pending.to);
    this.background = (async () => {
      const status = await newPkg.status();
      const running = status.ok && status.value.state === "running" && engine.address !== "";
      if (running) {
        this.token = engine.token;
        this.engineLog.follow(newPkg, { fresh: false });
      }
      this.publish();
      await this.concludeSwitch(pending, engine.id, newPkg, running);
    })()
      .catch((error: unknown) => this.switchCrashed(error))
      .finally(() => {
        this.monitor.setHeld(engine.id, false);
        this.busy = false;
      });
    await this.background;
  }

  /** Waits for the engine to answer the info route with the version of the new package. */
  private async waitForVersion(engineId: number, to: InstalledPackage, pkg: EnginePackage): Promise<boolean> {
    const deadline = Date.now() + (this.deps.updateReadyTimeoutMs ?? UPDATE_READY_TIMEOUT_MS);
    for (;;) {
      // A closing manager does not ask again, but an answer that has come already counts.
      if (!this.closed) await this.monitor.pollNow(engineId);
      const seen = this.monitor.views().find((candidate) => candidate.id === engineId);
      if ((seen?.state === "ready" || seen?.state === "busy") && reportsRelease(seen.info?.version, to.packageVersion)) return true;
      if (this.closed) return false;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      // A container that is gone will not answer, so there is no use in waiting out the time.
      const status = await pkg.status();
      if (status.ok && status.value.state !== "running") return false;
      await this.waitMs(Math.min(READY_POLL_MS, remaining));
    }
  }

  private waitMs(ms: number): Promise<void> {
    if (this.abort.signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const end = () => {
        clearTimeout(timer);
        this.abort.signal.removeEventListener("abort", end);
        resolve();
      };
      const timer = setTimeout(end, ms);
      this.abort.signal.addEventListener("abort", end, { once: true });
    });
  }

  /**
   * Removes a version (its image, or its folder), unless it is the current
   * one, the previous one or one of `alsoKeep`. A failure is logged, since
   * nothing depends on it.
   */
  private async dropVersion(version: InstalledPackage, ...alsoKeep: InstalledPackage[]): Promise<void> {
    const identity = kindOf(version).identity;
    const keep = [this.settings.get("local.package"), this.settings.get("local.previous"), ...alsoKeep];
    if (keep.some((other) => other !== null && kindOf(other).identity === identity)) return;
    try {
      if (isNativePackage(version)) {
        await this.packageFor(version)?.remove();
        return;
      }
      const runtime = this.deps.runtimes(version.runtime);
      const removed = await runtime?.removeImage(identity);
      if (removed !== undefined && !removed.ok) this.deps.log(`An old engine image could not be removed (${removed.error.code}).`);
    } catch (error) {
      this.deps.log(`Removing an old engine version failed: ${error instanceof Error ? error.message : String(error)}`);
    }
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
      if (pkg === null) return fail("runtime.not_available", { runtime: kindOf(installed).runtime });
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
      const pending = this.settings.get("local.switch");
      if (pending !== null) return await this.resumeSwitch(pending, engine);
      const pkg = this.packageFor(installed);
      if (pkg === null) return;
      const status = await pkg.status();
      if (this.closed) return;
      if (status.ok && status.value.state === "running" && engine.address !== "") {
        // Confirmed by the stored token: the engine that answers is the one this
        // data folder started. One that refuses the token is stopped and started fresh.
        const answer = await new TaskClient(
          { address: engine.address, token: engine.token },
          { timeoutMs: CONFIRM_TIMEOUT_MS, log: this.deps.log },
        ).info();
        if (this.closed) return;
        if (answer.ok || answer.failure.kind !== "engine_error") {
          this.token = engine.token;
          this.engineLog.follow(pkg, { fresh: false });
          return;
        }
        this.deps.log("The running engine refused the stored token, so it is started again.");
        await pkg.stop();
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
    this.unsubscribeManifests();
    clearTimeout(this.runRecheck);
    this.listeners.clear();
    await this.background.catch(() => {});
    await this.offerLookup;
    await this.restart.task?.catch(() => {});
    await this.engineLog.stop();
  }

  /** Resolves when the install in the background has ended. For tests. */
  settled(): Promise<unknown> {
    return this.background;
  }

  // Inside ------------------------------------------------------------------

  private async runInstall(
    first: InstallPlan | NativePlan,
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

    if ("variant" in plan && plan.variant.gpu) {
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
        packageKind: kindOf(installed).kind,
        installedVersion: installed.packageVersion,
      });
    } else {
      this.store.update(engine.id, { token });
      this.store.setInstalledVersion(engine.id, kindOf(installed).kind, installed.packageVersion);
    }
    this.settings.set("local.package", installed);
    this.settings.set("local.previous", null);
    this.installing = false;
    await this.startEngine();
    await this.refreshUpdateOffer();
  }

  private pull(plan: InstallPlan | NativePlan, steps: InstallStepView[]): Promise<PackageResult<void>> {
    // The package knows only its own step, the page wants all of them. The engine step has the size of the package being pulled.
    const all = steps.map((step) => (step.id === "engine" ? { ...step, size: plan.size } : step));
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
    if (installed !== null && kindOf(installed).gpu) {
      return this.settings.get("local.forceCpu") ? [{ code: "gpu.forced_cpu", data: {} }] : [];
    }
    // The notes about the graphics card come from the container install, the only one that checks it.
    const container = installed !== null && !isNativePackage(installed) ? installed : null;
    const notes: ApiError[] = [];
    if (this.settings.get("local.gpuCheckFailed") !== null && (installed !== null || this.installing)) {
      notes.push(inImageFailed());
    }
    if (container?.gpuNote) notes.push(container.gpuNote);
    const left = installed === null ? this.packageLeft : (container?.gpuPackageLeft ?? null);
    if (left !== null) notes.push(left);
    return notes;
  }

  /** The note that the container tool cannot hand over the card goes once it can, since the operator may have set it up since. */
  private async recheckGpuNote(): Promise<void> {
    const installed = this.settings.get("local.package");
    if (installed === null || isNativePackage(installed)) return;
    if (installed.gpuNote?.code !== "gpu.no_passthrough" || this.settings.get("local.forceCpu")) return;
    const precheck = await this.gpuPrecheck(this.deps.machine);
    if (precheck.state === "no_passthrough") return;
    const latest = this.settings.get("local.package");
    if (latest === null || isNativePackage(latest)) return;
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
    return { pkg, installed, variant: input.variant, size: input.variant.size };
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

  /** Starts the engine of `target`, or of the installed package. An update starts its new version before it is marked current. */
  private async startEngine(target?: InstalledPackage): Promise<PackageResult<void>> {
    const installed = target ?? this.settings.get("local.package");
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
    if (pkg === null) {
      return this.failStart(engine.id, { code: "runtime.not_available", data: { runtime: kindOf(installed).runtime } });
    }

    // A cap is left out where it cannot be enforced, each one on its own.
    const caps = this.capsNow();
    const kind = kindOf(installed);
    let applied: { memoryBytes: number | null; cpus: number | null };
    if (kind.kind === "native") {
      // Only systemd gives a program a limit, and only for memory.
      await this.lookForSystemd();
      applied = { memoryBytes: this.systemd === true ? caps.memoryBytes : null, cpus: null };
    } else {
      await this.refreshRuntimes(DETECTION_MAX_AGE_MS);
      const detection = this.detections.find((candidate) => candidate.id === kind.runtime);
      applied = {
        memoryBytes: detection?.memoryCapEnforced === false ? null : caps.memoryBytes,
        cpus: detection?.cpuCapEnforced === false ? null : caps.cpus,
      };
    }

    let engineDataFolder: string;
    try {
      engineDataFolder = this.settings.get("engine.dataFolder") ?? join(this.deps.dataFolder, "engine-data");
      // The folder goes into "-v host:container", where a colon would cut it in two, and a relative one means a named volume.
      if (!isAbsolute(engineDataFolder) || (kind.kind === "container" && engineDataFolder.includes(":"))) {
        this.deps.log("The engine data folder must be a full path without a colon. The engine was not started.");
        return this.failStart(engine.id, { code: "server.internal_error", data: {} });
      }
      mkdirSync(engineDataFolder, { recursive: true });
    } catch (error) {
      this.deps.log(`The engine data folder could not be made: ${error instanceof Error ? error.message : String(error)}`);
      return this.failStart(engine.id, { code: "server.internal_error", data: {} });
    }

    let started: PackageResult<{ address: string; memoryCapEnforced?: boolean }> = fail("runtime.start_failed");
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
        gpu: kind.gpu && !this.settings.get("local.forceCpu"),
      });
      if (started.ok || started.error.code !== "runtime.port_in_use") break;
    }
    if (!started.ok) return this.failStart(engine.id, started.error);
    if (started.value.memoryCapEnforced === false && applied.memoryBytes !== null) {
      // The scope with the limit did not work, and the engine runs without one. The view warns, and later starts do not try again.
      this.systemd = false;
      applied = { ...applied, memoryBytes: null };
    }

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
        this.deps.log(`The engine is ${status.value.state}. Starting it again, try ${restart.attempts} of ${RESTART_MAX_ATTEMPTS}.`);
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

  /** The package of what is installed. For a container, the one driven by the runtime that pulled it, or null when this version cannot drive that runtime. */
  private packageFor(installed: InstalledPackage): EnginePackage | null {
    if (isNativePackage(installed)) {
      // One object per version, which holds nothing that changes: the program itself is found through the settings.
      const key = `${installed.packageVersion}:${installed.native.sha256}`;
      let pkg = this.nativePackages.get(key);
      if (pkg === undefined) {
        pkg = new NativePackage({
          ...this.deps.native,
          variant: installed.native,
          variantId: installed.variant,
          version: installed.packageVersion,
          dataFolder: this.deps.dataFolder,
          freeBytes: this.deps.freeBytes,
          settings: this.settings,
          runner: this.runner,
          systemd: () => this.systemd === true,
          children: this.children,
          log: this.deps.log,
        });
        this.nativePackages.set(key, pkg);
      }
      return pkg;
    }
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
