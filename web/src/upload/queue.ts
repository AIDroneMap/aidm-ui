import { classifyUploadFile } from "../../../shared/upload-files.ts";
import type { UploadResult } from "./controller.ts";

export interface UploadSelection { file: File; name: string }
export interface SkippedUpload { name: string; code: string }
type Upload = (projectId: number, file: File, name: string, signal: AbortSignal) => Promise<UploadResult>;
type Task = { run: () => Promise<UploadResult>; resolve: (result: UploadResult) => void; signal: AbortSignal };

export class UploadQueue {
  private active = 0;
  private waiting: Task[] = [];
  constructor(private readonly upload: Upload, private readonly limit = 2) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 4) throw new RangeError("Invalid upload limit");
  }
  enqueue(projectId: number, selections: Iterable<UploadSelection>, signal: AbortSignal): { skipped: SkippedUpload[]; done: Promise<UploadResult[]> } {
    const skipped: SkippedUpload[] = [];
    const results: Promise<UploadResult>[] = [];
    for (const { file, name } of selections) {
      const kind = classifyUploadFile(name);
      if (kind === "unsupported" || kind === "ground_control") {
        skipped.push({ name, code: kind === "ground_control" ? "upload.ground_control_unsupported" : "upload.unsupported" });
        continue;
      }
      results.push(new Promise(resolve => {
        this.waiting.push({ run: () => this.upload(projectId, file, name, signal), resolve, signal });
      }));
    }
    this.drain();
    return { skipped, done: Promise.all(results) };
  }
  private drain() {
    while (this.active < this.limit && this.waiting.length) {
      const task = this.waiting.shift()!;
      if (task.signal.aborted) { task.resolve({ status: "cancelled" }); continue; }
      this.active++;
      Promise.resolve().then(task.run).catch((): UploadResult => ({ status: "error", code: "api.request_failed" })).then(result => task.resolve(result)).finally(() => { this.active--; this.drain(); });
    }
  }
}
