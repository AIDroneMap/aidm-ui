import type { Database } from "bun:sqlite";
import type { ApiError } from "../../shared/api-error.ts";
import { RUN_STATES, type RunState } from "../../shared/api-types.ts";
import type { TaskOption } from "../task-api/task-client.ts";

/** One row of the runs table. */
export interface RunRecord {
  id: number;
  projectId: number;
  engineId: number | null;
  taskUuid: string | null;
  options: TaskOption[];
  state: RunState;
  progress: number | null;
  engineMessage: string | null;
  problem: ApiError | null;
  restarted: boolean;
  createdAt: string;
  updatedAt: string;
}

interface RunRow {
  id: number;
  project_id: number;
  engine_id: number | null;
  task_uuid: string | null;
  options: string;
  state: string;
  progress: number | null;
  engine_message: string | null;
  problem: string | null;
  restarted: number;
  created_at: string;
  updated_at: string;
}

export interface RunPatch {
  taskUuid?: string | null;
  state?: RunState;
  progress?: number | null;
  engineMessage?: string | null;
  problem?: ApiError | null;
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
    id: row.id,
    projectId: row.project_id,
    engineId: row.engine_id,
    taskUuid: row.task_uuid,
    options: parseJson<TaskOption[]>(row.options, []),
    state: (RUN_STATES as readonly string[]).includes(row.state) ? (row.state as RunState) : "unknown",
    progress: row.progress,
    engineMessage: row.engine_message,
    problem: parseJson<ApiError | null>(row.problem, null),
    restarted: row.restarted === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const FINISHED_STATES = "('completed', 'failed', 'cancelled')";

export class RunStore {
  constructor(private readonly db: Database) {}

  /** The id of a built-in project, such as "sample". */
  builtinProjectId(builtin: string): number | null {
    const row = this.db.query("SELECT id FROM projects WHERE builtin = ?").get(builtin) as { id: number } | null;
    return row?.id ?? null;
  }

  create(run: { projectId: number; engineId: number; options: TaskOption[] }): RunRecord {
    const now = new Date().toISOString();
    const row = this.db
      .query(
        `INSERT INTO runs (project_id, engine_id, options, state, created_at, updated_at)
         VALUES (?, ?, ?, 'created', ?, ?) RETURNING *`,
      )
      .get(run.projectId, run.engineId, JSON.stringify(run.options), now, now) as RunRow;
    return toRecord(row);
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

  /** Changes the fields given and leaves the others. Null when there is no such run. */
  update(id: number, patch: RunPatch): RunRecord | null {
    const current = this.get(id);
    if (current === null) return null;
    const next = {
      taskUuid: patch.taskUuid === undefined ? current.taskUuid : patch.taskUuid,
      state: patch.state ?? current.state,
      progress: patch.progress === undefined ? current.progress : patch.progress,
      engineMessage: patch.engineMessage === undefined ? current.engineMessage : patch.engineMessage,
      problem: patch.problem === undefined ? current.problem : patch.problem,
    };
    this.db
      .query(
        `UPDATE runs SET task_uuid = ?, state = ?, progress = ?, engine_message = ?, problem = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        next.taskUuid,
        next.state,
        next.progress,
        next.engineMessage,
        next.problem === null ? null : JSON.stringify(next.problem),
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
