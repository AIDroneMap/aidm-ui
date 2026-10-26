import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ApiError } from "../../shared/api-error.ts";
import type { InstallStepId, InstallStepView } from "../../shared/api-types.ts";
import { downloadVerified, type DownloadOptions } from "../downloads/downloader.ts";
import type { FreeBytes } from "../machine/disk.ts";
import { describeCommand, type CommandRunner } from "../process/command-runner.ts";

export interface InstallerPin {
  version: string;
  url: string;
  size: number;
  /** Lower case hex. Pinned here, never read from a manifest. */
  sha256: string;
}

/** Apple's signed installer package, checked against the GitHub release of 1.6.1. */
export const APPLE_CONTAINER_INSTALLER: InstallerPin = {
  version: "1.6.1",
  url: "https://github.com/apple/container/releases/download/1.6.1/container-1.6.1-installer-signed.pkg",
  size: 155_965_213,
  sha256: "cd47846819f06478d067060efe21e516b562ac0a9af8eecad6d5fea0b556b200",
};

/**
 * The kernel the tool downloads when its system service starts, in bytes: the
 * content length of the kernel archive named in the tool's source (release
 * 1.6.1), measured with a HEAD request. The download has no resume.
 */
export const KERNEL_DOWNLOAD_SIZE = 696_573_576;

export const INSTALLER_POLL_MS = 2000;
export const INSTALLER_WAIT_MS = 10 * 60 * 1000;

/** Where the installer puts the tool. */
const TOOL_PATH = "/usr/local/bin/container";

/**
 * What the Mac lacks. "tool_missing": Apple's container tool is not there, so
 * every step runs. "service_stopped": it is there but its system service never
 * ran, so only the kernel and the startup files are left.
 */
export type MacNeed = "tool_missing" | "service_stopped";

/** The steps before the engine's own download, each with the size it will download. */
export function macSteps(need: MacNeed, installer: InstallerPin = APPLE_CONTAINER_INSTALLER): InstallStepView[] {
  const fromService: InstallStepView[] = [
    { id: "kernel", size: KERNEL_DOWNLOAD_SIZE },
    // The tool does not say how big the startup files are, and no number is made up.
    { id: "init", size: null },
  ];
  return need === "tool_missing"
    ? [{ id: "installer", size: installer.size }, { id: "approve", size: null }, ...fromService]
    : fromService;
}

export type MacSetupResult = { ok: true } | { ok: false; step: InstallStepId; error: ApiError };

export interface MacSetupDeps {
  runner: CommandRunner;
  dataFolder: string;
  /** Tests point this at a fake file server. */
  installer?: InstallerPin;
  fetch?: DownloadOptions["fetch"];
  freeBytes?: FreeBytes;
  /** Passed to the downloader, so a test does not wait between tries. */
  backoffMs?: DownloadOptions["backoffMs"];
  retries?: DownloadOptions["retries"];
  /** Waits for the given milliseconds. */
  sleep?: (ms: number) => Promise<void>;
  /** Milliseconds since the epoch. */
  now?: () => number;
  pollMs?: number;
  waitMs?: number;
  /** Whether the tool's file is there. */
  toolExists?: () => boolean;
  log: (line: string) => void;
}

export interface MacSetupRun {
  signal?: AbortSignal;
  /** A step began. */
  onStep: (step: InstallStepId) => void;
  /** Bytes of the installer received so far. */
  onReceived: (received: number) => void;
}

/**
 * Puts Apple's container tool on a Mac and starts its system service. It
 * knows nothing about the engine: the engine manager runs the engine install
 * after it.
 */
export class MacSetup {
  private readonly installer: InstallerPin;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly deps: MacSetupDeps) {
    this.installer = deps.installer ?? APPLE_CONTAINER_INSTALLER;
    this.sleep = deps.sleep ?? ((ms) => Bun.sleep(ms));
    this.now = deps.now ?? Date.now;
  }

  /** The steps `run` will take, with their sizes, before any of them starts. */
  steps(need: MacNeed): InstallStepView[] {
    return macSteps(need, this.installer);
  }

  async run(need: MacNeed, run: MacSetupRun): Promise<MacSetupResult> {
    if (need === "tool_missing") {
      const installed = await this.installTool(run);
      if (!installed.ok) return installed;
    }
    return this.startService(run);
  }

  // Inside ------------------------------------------------------------------

  private async installTool(run: MacSetupRun): Promise<MacSetupResult> {
    run.onStep("installer");
    const path = join(this.deps.dataFolder, "downloads", `container-${this.installer.version}-installer-signed.pkg`);
    // The downloader checks the SHA-256 before it names the file, and again for a file that is already there.
    // Nothing below runs unless that check passed.
    const downloaded = await downloadVerified(
      { url: this.installer.url, size: this.installer.size, sha256: this.installer.sha256, path },
      {
        fetch: this.deps.fetch,
        signal: run.signal,
        freeBytes: this.deps.freeBytes,
        backoffMs: this.deps.backoffMs,
        retries: this.deps.retries,
        onProgress: (received) => run.onReceived(received),
      },
    );
    if (!downloaded.ok) return { ok: false, step: "installer", error: downloaded.error };

    run.onStep("approve");
    // Opening the package makes macOS ask for the administrator password, once.
    const opening = ["open", downloaded.path];
    this.deps.log(describeCommand(opening));
    const opened = await this.deps.runner.run(opening);
    if (opened.exitCode !== 0) return this.notFinished("open_failed");

    // A dismissed prompt cannot be seen from here: the tool just never appears.
    const deadline = this.now() + (this.deps.waitMs ?? INSTALLER_WAIT_MS);
    for (;;) {
      if (run.signal?.aborted) return { ok: false, step: "approve", error: { code: "download.cancelled", data: {} } };
      if (await this.toolPresent()) return { ok: true };
      if (this.now() >= deadline) return this.notFinished("timeout");
      await this.sleep(this.deps.pollMs ?? INSTALLER_POLL_MS);
    }
  }

  private notFinished(reason: "timeout" | "open_failed"): MacSetupResult {
    return { ok: false, step: "approve", error: { code: "mac.install_not_finished", data: { reason } } };
  }

  private async toolPresent(): Promise<boolean> {
    if ((this.deps.toolExists ?? (() => existsSync(TOOL_PATH)))()) return true;
    return (await this.deps.runner.run(["container", "--version"])).exitCode === 0;
  }

  /**
   * One command does both the kernel and the startup files. Without the flag
   * the tool asks on its standard input, which nobody answers, so the flag is
   * always there. The step is told from the tool's own lines.
   */
  private async startService(run: MacSetupRun): Promise<MacSetupResult> {
    const argv = ["container", "system", "start", "--enable-kernel-install"];
    this.deps.log(describeCommand(argv));
    let step: InstallStepId = "kernel";
    run.onStep(step);
    const result = await this.deps.runner.stream(argv, {
      signal: run.signal,
      onLine: (line) => {
        this.deps.log(line);
        // The kernel comes first and the startup files after it. A line never moves the step back.
        if (step === "kernel" && /\binit\b|vminit/i.test(line)) {
          step = "init";
          run.onStep(step);
        }
      },
    });
    if (result.exitCode === 0) return { ok: true };
    if (run.signal?.aborted) return { ok: false, step, error: { code: "download.cancelled", data: {} } };
    return { ok: false, step, error: { code: "mac.start_failed", data: { step, exitCode: result.exitCode } } };
  }
}

/**
 * Programs started from Finder get a short PATH without the folder the
 * installer uses. The tool is looked up by name everywhere, so the folder is
 * added once, at start.
 */
export function addToolFolderToPath(env: Record<string, string | undefined> = process.env): void {
  const folders = (env.PATH ?? "").split(":").filter((folder) => folder !== "");
  if (!folders.includes("/usr/local/bin")) env.PATH = [...folders, "/usr/local/bin"].join(":");
}
