import type { Database } from "bun:sqlite";
import type { ApiError } from "../../shared/api-error.ts";
import { FINISHED_RUN_STATES, RUN_STATES, type RunState } from "../../shared/api-types.ts";
import type { TaskOption } from "../task-api/task-client.ts";

/** One row of the runs table. */
export interface RunRecord {
  taskRetired: boolean;
  restartPending: boolean;
  presetName?: string;
  id: number;
  projectId: number;
  name: string | null;
  preset: string | null;
  wayIn: "upload" | "import" | "link" | null;
  sample: boolean;
  engineId: number | null;
  taskUuid: string | null;
  options: TaskOption[];
  state: RunState;
  progress: number | null;
  engineMessage: string | null;
  problem: ApiError | null;
  restarted: boolean;
  /** Where in the log the engine's latest restart begins, or null. */
  restartedAtLine: number | null;
  createdAt: string;
  updatedAt: string;
}

interface RunRow {
  task_retired: number;
  restart_pending: number;
  preset_name: string | null;
  id: number;
  project_id: number;
  name: string | null;
  preset: string | null;
  way_in: "upload" | "import" | "link" | null;
  sample: number;
  engine_id: number | null;
  task_uuid: string | null;
  options: string;
  state: string;
  progress: number | null;
  engine_message: string | null;
  problem: string | null;
  restarted: number;
  restarted_at_line: number | null;
  created_at: string;
  updated_at: string;
}

export interface RunPatch {
  restartPending?: boolean;
  taskUuid?: string | null;
  state?: RunState;
  progress?: number | null;
  engineMessage?: string | null;
  problem?: ApiError | null;
  /** Set when the engine started the task over. */
  restarted?: boolean;
  /** Where in the log the engine's latest restart begins. */
  restartedAtLine?: number | null;
}

function parseJson<T>(text: string | null, fallback: T): T {
  if (text === null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function toRecord(row: RunRow): RunRecord {
  return {
    taskRetired: row.task_retired === 1,
    restartPending: row.restart_pending === 1,
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    preset: row.preset,
    ...(typeof row.preset_name === "string" ? { presetName: row.preset_name } : {}),
    wayIn: row.way_in,
    sample: row.sample === 1,
    engineId: row.engine_id,
    taskUuid: row.task_uuid,
    options: parseJson<TaskOption[]>(row.options, []),
    state: (RUN_STATES as readonly string[]).includes(row.state) ? (row.state as RunState) : "unknown",
    progress: row.progress,
    engineMessage: row.engine_message,
    problem: parseJson<ApiError | null>(row.problem, null),
    restarted: row.restarted === 1,
    restartedAtLine: row.restarted_at_line,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const FINISHED_STATES = `(${FINISHED_RUN_STATES.map((state) => `'${state}'`).join(", ")})`;

export class RunStore {
  constructor(private readonly db: Database) {}

  retireTask(engine: number, uuid: string, owner: number): void {
    this.db.query("UPDATE runs SET task_retired = 1 WHERE engine_id = ? AND task_uuid = ? AND id <> ?").run(engine, uuid, owner);
  }

  taskRuns(engine: number, uuid: string): RunRecord[] {
    return (this.db.query("SELECT * FROM runs WHERE engine_id = ? AND task_uuid = ?").all(engine, uuid) as RunRow[]).map(toRecord);
  }

  list(project: number, offset: number, limit: number): RunRecord[] {
    return (this.db.query("SELECT * FROM runs WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?").all(project, limit, offset) as RunRow[]).map(toRecord);
  }

  remove(id: number): void { this.db.query("DELETE FROM runs WHERE id = ?").run(id); }

  completed(): RunRecord[] {
    return (this.db.query("SELECT * FROM runs WHERE state = 'completed' AND task_uuid IS NOT NULL").all() as RunRow[]).map(toRecord);
  }

  results<T>(id: number): T | null {
    const row = this.db.query("SELECT details FROM run_results WHERE run_id = ?").get(id) as { details: string } | null;
    return row === null ? null : JSON.parse(row.details) as T;
  }

  saveResults(id: number, details: unknown): void {
    this.db.query("INSERT INTO run_results (run_id, details) VALUES (?, ?) ON CONFLICT (run_id) DO UPDATE SET details = excluded.details")
      .run(id, JSON.stringify(details));
  }

  source<T>(id: number): T | null {
    const row = this.db.query("SELECT details FROM run_sources WHERE run_id = ?").get(id) as { details: string } | null;
    return row ? JSON.parse(row.details) as T : null;
  }

  saveSource(id: number, source: unknown): void {
    this.db.query("INSERT INTO run_sources (run_id, details) VALUES (?, ?)").run(id, JSON.stringify(source));
  }

  /** The id of a built-in project, such as "sample". */
  builtinProjectId(builtin: string): number | null {
    const row = this.db.query("SELECT id FROM projects WHERE builtin = ?").get(builtin) as { id: number } | null;
    return row?.id ?? null;
  }

  create(run: { projectId: number; engineId: number; options: TaskOption[]; name?: string | null; preset?: string | null; presetName?: string | null; wayIn?: "upload" | "import" | "link" | null; sample?: boolean }): RunRecord {
    return this.db.transaction(() => {
      // Deleted runs keep their IDs reserved, including across server restarts.
      const { id } = this.db.query(`INSERT INTO settings (key, value)
        VALUES ('runs.lastId', CAST((SELECT COALESCE(MAX(id), 0) + 1 FROM runs) AS TEXT))
        ON CONFLICT (key) DO UPDATE SET value = CAST(MAX(CAST(settings.value AS INTEGER) + 1, CAST(excluded.value AS INTEGER)) AS TEXT)
        RETURNING CAST(value AS INTEGER) AS id`).get() as { id: number };
      const now = new Date().toISOString();
      const row = this.db
        .query(
          `INSERT INTO runs (id, project_id, engine_id, options, state, created_at, updated_at, name, preset, preset_name, way_in, sample)
           VALUES (?, ?, ?, ?, 'created', ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        )
        .get(id, run.projectId, run.engineId, JSON.stringify(run.options), now, now, run.name ?? null, run.preset ?? null, run.presetName ?? null, run.wayIn ?? null, run.sample ? 1 : 0) as RunRow;
      return toRecord(row);
    })();
  }

  get(id: number): RunRecord | null {
    const row = this.db.query("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | null;
    return row === null ? null : toRecord(row);
  }

  latestForProject(projectId: number): RunRecord | null {
    const row = this.db
      .query("SELECT * FROM runs WHERE project_id = ? ORDER BY id DESC LIMIT 1")
      .get(projectId) as RunRow | null;
    return row === null ? null : toRecord(row);
  }

  /**
   * Changes the fields given and leaves the others. Null when there is no such
   * run. A finished run never changes again: it is returned as it is stored.
   */
  update(id: number, patch: RunPatch): RunRecord | null {
    const current = this.get(id);
    if (current === null) return null;
    if (FINISHED_RUN_STATES.includes(current.state)) return current;
    const next = {
      restartPending: patch.restartPending ?? current.restartPending,
      taskUuid: patch.taskUuid === undefined ? current.taskUuid : patch.taskUuid,
      state: patch.state ?? current.state,
      progress: patch.progress === undefined ? current.progress : patch.progress,
      engineMessage: patch.engineMessage === undefined ? current.engineMessage : patch.engineMessage,
      problem: patch.problem === undefined ? current.problem : patch.problem,
      restarted: patch.restarted ?? current.restarted,
      restartedAtLine: patch.restartedAtLine === undefined ? current.restartedAtLine : patch.restartedAtLine,
    };
    this.db
      .query(
        `UPDATE runs SET restart_pending = ?, task_uuid = ?, state = ?, progress = ?, engine_message = ?, problem = ?, restarted = ?, restarted_at_line = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        next.restartPending ? 1 : 0,
        next.taskUuid,
        next.state,
        next.progress,
        next.engineMessage,
        next.problem === null ? null : JSON.stringify(next.problem),
        next.restarted ? 1 : 0,
        next.restartedAtLine,
        new Date().toISOString(),
        id,
      );
    return this.get(id);
  }

  /** Runs that have a task on an engine and are not finished. */
  listActive(): RunRecord[] {
    const rows = this.db
      .query(`SELECT * FROM runs WHERE task_uuid IS NOT NULL AND state NOT IN ${FINISHED_STATES} ORDER BY id`)
      .all() as RunRow[];
    return rows.map(toRecord);
  }

  /** Runs that are not finished, whether or not the engine has them yet. */
  listUnfinished(): RunRecord[] {
    const rows = this.db.query(`SELECT * FROM runs WHERE state NOT IN ${FINISHED_STATES} ORDER BY id`).all() as RunRow[];
    return rows.map(toRecord);
  }
}
