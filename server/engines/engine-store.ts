import type { Database } from "bun:sqlite";
import { ENGINE_STATES, type EngineState } from "../../shared/api-types.ts";

/** One row of the engines table. The token is here and nowhere in what the browser gets. */
export interface EngineRecord {
  id: number;
  kind: "local" | "remote";
  packageKind: "native" | "container" | null;
  name: string;
  address: string;
  token: string;
  enabled: boolean;
  installedVersion: string | null;
  lastState: EngineState;
}

interface EngineRow {
  id: number;
  kind: "local" | "remote";
  package_kind: "native" | "container" | null;
  name: string;
  address: string;
  token: string;
  enabled: number;
  installed_version: string | null;
  last_state: string;
}

export interface EnginePatch {
  name?: string;
  address?: string;
  token?: string;
  enabled?: boolean;
}

function toRecord(row: EngineRow): EngineRecord {
  return {
    id: row.id,
    kind: row.kind,
    packageKind: row.package_kind,
    name: row.name,
    address: row.address,
    token: row.token,
    enabled: row.enabled === 1,
    installedVersion: row.installed_version,
    lastState: (ENGINE_STATES as readonly string[]).includes(row.last_state) ? (row.last_state as EngineState) : "starting",
  };
}

export class EngineStore {
  constructor(private readonly db: Database) {}

  list(): EngineRecord[] {
    return (this.db.query("SELECT * FROM engines ORDER BY id").all() as EngineRow[]).map(toRecord);
  }

  get(id: number): EngineRecord | null {
    const row = this.db.query("SELECT * FROM engines WHERE id = ?").get(id) as EngineRow | null;
    return row === null ? null : toRecord(row);
  }

  addRemote(engine: { name: string; address: string; token: string }): EngineRecord {
    const row = this.db
      .query(
        `INSERT INTO engines (kind, name, address, token, enabled, last_state)
         VALUES ('remote', ?, ?, ?, 1, 'starting') RETURNING *`,
      )
      .get(engine.name, engine.address, engine.token) as EngineRow;
    return toRecord(row);
  }

  /** Changes the fields given and leaves the others. Null when there is no such engine. */
  update(id: number, patch: EnginePatch): EngineRecord | null {
    const current = this.get(id);
    if (current === null) return null;
    this.db
      .query("UPDATE engines SET name = ?, address = ?, token = ?, enabled = ? WHERE id = ?")
      .run(
        patch.name ?? current.name,
        patch.address ?? current.address,
        patch.token ?? current.token,
        (patch.enabled ?? current.enabled) ? 1 : 0,
        id,
      );
    return this.get(id);
  }

  /** True when an engine was removed. */
  remove(id: number): boolean {
    return this.db.query("DELETE FROM engines WHERE id = ?").run(id).changes > 0;
  }

  setLastState(id: number, state: EngineState): void {
    this.db.query("UPDATE engines SET last_state = ? WHERE id = ?").run(state, id);
  }
}
