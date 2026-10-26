import type { Database } from "bun:sqlite";
import type { ApiError } from "../../shared/api-error.ts";
import type { UpdateCheck } from "../../shared/api-types.ts";
import type { RuntimeId } from "../runtimes/runtime.ts";

export interface SettingValues {
  /** The port tried first on the next start; null means the default. */
  "server.port": number | null;
  "lan.enabled": boolean;
  /** Argon2id hash of the passphrase for the local network. */
  "lan.passphraseHash": string | null;
  /** The container runtime the operator chose over the automatic pick; null means automatic. */
  "runtime.preferred": RuntimeId | null;
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

  set<K extends keyof SettingValues>(key: K, value: SettingValues[K]): void {
    this.db
      .query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .run(key, JSON.stringify(value));
  }
}
