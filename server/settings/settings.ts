import type { Database } from "bun:sqlite";
import type { ApiError } from "../../shared/api-error.ts";
import type { UpdateCheck, VariantId } from "../../shared/api-types.ts";
import type { ManifestVariant } from "../manifest/schema.ts";
import type { RuntimeId } from "../runtimes/runtime.ts";

/** The engine package installed on this computer. Enough to find, stop and remove it again. */
export interface InstalledPackage {
  packageVersion: string;
  variant: VariantId;
  /** The runtime that pulled the image, and so the one that has it. */
  runtime: RuntimeId;
  /** What the manifest said about the image at install time. */
  container: Extract<ManifestVariant, { kind: "container" }>;
  /** Why the processor package was chosen on a computer with an NVIDIA card: the container tool cannot hand the card over. */
  gpuNote?: ApiError | null;
  /** Set when the graphics card package failed its test run and could not be deleted. */
  gpuPackageLeft?: ApiError | null;
}

/** A change of engine version that has begun and not yet ended. It lets the next start finish or undo it. */
export interface PendingSwitch {
  kind: "update" | "rollback";
  /** The package that was current when the switch began. */
  from: InstalledPackage;
  /** The package the engine is being switched to. */
  to: InstalledPackage;
  /** An ISO time. */
  startedAt: string;
}

export interface SettingValues {
  /** The port tried first on the next start; null means the default. */
  "server.port": number | null;
  "lan.enabled": boolean;
  /** Argon2id hash of the passphrase for the local network. */
  "lan.passphraseHash": string | null;
  /** The container runtime the operator chose over the automatic pick; null means automatic. */
  "runtime.preferred": RuntimeId | null;
  /** Where the local engine keeps its data; null means the engine-data folder in the data folder. */
  "engine.dataFolder": string | null;
  /** The local engine's package; null until one is installed. */
  "local.package": InstalledPackage | null;
  /** The version kept next to the current one after an update or a rollback; null when there is none. */
  "local.previous": InstalledPackage | null;
  /** Set from just before the old engine is stopped until the new version is current or the old one is back; null otherwise. */
  "local.switch": PendingSwitch | null;
  /** The switch for the local engine. Off: the manager keeps it stopped, also when aidm-ui starts. */
  "local.enabled": boolean;
  /** The caps the operator lowered, used from the next start; null means the most the computer allows. */
  "local.memoryBytes": number | null;
  "local.cpus": number | null;
  /** True when the operator chose the processor package and no graphics card, whatever the checks say. */
  "local.forceCpu": boolean;
  /** The graphics card package whose test run failed, by digest. It is not chosen again; a newer digest is tried. */
  "local.gpuCheckFailed": { digest: string; at: string } | null;
  /** What the running local engine was started with; null when it is not running. Null memory means no cap. */
  "local.applied": { memoryBytes: number | null; cpus: number | null } | null;
  /** True once the operator has finished the wizard or chosen the interface only. */
  "wizard.completed": boolean;
  /** How often to look for a newer manifest; null until the operator has answered. */
  "updates.check": UpdateCheck | null;
  /** The last look for a newer manifest: when it ended and what went wrong, if anything. */
  "updates.lastCheck": { at: string; problem: ApiError | null } | null;
  /** When the last look that worked ended, as an ISO time. A failed look does not move it. */
  "updates.lastSuccess": string | null;
  /** The newest verified downloaded manifest. It is verified again on every load. */
  "manifest.held": { bytes: string; signature: string; tag: string } | null;
  /** The highest manifest sequence ever accepted. A lower one is refused even when the held manifest is gone. */
  "manifest.sequenceFloor": number;
}

const DEFAULTS: SettingValues = {
  "server.port": null,
  "lan.enabled": false,
  "lan.passphraseHash": null,
  "runtime.preferred": null,
  "engine.dataFolder": null,
  "local.package": null,
  "local.previous": null,
  "local.switch": null,
  "local.enabled": true,
  "local.memoryBytes": null,
  "local.cpus": null,
  "local.applied": null,
  "local.forceCpu": false,
  "local.gpuCheckFailed": null,
  "wizard.completed": false,
  "updates.check": null,
  "updates.lastCheck": null,
  "updates.lastSuccess": null,
  "manifest.held": null,
  "manifest.sequenceFloor": 0,
};

export class Settings {
  constructor(private readonly db: Database) {}

  get<K extends keyof SettingValues>(key: K): SettingValues[K] {
    const row = this.db.query("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | null;
    if (row === null) return DEFAULTS[key];
    return JSON.parse(row.value) as SettingValues[K];
  }

  /** The stored text of a setting, or null when it was never written. Cheap to compare, so a cache can tell when a value changed. */
  getRaw(key: keyof SettingValues): string | null {
    const row = this.db.query("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | null;
    return row === null ? null : row.value;
  }

  /** Runs the changes as one: all of them are stored, or none. Other tables that share the connection are part of it. */
  atomically<T>(changes: () => T): T {
    return this.db.transaction(changes)();
  }

  set<K extends keyof SettingValues>(key: K, value: SettingValues[K]): void {
    this.db
      .query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .run(key, JSON.stringify(value));
  }
}
