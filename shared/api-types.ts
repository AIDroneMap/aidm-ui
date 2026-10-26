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
