import { lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import type { EngineStore } from "../engines/engine-store.ts";
import { isTaskNotFound, TaskClient } from "../task-api/task-client.ts";
import type { ProjectStore } from "./project-store.ts";

/** Removes engine tasks before touching local records or files. */
export class ProjectDeletion {
  private readonly deleting = new Set<number>();
  constructor(private readonly projects: ProjectStore, private readonly engines: EngineStore, private readonly folder: string, private readonly log: (line: string) => void) {}

  isDeleting(id: number): boolean { return this.deleting.has(id); }

  async delete(id: number): Promise<"ok" | "not_found" | "busy" | "incomplete" | "engine_missing"> {
    if (this.deleting.has(id)) return "busy";
    if (this.projects.get(id) === null) return "not_found";
    this.deleting.add(id);
    try {
      const runs = this.projects.runs(id);
      // Preparation can still create a task or upload photos. Wait until it finishes.
      if (runs.some(run => run.state === "created" || run.state === "uploading")) return "busy";
      let failed = false;
      let missingEngine = false;
      for (const run of runs) {
        if (run.taskUuid === null) continue;
        const engine = run.engineId === null ? null : this.engines.get(run.engineId);
        if (engine === null) { missingEngine = true; continue; }
        try {
          const result = await new TaskClient({ address: engine.address, token: engine.token }, { log: this.log }).removeTask(run.taskUuid);
          if (!result.ok && !isTaskNotFound(result.failure)) failed = true;
        } catch { failed = true; }
      }
      if (missingEngine) return "engine_missing";
      if (failed) return "incomplete";
      try {
        await this.removeOwned("projects", id);
        for (const run of runs) await this.removeOwned("runs", run.id);
      } catch { return "incomplete"; }
      this.projects.removeRows(id);
      return "ok";
    } finally { this.deleting.delete(id); }
  }

  private async removeOwned(kind: "projects" | "runs", id: number): Promise<void> {
    if (!Number.isSafeInteger(id) || id < 1) throw new Error("Invalid owned folder id");
    const root = join(this.folder, kind);
    try {
      const info = await lstat(root);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Invalid owned folder");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await rm(join(root, String(id)), { recursive: true, force: true });
  }
}
