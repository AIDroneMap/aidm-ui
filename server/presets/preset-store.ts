import type { Database } from "bun:sqlite";
import type { SavedPreset, SettingsFile } from "../../shared/settings-file.ts";

type Row = { id: number; name: string; engine_version: string | null; options: string };
export class PresetStore {
  constructor(private readonly db: Database) {}
  private view(row: Row): SavedPreset { return { id: row.id, preset: row.name, engineVersion: row.engine_version, options: JSON.parse(row.options) }; }
  list(offset = 0) {
    const rows = this.db.query("SELECT id, name AS preset, engine_version AS engineVersion FROM operator_presets ORDER BY id DESC LIMIT 51 OFFSET ?").all(offset) as Array<Pick<SavedPreset, "id" | "preset" | "engineVersion">>;
    return { presets: rows.slice(0, 50), nextOffset: rows.length > 50 ? offset + 50 : null };
  }
  get(id: number): SavedPreset | null {
    const row = this.db.query("SELECT * FROM operator_presets WHERE id = ?").get(id) as Row | null;
    return row ? this.view(row) : null;
  }
  create(file: SettingsFile): SavedPreset | null {
    const row = this.db.query("INSERT INTO operator_presets (name, engine_version, options) VALUES (?, ?, ?) ON CONFLICT(name) DO NOTHING RETURNING *").get(file.preset, file.engineVersion, JSON.stringify(file.options)) as Row | null;
    return row ? this.view(row) : null;
  }
  rename(id: number, name: string): SavedPreset | "missing" | "name_taken" {
    const row = this.db.query("UPDATE operator_presets SET name = ? WHERE id = ? AND NOT EXISTS (SELECT 1 FROM operator_presets WHERE name = ? AND id <> ?) RETURNING *").get(name, id, name, id) as Row | null;
    return row ? this.view(row) : this.get(id) ? "name_taken" : "missing";
  }
  remove(id: number): boolean { return this.db.query("DELETE FROM operator_presets WHERE id = ?").run(id).changes > 0; }
}
