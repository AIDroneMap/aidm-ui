import type { ApiError } from "./api-error.ts";

// Shapes of the JSON the server and the interface exchange.

export interface SettingsView {
  /** The port the server tries first on its next start; null means the default, 8823. */
  port: number | null;
  /** The port the server listens on now. */
  listeningPort: number;
  lan: {
    enabled: boolean;
    /** IPv4 addresses of this computer on the local network, for typing on a tablet. */
    addresses: string[];
  };
}

/** PUT /api/settings/port */
export interface PortSettingRequest {
  port: number | null;
}

/** PUT /api/settings/lan */
export type LanSettingRequest = { enabled: true; passphrase: string } | { enabled: false };

/** POST /api/auth/login */
export interface LoginRequest {
  passphrase: string;
}

/** GET /api/auth/session */
export interface SessionView {
  /** True when this browser must enter the passphrase before using the interface. */
  passphraseRequired: boolean;
}

/** The port the server tries first when neither --port nor the setting names one. */
export const DEFAULT_PORT = 8823;
export const PASSPHRASE_MIN_LENGTH = 8;
/** Longer passphrases are refused before hashing, so one request cannot keep the CPU busy. */
export const PASSPHRASE_MAX_LENGTH = 1024;
export const PORT_MIN = 1;
export const PORT_MAX = 65535;

// Engines (ticket #5). The token never appears in any of these.

/** One state machine for every engine, local or remote. */
export const ENGINE_STATES = [
  "not_installed",
  "installing",
  "starting",
  "ready",
  "busy",
  "unreachable",
  "stopped",
  "failed",
] as const;
export type EngineState = (typeof ENGINE_STATES)[number];

/** What the engine reported in its info call, as the server last read it. Null where the engine sent no usable value. */
export interface EngineInfoView {
  /** The task API version, for example "2.5.0". */
  version: string;
  engineVersion: string | null;
  cpuCores: number | null;
  /** Bytes. */
  totalMemory: number | null;
  /** Bytes. */
  availableMemory: number | null;
  /** Tasks waiting or running on the engine. */
  queueCount: number | null;
  maxParallelTasks: number | null;
  /** Undefined when unreported or invalid; null when the engine reports no limit. */
  maxImages?: number | null;
}

export interface EngineView {
  id: number;
  kind: "local" | "remote";
  name: string;
  address: string;
  enabled: boolean;
  state: EngineState;
  /** False when the task API is older than the oldest supported version; null until the engine has answered once. */
  supported: boolean | null;
  info: EngineInfoView | null;
  /** Why the last call failed, when it did. */
  problem: ApiError | null;
  /** A warning about the address, such as plain HTTP on the local network. */
  warning: ApiError | null;
}

/** POST /api/engines/test and the body of POST /api/engines. */
export interface EngineTestRequest {
  address: string;
  token: string;
}

export interface EngineAddRequest extends EngineTestRequest {
  name: string;
}

/** PUT /api/engines/:id. A missing field is left as it is; a missing token keeps the stored one. */
export interface EngineEditRequest {
  name?: string;
  address?: string;
  token?: string;
  enabled?: boolean;
}

/** The answer of POST /api/engines/test when the engine answered. */
export interface EngineTestView {
  info: EngineInfoView;
  supported: boolean;
  warning: ApiError | null;
}

/** The oldest task API version the interface works with. */
export const MIN_TASK_API_VERSION = "2.5.0";

// Runs and the sample job (ticket #6).

export const RUN_STATES = [
  "created",
  "uploading",
  "queued",
  "processing",
  "completed",
  "failed",
  "cancelled",
  "engine_unreachable",
  "unknown",
] as const;
export type RunState = (typeof RUN_STATES)[number];

/** The states after which a run never changes again. The server and the interface both read this list. */
export const FINISHED_RUN_STATES: readonly RunState[] = ["completed", "failed", "cancelled"];

/** The download of the sample photos, in the same figures as the download of the engine. */
export interface RunDownloadView {
  received: number;
  total: number;
  /** Bytes per second, measured over the last seconds. Null when there is nothing to measure yet. */
  speed: number | null;
  /** How often the connection broke and the download went on from the last byte, and why it last broke. */
  retries: number;
  lastRetry: ApiError | null;
}

export interface RunResultsView {
  state: "fetching" | "ready" | "failed" | "deleted";
  archiveSize: number | null;
  outputs: Array<{ name: string; size: number }>;
}

export interface RunView {
  /** Engine-reported total of running and queued tasks, never a queue position. */
  queueCount?: number | null;
  presetName?: string;
  id: number;
  name: string | null;
  preset: string | null;
  wayIn: "upload" | "import" | "link" | null;
  sample: boolean;
  projectId: number;
  engineId: number | null;
  engineName: string | null;
  /** True when the engine is the one on this computer. Its name is interface text, so the page writes it itself. */
  engineLocal: boolean;
  state: RunState;
  /** What the run does before the engine has it: fetching the dataset, then sending the images. */
  step: "download" | "upload" | "results" | null;
  download: RunDownloadView | null;
  upload: { done: number; total: number } | null;
  /** The engine's own progress, 0 to 100, while it processes. */
  progress: number | null;
  /** The engine's own error message, when the run failed on the engine. */
  engineMessage: string | null;
  /** Why the run failed or stopped on this side, when it did. */
  problem: ApiError | null;
  /** True after the engine restarted and started the run over (ticket #10). */
  restarted: boolean;
  /** Where in the run's log the output of the engine's latest restart begins, or null. A change means the page should ask the log route again. */
  restartedAtLine: number | null;
  /** True when the results archive can be downloaded. */
  resultsAvailable: boolean;
  results?: RunResultsView;
  createdAt: string;
}

export interface SampleDatasetView {
  name: string;
  licence: string;
  licenceUrl: string;
  attribution: string;
  imageCount: number;
  /** Bytes of the download. */
  size: number;
}

/** A measured time on a known test machine, never an estimate for this one. */
export interface ReferenceTimeView {
  architecture: "x86-64" | "arm64";
  seconds: number;
  cores: number;
  memoryGiB: number;
}

export interface SampleEngineOffer {
  engineId: number;
  engineName: string;
  /** True for the engine on this computer. Its name is interface text, so the page writes it itself. */
  local: boolean;
  offered: boolean;
  /** Bytes the engine may use: its memory cap, or the total memory it reports. Null when unknown. */
  memoryCap: number | null;
  /** Why the sample job is not offered on this engine. */
  reason: ApiError | null;
}

export interface SampleView {
  dataset: SampleDatasetView;
  /** The reference time for this computer's architecture, or null when there is none. */
  reference: ReferenceTimeView | null;
  /** Bytes, measured. */
  peakMemory: number;
  engines: SampleEngineOffer[];
  /** The latest sample run, if any. */
  run: RunView | null;
}

/**
 * GET and DELETE /api/sample/dataset: the zip of the sample photos that the
 * data folder keeps, so a later run never downloads it again.
 */
export interface SampleDatasetFileView {
  present: boolean;
  /** Bytes on disk, or null when the zip is not there. */
  size: number | null;
  fileName: string;
}

/** POST /api/sample/start */
export interface SampleStartRequest {
  engineId: number;
}

/** GET /api/runs/:id/log?from=N */
export interface RunLogView {
  lines: string[];
  /** The line number to ask for next. */
  next: number;
  /**
   * The line number in this log where the output of the engine's latest
   * restart begins, or null when the run never restarted. The page draws its
   * own separator there; the server writes no text of its own into the log.
   */
  restartedAtLine: number | null;
}

// Machine check and wizard (ticket #7).

export type CheckResult = "pass" | "warn" | "fail";

export interface CheckLine {
  id: "platform" | "cpu" | "ram" | "disk" | "gpu" | "runtime";
  result: CheckResult;
  /** One sentence for the operator, as a code with its data. */
  message: ApiError;
}

export interface MachineCheckView {
  lines: CheckLine[];
  localEngine: {
    /** True when "Install on this computer" may be offered. */
    offered: boolean;
    /** Why not, when it is not offered. */
    reason: ApiError | null;
  };
  /** When the check ran, ISO 8601. */
  checkedAt: string;
}

export interface WizardView {
  completed: boolean;
}

/** PUT /api/wizard */
export interface WizardUpdateRequest {
  completed: boolean;
}

// Engine packages and the manifest (ticket #8).

export const VARIANT_IDS = ["linux-amd64-cpu", "linux-arm64-cpu", "linux-amd64-gpu", "windows-x64", "darwin-arm64"] as const;
export type VariantId = (typeof VARIANT_IDS)[number];

/** The engine package that fits this computer, from the newest verified manifest. */
export interface EnginePackageOffer {
  packageVersion: string;
  engineVersion: string;
  variant: VariantId;
  kind: "container" | "native";
  /** Bytes to download, from the manifest. */
  size: number;
  /** For the graphics card package: the size of the processor package that takes its place if the test run fails. Null otherwise. */
  processorSize: number | null;
  /** "builtin" for the entry inside aidm-ui, "downloaded" for one fetched from the releases. */
  source: "builtin" | "downloaded";
  /** The release tag the manifest came from, or null for the built-in entry. */
  tag: string | null;
}

export type UpdateCheck = "daily" | "never";

/** Whether the engine will use the NVIDIA graphics card, and the one reason when it will not. */
export interface GpuView {
  /**
   * "used": the graphics card package is offered (a test run after the download still confirms it).
   * "not_used": the checks ran and the processor package is offered; the reason is null when there is no NVIDIA card.
   * "not_checked": the checks do not apply here (not Linux on an Intel or AMD processor) or there is no container tool yet.
   */
  state: "used" | "not_used" | "not_checked";
  reason: ApiError | null;
  /** A page the operator may open to fix the reason. Nothing is fetched from it. Null when there is none. */
  guideUrl: string | null;
}

export interface PackagesView {
  offer: EnginePackageOffer | null;
  gpu: GpuView;
  /** Why there is no offer. */
  reason: ApiError | null;
  /** Null until the operator has answered the question in the wizard. */
  updateCheck: UpdateCheck | null;
  /** The last check for a newer manifest, if any. */
  lastCheck: { at: string; problem: ApiError | null } | null;
}

/** What POST /api/packages/refresh found: the release it read, or why it could not use one. */
export type RefreshResult = { ok: true; tag: string; replaced: boolean } | { ok: false; error: ApiError };

/** POST /api/packages/refresh */
export interface RefreshView {
  result: RefreshResult;
  view: PackagesView;
}

/** PUT /api/settings/update-check */
export interface UpdateCheckRequest {
  value: UpdateCheck;
}

/** The container runtimes the engine manager can drive. */
export const RUNTIME_IDS = ["podman", "docker", "apple-container"] as const;
export type RuntimeId = (typeof RUNTIME_IDS)[number];

// The local engine (ticket #9).

/** The steps of an install. Only a Mac without Apple's container tool has more than "engine". */
export const INSTALL_STEPS = ["installer", "approve", "network", "service", "kernel", "init", "engine"] as const;
export type InstallStepId = (typeof INSTALL_STEPS)[number];

export interface InstallStepView {
  id: InstallStepId;
  /** Bytes the step downloads. Null when nothing is downloaded or the size is not known. */
  size: number | null;
}

export interface InstallProgressView {
  /**
   * "preparing" is every step before the engine's own download.
   * "checking_gpu": the test run inside the graphics card package.
   * "removing_gpu_package": that package failed the test and is being deleted.
   * "pulling" is the download of the engine, "loading" the hand-over of a downloaded image to the container runtime.
   */
  phase: "preparing" | "pulling" | "loading" | "checking_gpu" | "removing_gpu_package" | "starting" | "done" | "failed";
  /** The package this progress is about, so that its size says which download it is. */
  variant: VariantId;
  /** Every step of this install, in order. Complete from the first moment, so the page can list them before any starts. */
  steps: InstallStepView[];
  /** The step under way, or the one that failed. */
  step: InstallStepId;
  /** Bytes the step under way has downloaded, when it reports them. */
  stepReceived: number | null;
  /** Bytes of that package, from the manifest. For the engine's download, once it reports its total, the bytes it fetches. */
  size: number;
  /** Bytes of the image the container runtime already holds, which the download leaves out. Absent or null: nothing is reused. */
  reusedBytes?: number | null;
  /** Parts of the image finished and in all (its config and layers). The page calls them parts. */
  layersDone: number | null;
  layersTotal: number | null;
  /** Bytes per second of the download under way, measured over its last seconds. Null when there is nothing to measure. */
  speed: number | null;
  /** How often the download's connection broke and it went on from the last byte, and why it last broke. */
  retries: number;
  lastRetry: ApiError | null;
}

export interface CapsView {
  /** What the engine may use from its next start. */
  memoryBytes: number;
  cpus: number;
  /** The most the operator may give it: total RAM minus the reserve, and every core. */
  maxMemoryBytes: number;
  maxCpus: number;
  /** What the running engine got, or null when it is not running. Null memory means no cap. */
  applied: { memoryBytes: number | null; cpus: number | null } | null;
}

export interface LocalEngineView {
  /** The operating system of the computer the server runs on, as Node names it: "linux", "darwin" or "win32". */
  platform: string;
  /** Null until a package is installed. */
  installed: { packageVersion: string; variant: VariantId; kind: "container" | "native"; runtime: RuntimeId | null } | null;
  /** The engine's row in the engines list, once there is one. */
  engineId: number | null;
  /** The switch "Run the engine on this computer". Off means the engine is stopped and stays so. */
  enabled: boolean;
  /**
   * True when the engine is installed and switched on but failed, whatever the
   * reason: the page offers "Start the engine again" (POST /api/local-engine/start).
   */
  startAgain: boolean;
  state: EngineState;
  install: InstallProgressView | null;
  /**
   * What an install would do on this computer, step by step with sizes, when it is more than the engine alone:
   * a Mac without Apple's container tool. Null otherwise. Lets the page list the steps before the first click.
   */
  plan: InstallStepView[] | null;
  caps: CapsView;
  runtime: {
    /** The runtime the engine uses or would use. */
    chosen: RuntimeId | null;
    available: RuntimeId[];
    /** The operator's own choice, or null for automatic. */
    preferred: RuntimeId | null;
  };
  /** For example local.memory_cap_not_enforced, or why the installed engine does not use the graphics card. */
  warnings: ApiError[];
  /** True when the operator chose to use the processor only. */
  forceCpu: boolean;
  problem: ApiError | null;
  /** While an install runs again after one that failed: why that one stopped. Null otherwise. */
  lastTry: ApiError | null;
  /**
   * While the manager brings back an engine that crashed: the try it is on (from 1),
   * the most tries in a row, and when the next one starts (ISO 8601, null while one is running).
   * Null when no restart is going on.
   */
  restarts: { attempts: number; max: number; nextAt: string | null } | null;
  update: LocalEngineUpdateView;
  /**
   * How aidm-ui reaches the engine on Apple's tool, and what stands in the way
   * when it runs and does not answer (ADR 0006). Null for any other runtime.
   */
  connection: LocalConnectionView | null;
}

export interface LocalConnectionView {
  /** "socket": through a Unix socket, with no network. "port": through a port the tool publishes on 127.0.0.1. */
  via: "socket" | "port";
  /** Why the engine runs and does not answer from this Mac: mac.vpn_route, mac.local_network_denied or mac.engine_unreachable. */
  problem: ApiError | null;
  /** Another interface of this Mac uses the addresses of the tool's network: mac.subnet_conflict. */
  conflict: ApiError | null;
  /** Moving the tool's network to other addresses can help (POST /api/local-engine/network/move). */
  canMove: boolean;
}

/** Updates, rollback and the one previous version (ticket #14). */
export interface LocalEngineUpdateView {
  /** A newer package for the installed variant, from the newest manifest that passed every check. */
  available: { packageVersion: string; size: number } | null;
  /** The version kept next to the current one, so the operator can go back. */
  previous: { packageVersion: string } | null;
  /** Why Update and the way back are refused right now, for example update.run_in_progress. */
  blockedBy: ApiError | null;
  /** The update or the way back under way, in the same shape as an install. */
  applying: InstallProgressView | null;
}

// Lifecycle (ticket #10).

/** PUT /api/local-engine/enabled */
export interface LocalEngineEnabledRequest {
  enabled: boolean;
}

/** PUT /api/local-engine/caps */
export interface CapsRequest {
  memoryBytes: number;
  cpus: number;
}

/** PUT /api/settings/runtime */
export interface RuntimeChoiceRequest {
  runtime: RuntimeId | null;
}

// Setting up a container tool (ticket #12).

/** Where the setup of Podman stands. The first three are the steps, in order. */
export const SETUP_PHASES = ["approval", "installing", "checking", "done", "failed"] as const;
export type SetupPhase = (typeof SETUP_PHASES)[number];

export interface RuntimeSetupView {
  phase: SetupPhase;
  /** Why it failed, when it did. */
  problem: ApiError | null;
}

/** PUT /api/local-engine/force-cpu */
export interface ForceCpuRequest {
  forceCpu: boolean;
}

/** Project facts shown in the list and project page. */
export interface ProjectView {
  resultsBytes?: number;
  resultArchives?: Array<{ runId: number; size: number }>;
  id: number;
  name: string;
  notes: string;
  builtin: "sample" | null;
  photoCount: number | null;
  runCount: number;
  latestState: RunState | null;
  /** Latest persisted metadata, source, or run update. */
  lastChange: string;
}

export interface ProjectWriteRequest { name: string; notes: string }
export interface UploadRequest { name: string; size: number; sha256: string }
export interface UploadSessionView { id: string; chunkSize: number; received: number[]; complete: boolean }
export interface UploadedFileView { name: string; size: number; sha256: string; kind: "photo" | "mask" | "video" }
export interface UploadedFilesView { files: UploadedFileView[]; nextOffset: number | null }

export interface PhotoFlightView {
  id: string;
  make: string | null;
  model: string | null;
  clock: "camera" | "offset";
  first: string;
  last: string;
  photoCount: number;
  excludedPhotoCount: number;
}
export interface ProjectPhotoFactsView {
  photoCount: number;
  photoBytes: number;
  duplicates: number;
  videoCount: number;
  withoutGps: number;
  cameras: Array<{ make: string | null; model: string | null; photoCount: number }>;
  bands: Array<{ name: string; photoCount: number }>;
  dateSpans: Array<{ clock: "camera" | "offset"; first: string; last: string }>;
  flights: PhotoFlightView[];
  flightCount: number;
  unassignedCount: number;
  pendingMetadata: number;
  nextOffset: number | null;
}

export interface FolderImportView {
  available: boolean;
  state: "none" | "ready" | "changed" | "missing";
  path: string | null;
  acceptedCount: number;
  skippedCount: number;
  groundControlCount: number;
  files: Array<{ name: string; size: number; kind: "photo" | "mask" | "video" }>;
  nextOffset: number | null;
}
