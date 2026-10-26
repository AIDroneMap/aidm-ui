import { existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { ApiError } from "../../shared/api-error.ts";
import { freeBytes as defaultFreeBytes, type FreeBytes } from "../machine/disk.ts";
import { DOWNLOAD_FREE_DISK_MARGIN, DOWNLOAD_IDLE_MS, DOWNLOAD_STALL_MS } from "../machine/thresholds.ts";

export interface DownloadTarget {
  url: string;
  size: number;
  sha256: string;
  /** The final file. The download is written to the same path plus ".part". */
  path: string;
}

/**
 * Makes the request of one try. It gets the headers the try needs (a Range
 * header when bytes are on disk) and a signal that ends the try. A host that
 * needs more than a GET of the URL brings its own: the image downloader asks
 * the registry each time, which gives it a fresh signed address.
 */
export type DownloadRequest = (headers: Record<string, string>, signal: AbortSignal) => Promise<Response>;

export interface DownloadOptions {
  fetch?: typeof fetch;
  /** Replaces the GET of target.url. */
  request?: DownloadRequest;
  /** The operator cancelled. */
  signal?: AbortSignal;
  /** Total is the target's size. */
  onProgress?: (received: number, total: number) => void;
  /** A try stopped and another one follows. The reason is a message code: download.connection_interrupted, download.connection_silent or download.host_busy. */
  onRetry?: (reason: ApiError) => void;
  /** The download fails when no byte has arrived for this long. There is no cap on tries before that. */
  stallMs?: number;
  /** A try that stays open but sends nothing for this long is dropped and made again. */
  idleMs?: number;
  backoffMs?: (attempt: number) => number;
  freeBytes?: FreeBytes;
  /** False when the caller has checked the disk for this file and others together. */
  checkSpace?: boolean;
  /** Milliseconds since the epoch. */
  now?: () => number;
  /** The diagnosis log: the start, every resume and the end of the download. */
  log?: (line: string) => void;
  /** What the download is, for the log, e.g. "Apple's installer 1.6.1". Default: the file's name. */
  label?: string;
}

export type DownloadOutcome = { ok: true; path: string } | { ok: false; error: ApiError };

/** Seconds with one decimal. */
function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

/** Bytes per second in MiB/s or KiB/s, for the log. */
export function formatRate(bytesPerSecond: number): string {
  if (bytesPerSecond >= 1024 ** 2) return `${(bytesPerSecond / 1024 ** 2).toFixed(2)} MiB/s`;
  return `${(bytesPerSecond / 1024).toFixed(1)} KiB/s`;
}

function defaultBackoff(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), 30_000);
}

function fail(code: ApiError["code"], data: Record<string, unknown> = {}): DownloadOutcome {
  return { ok: false, error: { code, data } };
}

export function sizeOf(path: string): number {
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
export async function sha256Of(path: string, signal: AbortSignal | undefined): Promise<string | null> {
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

/** What one try came to. A retry carries the reason the operator is told. */
type Attempt =
  | { result: "complete" }
  | { result: "restart" }
  | { result: "cancelled" }
  | { result: "too_long" }
  | { result: "refused" }
  | { result: "retry"; reason: ApiError };

const interrupted: Attempt = { result: "retry", reason: { code: "download.connection_interrupted", data: {} } };

/** A 4xx answer will not change by asking again, except when the host asks us to wait or says we were slow. */
function isFinalRefusal(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/**
 * Downloads one file with resume and checks its SHA-256 before it gets its
 * name. A try that breaks is made again from the last byte on disk, with
 * backoff, as long as bytes keep arriving: it fails only when no byte has
 * arrived for the stall time.
 */
export async function downloadVerified(
  target: DownloadTarget,
  options: DownloadOptions = {},
): Promise<DownloadOutcome> {
  const doFetch = options.fetch ?? fetch;
  const request: DownloadRequest =
    options.request ?? ((headers, signal) => doFetch(target.url, { headers, signal, redirect: "follow" }));
  const signal = options.signal;
  const backoff = options.backoffMs ?? defaultBackoff;
  const stallMs = options.stallMs ?? DOWNLOAD_STALL_MS;
  const idleMs = options.idleMs ?? DOWNLOAD_IDLE_MS;
  const now = options.now ?? Date.now;
  const part = `${target.path}.part`;
  const log = options.log ?? (() => {});
  const label = options.label ?? basename(target.path);
  const began = now();

  mkdirSync(dirname(target.path), { recursive: true });

  if (existsSync(target.path)) {
    const existing = await sha256Of(target.path, signal);
    if (existing === null) return fail("download.cancelled");
    if (existing === target.sha256) {
      log(`Download ${label}: already on disk and checked, ${target.size} bytes`);
      return { ok: true, path: target.path };
    }
    log(`Download ${label}: check failed for the file on disk: expected SHA-256 ${target.sha256}, found ${existing}. It is downloaded again.`);
    remove(target.path);
  }

  if (options.checkSpace !== false) {
    const needed = Math.max(0, target.size - sizeOf(part)) + DOWNLOAD_FREE_DISK_MARGIN * target.size;
    const free = (options.freeBytes ?? defaultFreeBytes)(dirname(target.path));
    if (free < needed) return fail("download.not_enough_space", { needed, free });
  }

  const onDisk = sizeOf(part);
  log(`Download ${label}: started, ${target.size} bytes${onDisk > 0 ? `, going on from byte ${onDisk} already on disk` : ""}`);
  let interruptions = 0;
  const ended = (outcome: DownloadOutcome): DownloadOutcome => {
    const took = now() - began;
    if (outcome.ok) {
      const average = took > 0 ? (target.size - onDisk) / (took / 1000) : 0;
      log(
        `Download ${label}: finished, ${target.size} bytes in ${seconds(took)}, ${formatRate(average)} on average, ${interruptions} interruption${interruptions === 1 ? "" : "s"}`,
      );
    } else {
      log(`Download ${label}: failed after ${seconds(took)} at byte ${sizeOf(part)} of ${target.size}: ${outcome.error.code}${Object.keys(outcome.error.data).length === 0 ? "" : ` ${JSON.stringify(outcome.error.data)}`}`);
    }
    return outcome;
  };

  // A host that cannot serve the range we ask for gets one fresh start from byte 0.
  let startedOver = false;
  let lastByteAt = now();

  async function attempt(): Promise<Attempt> {
    let have = sizeOf(part);
    if (have >= target.size) return { result: "complete" };
    const headers: Record<string, string> = {};
    if (have > 0) headers.range = `bytes=${have}-`;

    // The try has a signal of its own, so a silent connection can be dropped
    // without the operator's signal firing.
    const tryController = new AbortController();
    const endTry = () => tryController.abort();
    signal?.addEventListener("abort", endTry);
    let silent = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const watchIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        silent = true;
        tryController.abort();
      }, idleMs);
    };
    const silence: Attempt = { result: "retry", reason: { code: "download.connection_silent", data: { seconds: Math.round(idleMs / 1000) } } };
    const broken = (): Attempt => (signal?.aborted ? { result: "cancelled" } : silent ? silence : interrupted);

    try {
      watchIdle();
      let response: Response;
      try {
        response = await request(headers, tryController.signal);
      } catch {
        return broken();
      }

      let append = true;
      if (response.status === 206) {
        const match = /^bytes (\d+)-/.exec(response.headers.get("content-range") ?? "");
        if (!match || Number(match[1]) !== have) {
          await response.body?.cancel().catch(() => {});
          return interrupted;
        }
      } else if (response.status === 200) {
        append = false;
        have = 0;
      } else if (response.status === 416 && have > 0 && !startedOver) {
        // The part is not a prefix of the file the host has now, so it cannot be completed.
        await response.body?.cancel().catch(() => {});
        startedOver = true;
        remove(part);
        return { result: "restart" };
      } else {
        await response.body?.cancel().catch(() => {});
        if (isFinalRefusal(response.status)) return { result: "refused" };
        return { result: "retry", reason: { code: "download.host_busy", data: { status: response.status } } };
      }

      if (!response.body) return interrupted;
      const file = await open(part, append ? "a" : "w");
      let received = have;
      try {
        options.onProgress?.(received, target.size);
        for await (const chunk of response.body) {
          if (signal?.aborted) return { result: "cancelled" };
          // More bytes than pinned can only be the wrong file. Stop before it fills the disk.
          if (received + chunk.byteLength > target.size) return { result: "too_long" };
          await file.write(chunk);
          received += chunk.byteLength;
          if (chunk.byteLength > 0) {
            lastByteAt = now();
            watchIdle();
          }
          options.onProgress?.(received, target.size);
        }
      } catch {
        return broken();
      } finally {
        await file.close();
      }
      if (signal?.aborted) return { result: "cancelled" };
      if (received < target.size) return interrupted;
      return { result: "complete" };
    } finally {
      clearTimeout(idleTimer);
      signal?.removeEventListener("abort", endTry);
    }
  }

  for (let tries = 0; ; tries++) {
    if (signal?.aborted) return ended(fail("download.cancelled"));
    const before = sizeOf(part);
    const outcome = await attempt();
    if (outcome.result === "cancelled") return ended(fail("download.cancelled"));
    if (outcome.result === "refused") return ended(fail("download.failed"));
    if (outcome.result === "restart") {
      tries--;
      continue;
    }
    if (outcome.result === "too_long") {
      remove(part);
      log(`Download ${label}: the host sent more than the ${target.size} bytes pinned; the part was discarded`);
      return ended(fail("download.checksum_mismatch"));
    }
    if (outcome.result === "complete") break;
    // A link that keeps making progress starts its backoff again.
    if (sizeOf(part) > before) tries = 0;
    const left = stallMs - (now() - lastByteAt);
    if (left <= 0) return ended(fail("download.stalled", { seconds: Math.round(stallMs / 1000) }));
    interruptions++;
    log(`Download ${label}: interruption ${interruptions} (${outcome.reason.code}), goes on from byte ${sizeOf(part)}`);
    options.onRetry?.(outcome.reason);
    await sleep(Math.min(backoff(tries + 1), left), signal);
  }

  const checksum = await sha256Of(part, signal);
  if (checksum === null) return ended(fail("download.cancelled"));
  if (checksum !== target.sha256) {
    remove(part);
    log(`Download ${label}: check failed: expected SHA-256 ${target.sha256}, found ${checksum}. The file was discarded.`);
    return ended(fail("download.checksum_mismatch"));
  }
  renameSync(part, target.path);
  return ended({ ok: true, path: target.path });
}
