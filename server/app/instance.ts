import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface InstanceIdentity {
  app: "aidm-ui";
  version: string;
  instance: string;
}

/** Same data folder, same instance: a second launch can tell whether the program on a port is its own. */
export function instanceId(dataFolder: string): string {
  return createHash("sha256").update(resolve(dataFolder)).digest("hex");
}

/** Asks whatever listens on a loopback port who it is. Anything but an aidm-ui answer gives null. */
export async function probe(port: number, timeoutMs = 1000): Promise<InstanceIdentity | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null) return null;
    const { app, version, instance } = body as Record<string, unknown>;
    if (app !== "aidm-ui" || typeof version !== "string" || typeof instance !== "string") {
      return null;
    }
    return { app, version, instance };
  } catch {
    return null;
  }
}

export interface LockRecord {
  pid: number;
  port: number;
}

export const LOCK_FILE_NAME = "aidm-ui.lock";

function lockPath(dataFolder: string): string {
  return join(dataFolder, LOCK_FILE_NAME);
}

/** Null when the file is missing or unreadable. */
export function readLock(dataFolder: string): LockRecord | null {
  try {
    const body: unknown = JSON.parse(readFileSync(lockPath(dataFolder), "utf8"));
    if (typeof body !== "object" || body === null) return null;
    const { pid, port } = body as Record<string, unknown>;
    if (!Number.isInteger(pid) || !Number.isInteger(port)) return null;
    return { pid: pid as number, port: port as number };
  } catch {
    return null;
  }
}

export function writeLock(dataFolder: string, record: LockRecord): void {
  writeFileSync(lockPath(dataFolder), JSON.stringify(record), { mode: 0o600 });
}

/** Only removes the file if it still holds this pid, so a newer copy's lock is left alone. */
export function removeLock(dataFolder: string, pid: number): void {
  if (readLock(dataFolder)?.pid !== pid) return;
  rmSync(lockPath(dataFolder), { force: true });
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // The process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
