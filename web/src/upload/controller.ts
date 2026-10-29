import { MESSAGE_CODES } from "../../../shared/message-codes.ts";
import type { UploadSessionView } from "../../../shared/api-types.ts";
import { classifyUploadFile } from "../../../shared/upload-files.ts";
import { hashInWorker } from "./worker.ts";

export interface PendingUpload { projectId: number; id: string; name: string; size: number; sha256: string }
export interface UploadProgress { transferred: number; elapsedMs: number; bytesPerSecond: number | null }
export type UploadResult = { status: "complete" } | { status: "error"; code: string; data?: Record<string, unknown> } | { status: "cancelled" };
type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;
type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type Options = { fetch?: Fetch; storage?: Storage; hash?: (blob: Blob, signal: AbortSignal) => Promise<string> };
const storageKey = "aidm.pendingUploads";
export const UPLOAD_LOCAL_CODES = ["upload.unsupported", "upload.pending_invalid", "upload.reselection_mismatch", "upload.hash_failed", "api.invalid_response", "api.request_failed"] as const;

export class UploadController {
  private readonly request: Fetch;
  private readonly storage: Storage;
  private readonly hash: (blob: Blob, signal: AbortSignal) => Promise<string>;
  constructor(options: Options = {}) {
    this.request = options.fetch ?? ((input, init) => fetch(input, init));
    this.storage = options.storage ?? localStorage;
    this.hash = options.hash ?? hashInWorker;
  }
  pending(projectId: number): PendingUpload[] {
    return this.read().filter(entry => entry.projectId === projectId);
  }
  private read(): PendingUpload[] {
    try {
      const value: unknown = JSON.parse(this.storage.getItem(storageKey) ?? "[]");
      if (!Array.isArray(value)) return [];
      return value.filter((entry): entry is PendingUpload => entry && Number.isSafeInteger(entry.projectId) && typeof entry.id === "string" && /^[a-f0-9]{32}$/.test(entry.id) && typeof entry.name === "string" && Number.isSafeInteger(entry.size) && entry.size > 0 && typeof entry.sha256 === "string" && /^[a-f0-9]{64}$/.test(entry.sha256));
    } catch { return []; }
  }
  private save(entry: PendingUpload) {
    this.storage.setItem(storageKey, JSON.stringify([...this.read().filter(item => item.projectId !== entry.projectId || item.id !== entry.id), entry]));
  }
  private remove(entry: PendingUpload) {
    this.storage.setItem(storageKey, JSON.stringify(this.read().filter(item => item.projectId !== entry.projectId || item.id !== entry.id)));
  }
  private async response(path: string, init: RequestInit): Promise<Response> {
    const response = await this.request(path, init);
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: { code?: unknown; data?: unknown } } | null;
      throw new UploadError(typeof body?.error?.code === "string" && (MESSAGE_CODES as readonly string[]).includes(body.error.code) ? body.error.code : "server.internal_error", response.status, typeof body?.error?.data === "object" && body.error.data !== null ? body.error.data as Record<string, unknown> : undefined);
    }
    return response;
  }
  async cancel(entry: PendingUpload): Promise<UploadResult> {
    try {
      await this.response(`/api/projects/${entry.projectId}/uploads/${encodeURIComponent(entry.id)}`, { method: "DELETE" });
      this.remove(entry);
      return { status: "cancelled" };
    } catch (error) {
      if (error instanceof UploadError && error.status === 404) { this.remove(entry); return { status: "cancelled" }; }
      return failure(error);
    }
  }
  async upload(projectId: number, file: File, name: string, signal: AbortSignal, progress?: (value: UploadProgress) => void, resume?: PendingUpload, onSession?: (entry: PendingUpload) => void): Promise<UploadResult> {
    if (!Number.isSafeInteger(projectId) || projectId < 1 || name.length < 1 || name.length > 4096 || /[\u0000-\u001f\\]/.test(name) || name.split("/").some(part => part === "" || part === "." || part === "..") || /^[a-z]:/i.test(name) || file.size < 1) return { status: "error", code: "api.invalid_body" };
    const kind = classifyUploadFile(name);
    if (kind === "ground_control") return { status: "error", code: "upload.ground_control_unsupported" };
    if (kind === "unsupported") return { status: "error", code: "upload.unsupported" };
    let entry = resume;
    const base = `/api/projects/${projectId}/uploads`;
    let started: number | undefined;
    let transferred = 0;
    try {
      if (entry && (entry.projectId !== projectId || !this.pending(projectId).some(item => item.id === entry!.id && item.sha256 === entry!.sha256 && item.size === entry!.size))) throw new UploadError("upload.pending_invalid", 0);
      const digest = await this.hash(file, signal);
      signal.throwIfAborted();
      if (entry && (entry.size !== file.size || entry.sha256 !== digest)) throw new UploadError("upload.reselection_mismatch", 0);
      let session: UploadSessionView;
      if (entry) {
        session = await this.session(`${base}/${encodeURIComponent(entry.id)}`, { signal });
        if (session.id !== entry.id) throw new UploadError("api.invalid_response", 0);
      }
      else {
        session = await this.session(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, size: file.size, sha256: digest }), signal });
        entry = { projectId, id: session.id, name, size: file.size, sha256: digest };
        if (!session.complete) this.save(entry);
      }
      if (!session.complete) onSession?.(entry);
      const path = `${base}/${encodeURIComponent(entry.id)}`;
      for (let attempt = 0; attempt < 2 && !session.complete; attempt++) {
        const received = new Set(session.received);
        for (let index = 0; index < Math.ceil(file.size / session.chunkSize); index++) {
          if (received.has(index)) continue;
          signal.throwIfAborted();
          const chunk = file.slice(index * session.chunkSize, Math.min(file.size, (index + 1) * session.chunkSize));
          const checksum = await this.hash(chunk, signal);
          started ??= performance.now();
          for (let retry = 0; ; retry++) {
            try {
              await this.response(`${path}/chunks/${index}`, { method: "PUT", headers: { "x-chunk-sha256": checksum }, body: chunk, signal });
              break;
            } catch (error) {
              if (!(error instanceof UploadError) || error.code !== "upload.checksum_mismatch" || retry !== 0) throw error;
            }
          }
          transferred += chunk.size;
          const elapsedMs = performance.now() - started;
          progress?.({ transferred, elapsedMs, bytesPerSecond: elapsedMs > 0 ? transferred * 1000 / elapsedMs : null });
        }
        try {
          session = await this.session(`${path}/complete`, { method: "POST", signal });
          if (session.id !== entry.id) throw new UploadError("api.invalid_response", 0);
        }
        catch (error) {
          if (!(error instanceof UploadError) || error.code !== "upload.checksum_mismatch" || attempt !== 0) throw error;
          session = await this.session(path, { signal });
          if (session.id !== entry.id) throw new UploadError("api.invalid_response", 0);
        }
      }
      if (!session.complete) throw new UploadError("upload.incomplete", 0);
      this.remove(entry);
      return { status: "complete" };
    } catch (error) {
      if (signal.aborted) return { status: "cancelled" };
      if (entry && error instanceof UploadError && error.status === 404) this.remove(entry);
      return failure(error);
    }
  }
  private async session(path: string, init: RequestInit): Promise<UploadSessionView> {
    const value: unknown = await (await this.response(path, init)).json();
    if (!value || typeof value !== "object") throw new UploadError("api.invalid_response", 0);
    const session = value as UploadSessionView;
    if (!/^[a-f0-9]{32}$/.test(session.id) || !Number.isSafeInteger(session.chunkSize) || session.chunkSize < 1 || session.chunkSize > 1024 * 1024 || !Array.isArray(session.received) || !session.received.every(index => Number.isSafeInteger(index) && index >= 0) || typeof session.complete !== "boolean") throw new UploadError("api.invalid_response", 0);
    return session;
  }
}

class UploadError extends Error {
  constructor(readonly code: string, readonly status: number, readonly data?: Record<string, unknown>) { super(code); }
}
function failure(error: unknown): UploadResult {
  if (error instanceof Error && error.message === "upload.hash_failed") return { status: "error", code: "upload.hash_failed" };
  return error instanceof UploadError ? { status: "error", code: error.code, data: error.data } : { status: "error", code: "api.request_failed" };
}
