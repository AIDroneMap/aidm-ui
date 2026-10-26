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

export interface RunView {
  id: number;
  projectId: number;
  engineId: number | null;
  engineName: string | null;
  /** True when the engine is the one on this computer. Its name is interface text, so the page writes it itself. */
  engineLocal: boolean;
  state: RunState;
  /** What the run does before the engine has it: fetching the dataset, then sending the images. */
  step: "download" | "upload" | null;
  download: { received: number; total: number } | null;
  upload: { done: number; total: number } | null;
  /** The engine's own progress, 0 to 100, while it processes. */
  progress: number | null;
  /** The engine's own error message, when the run failed on the engine. */
  engineMessage: string | null;
  /** Why the run failed or stopped on this side, when it did. */
  problem: ApiError | null;
  /** True after the engine restarted and started the run over (ticket #10). */
  restarted: boolean;
  /** True when the results archive can be downloaded. */
  resultsAvailable: boolean;
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

/** POST /api/sample/start */
export interface SampleStartRequest {
  engineId: number;
}

/** GET /api/runs/:id/log?from=N */
export interface RunLogView {
  lines: string[];
  /** The line number to ask for next. */
  next: number;
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
  /** "builtin" for the entry inside aidm-ui, "downloaded" for one fetched from the releases. */
  source: "builtin" | "downloaded";
  /** The release tag the manifest came from, or null for the built-in entry. */
  tag: string | null;
}

export type UpdateCheck = "daily" | "never";

export interface PackagesView {
  offer: EnginePackageOffer | null;
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

export interface InstallProgressView {
  phase: "pulling" | "starting" | "done" | "failed";
  /** Bytes to download, from the manifest. */
  size: number;
  /** Image layers finished and in all, when the runtime's output says so. */
  layersDone: number | null;
  layersTotal: number | null;
  /** The current try of the pull, from 1. */
  attempt: number;
  maxAttempts: number;
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
  /** Null until a package is installed. */
  installed: { packageVersion: string; variant: VariantId; kind: "container" | "native"; runtime: RuntimeId | null } | null;
  /** The engine's row in the engines list, once there is one. */
  engineId: number | null;
  state: EngineState;
  install: InstallProgressView | null;
  caps: CapsView;
  runtime: {
    /** The runtime the engine uses or would use. */
    chosen: RuntimeId | null;
    available: RuntimeId[];
    /** The operator's own choice, or null for automatic. */
    preferred: RuntimeId | null;
  };
  /** For example local.memory_cap_not_enforced. */
  warnings: ApiError[];
  problem: ApiError | null;
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
