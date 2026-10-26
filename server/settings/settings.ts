import type { Database } from "bun:sqlite";

export interface SettingValues {
  /** The port tried first on the next start; null means the default. */
  "server.port": number | null;
  "lan.enabled": boolean;
  /** Argon2id hash of the passphrase for the local network. */
  "lan.passphraseHash": string | null;
}

const DEFAULTS: SettingValues = {
  "server.port": null,
  "lan.enabled": false,
  "lan.passphraseHash": null,
};

export class Settings {
  constructor(private readonly db: Database) {}

  get<K extends keyof SettingValues>(key: K): SettingValues[K] {
    const row = this.db.query("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | null;
    if (row === null) return DEFAULTS[key];
    return JSON.parse(row.value) as SettingValues[K];
  }

  set<K extends keyof SettingValues>(key: K, value: SettingValues[K]): void {
    this.db
      .query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .run(key, JSON.stringify(value));
  }
}
