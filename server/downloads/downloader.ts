import { existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname } from "node:path";
import type { ApiError } from "../../shared/api-error.ts";
import { freeBytes as defaultFreeBytes, type FreeBytes } from "../machine/disk.ts";
import { DOWNLOAD_FREE_DISK_MARGIN } from "../machine/thresholds.ts";

export interface DownloadTarget {
  url: string;
  size: number;
  sha256: string;
  /** The final file. The download is written to the same path plus ".part". */
  path: string;
}

export interface DownloadOptions {
  fetch?: typeof fetch;
  /** The operator cancelled. */
  signal?: AbortSignal;
  /** Total is the target's size. */
  onProgress?: (received: number, total: number) => void;
  /** Attempts after the first one. */
  retries?: number;
  backoffMs?: (attempt: number) => number;
  freeBytes?: FreeBytes;
}

export type DownloadOutcome = { ok: true; path: string } | { ok: false; error: ApiError };

const DEFAULT_RETRIES = 5;

function defaultBackoff(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), 30_000);
}

function fail(code: ApiError["code"], data: Record<string, unknown> = {}): DownloadOutcome {
  return { ok: false, error: { code, data } };
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function remove(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone.
  }
}

async function sha256Of(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest("hex");
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done);
  });
}

/** What one attempt came to. */
type Attempt = "complete" | "retry" | "cancelled" | "too_long";

export async function downloadVerified(
  target: DownloadTarget,
  options: DownloadOptions = {},
): Promise<DownloadOutcome> {
  const doFetch = options.fetch ?? fetch;
  const signal = options.signal;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const backoff = options.backoffMs ?? defaultBackoff;
  const freeBytes = options.freeBytes ?? defaultFreeBytes;
  const part = `${target.path}.part`;

  mkdirSync(dirname(target.path), { recursive: true });

  if (existsSync(target.path)) {
    if ((await sha256Of(target.path)) === target.sha256) return { ok: true, path: target.path };
    remove(target.path);
  }

  const needed = Math.max(0, target.size - sizeOf(part)) + DOWNLOAD_FREE_DISK_MARGIN * target.size;
  const free = freeBytes(dirname(target.path));
  if (free < needed) return fail("download.not_enough_space", { needed, free });

  async function attempt(): Promise<Attempt> {
    let have = sizeOf(part);
    if (have < target.size) {
      const headers: Record<string, string> = {};
      if (have > 0) headers.range = `bytes=${have}-`;
      let response: Response;
      try {
        response = await doFetch(target.url, { headers, signal, redirect: "follow" });
      } catch {
        return signal?.aborted ? "cancelled" : "retry";
      }

      let append = true;
      if (response.status === 206) {
        const match = /^bytes (\d+)-/.exec(response.headers.get("content-range") ?? "");
        if (!match || Number(match[1]) !== have) {
          await response.body?.cancel().catch(() => {});
          return "retry";
        }
      } else if (response.status === 200) {
        append = false;
        have = 0;
      } else if (response.status === 416 && have > 0) {
        await response.body?.cancel().catch(() => {});
        return "complete";
      } else {
        await response.body?.cancel().catch(() => {});
        return "retry";
      }

      if (!response.body) return "retry";
      const file = await open(part, append ? "a" : "w");
      let received = have;
      try {
        options.onProgress?.(received, target.size);
        for await (const chunk of response.body) {
          if (signal?.aborted) return "cancelled";
          // More bytes than pinned can only be the wrong file. Stop before it fills the disk.
          if (received + chunk.byteLength > target.size) return "too_long";
          await file.write(chunk);
          received += chunk.byteLength;
          options.onProgress?.(received, target.size);
        }
      } catch {
        return signal?.aborted ? "cancelled" : "retry";
      } finally {
        await file.close();
      }
      if (signal?.aborted) return "cancelled";
      if (received < target.size) return "retry";
    }
    return "complete";
  }

  for (let tries = 0; ; tries++) {
    if (signal?.aborted) return fail("download.cancelled");
    const before = sizeOf(part);
    const result = await attempt();
    if (result === "cancelled") return fail("download.cancelled");
    if (result === "too_long") {
      remove(part);
      return fail("download.checksum_mismatch");
    }
    if (result === "complete") break;
    // A slow link that keeps making progress gets its retries back.
    if (sizeOf(part) > before) tries = 0;
    if (tries >= retries) return fail("download.failed");
    await sleep(backoff(tries + 1), signal);
  }

  if ((await sha256Of(part)) !== target.sha256) {
    remove(part);
    return fail("download.checksum_mismatch");
  }
  renameSync(part, target.path);
  return { ok: true, path: target.path };
}
