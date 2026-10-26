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

/** The checksum of a file, or null when the operator cancelled before it was done. A big file takes seconds to read. */
async function sha256Of(path: string, signal: AbortSignal | undefined): Promise<string | null> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) {
    if (signal?.aborted) return null;
    hasher.update(chunk);
  }
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
type Attempt = "complete" | "retry" | "restart" | "cancelled" | "too_long" | "refused";

/** A 4xx answer will not change by asking again, except when the host asks us to wait or says we were slow. */
function isFinalRefusal(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

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
    const existing = await sha256Of(target.path, signal);
    if (existing === null) return fail("download.cancelled");
    if (existing === target.sha256) return { ok: true, path: target.path };
    remove(target.path);
  }

  const needed = Math.max(0, target.size - sizeOf(part)) + DOWNLOAD_FREE_DISK_MARGIN * target.size;
  const free = freeBytes(dirname(target.path));
  if (free < needed) return fail("download.not_enough_space", { needed, free });

  // A host that cannot serve the range we ask for gets one fresh start from byte 0.
  let startedOver = false;

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
      } else if (response.status === 416 && have > 0 && !startedOver) {
        // The part is not a prefix of the file the host has now, so it cannot be completed.
        await response.body?.cancel().catch(() => {});
        startedOver = true;
        remove(part);
        return "restart";
      } else {
        await response.body?.cancel().catch(() => {});
        return isFinalRefusal(response.status) ? "refused" : "retry";
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
    if (result === "refused") return fail("download.failed");
    if (result === "restart") {
      tries--;
      continue;
    }
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

  const checksum = await sha256Of(part, signal);
  if (checksum === null) return fail("download.cancelled");
  if (checksum !== target.sha256) {
    remove(part);
    return fail("download.checksum_mismatch");
  }
  renameSync(part, target.path);
  return { ok: true, path: target.path };
}
