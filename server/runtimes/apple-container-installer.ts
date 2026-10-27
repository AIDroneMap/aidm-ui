import { realpathSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import type { ApiError } from "../../shared/api-error.ts";
import type { InstallStepId, InstallStepView } from "../../shared/api-types.ts";
import { downloadVerified, type DownloadOptions } from "../downloads/downloader.ts";
import { downloadImage, imageFolder, removeImageDownload, type ImageDownloadOptions, type PinnedImage } from "../images/image-download.ts";
import type { FreeBytes } from "../machine/disk.ts";
import type { CommandRunner } from "../process/command-runner.ts";
import { APPLE_TOOL, loadIntoAppleTool, parseToolVersion } from "./apple-container.ts";
import { parseAppleProgress } from "./apple-progress.ts";
import type { AppleNetwork } from "./apple-network.ts";
import { excerpt } from "../app/diagnosis-log.ts";

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
 * The Linux kernel that Apple's tool runs its VMs on: the archive its
 * release names as the recommended kernel, in the tool's own source at the
 * 1.6.1 tag (ContainerSystemConfig.swift: the URL, the member and the
 * archive's digest). The size and the SHA-256 were measured on 26 October
 * 2026 by downloading the archive: 696,573,576 bytes, which is 664 MiB or
 * 697 MB. A pin belongs to one release of the tool, and a test fails when
 * the installer pin moves without it.
 */
export interface KernelPin {
  /** The release of Apple's tool that names this kernel. */
  forTool: string;
  /** Kata Containers' release. */
  version: string;
  url: string;
  size: number;
  sha256: string;
  /** The kernel file inside the archive. */
  member: string;
}

export const APPLE_CONTAINER_KERNEL: KernelPin = {
  forTool: "1.6.1",
  version: "3.32.0",
  url: "https://github.com/kata-containers/kata-containers/releases/download/3.32.0/kata-static-3.32.0-arm64.tar.zst",
  size: 696_573_576,
  sha256: "8736c054d9223974735394f822000823baef509e1c33405ec798240fa9b6e4b5",
  member: "opt/kata/share/kata-containers/vmlinux-6.18.35-197-debug",
};

/**
 * The startup files: the image every VM of the tool boots from, as named in
 * its source at 1.6.1 (ContainerSystemConfig.swift). The tool looks for it
 * by this exact name. The digest is the linux/arm64 manifest in the image's
 * index (index sha256:526b1bf414a186ce6047e600830fb2981509f041cf4d4ce91653d97bd30d4700),
 * and the size is its config and its one layer, read from the registry on
 * 26 October 2026.
 */
export interface InitImagePin {
  forTool: string;
  /** The name the tool looks for. */
  reference: string;
  repository: string;
  digest: string;
  size: number;
}

export const APPLE_CONTAINER_INIT_IMAGE: InitImagePin = {
  forTool: "1.6.1",
  reference: "ghcr.io/apple/containerization/vminit:0.53.0",
  repository: "ghcr.io/apple/containerization/vminit",
  digest: "sha256:d44abd139d712965bf29ecd58f0c6af99017c1c13cf74eed645cb1fd2d5122cd",
  size: 69_425_005,
};

export const INSTALLER_POLL_MS = 2000;
export const INSTALLER_WAIT_MS = 10 * 60 * 1000;
/** Installing the kernel unpacks 664 MiB of archive. */
const KERNEL_SET_TIMEOUT_MS = 10 * 60 * 1000;
const INSPECT_TIMEOUT_MS = 30_000;
/** What the tool says for an image it does not hold: "image not found: <name>" (1.6.1: ImageInspect.swift). */
const IMAGE_NOT_FOUND = /image not found/i;

/**
 * Where the tool keeps its default kernel: a link named after the processor
 * in the kernels folder of its application folder (1.6.1: KernelService.swift).
 * The tool itself asks the same question to decide whether it needs a kernel.
 */
export function defaultKernelLink(home: string = os.homedir()): string {
  return join(home, "Library", "Application Support", "com.apple.container", "kernels", "default.kernel-arm64");
}

/** True when the default kernel link leads to a file. Reading it changes nothing. */
export function kernelPresent(link: string = defaultKernelLink()): boolean {
  try {
    return statSync(realpathSync(link)).isFile();
  } catch {
    return false;
  }
}

/** How Apple's tool stands on this Mac, from its detection. */
export type MacState = "tool_missing" | "service_stopped" | "running";

/**
 * What a Mac still needs before the engine, found by looking and never by
 * changing anything. Every part that is already there is left alone: an
 * installed tool is not installed again, a kernel is not downloaded again,
 * and present startup files are not fetched.
 */
export interface MacNeed {
  /** Download Apple's installer and wait for the approval. */
  tool: boolean;
  /** Start the tool's system service. */
  service: boolean;
  /** No default kernel is installed. */
  kernel: boolean;
  /** The startup files: missing, or not known until the service runs. Absent from the need when they are there. */
  init: "missing" | "unknown" | null;
  /**
   * The tool is the release the pins are for, so aidm-ui downloads the kernel
   * and the startup files itself. Another release fetches its own, as its
   * service start does with --enable-kernel-install.
   */
  pinned: boolean;
}

export type MacSetupResult = { ok: true } | { ok: false; step: InstallStepId; error: ApiError };

export interface MacSetupDeps {
  runner: CommandRunner;
  dataFolder: string;
  /** Tests point these at a fake file server and a fake registry. */
  installer?: InstallerPin;
  kernel?: KernelPin;
  initImage?: InitImagePin;
  fetch?: DownloadOptions["fetch"];
  freeBytes?: FreeBytes;
  /** Passed to the downloads, so a test does not wait between tries. */
  backoffMs?: DownloadOptions["backoffMs"];
  /** Passed to the downloads, so a test does not wait minutes for a stall. */
  stallMs?: DownloadOptions["stallMs"];
  idleMs?: DownloadOptions["idleMs"];
  /** Whether a default kernel is installed; tests answer it. Default: the link in the tool's folder. */
  kernelPresent?: () => boolean;
  /** Waits for the given milliseconds. */
  sleep?: (ms: number) => Promise<void>;
  /** Milliseconds since the epoch. */
  now?: () => number;
  pollMs?: number;
  waitMs?: number;
  /** Picks the subnet of the tool's network before the first start of a tool aidm-ui installed (ADR 0006). */
  network?: Pick<AppleNetwork, "prepareFirstStart">;
  log: (line: string) => void;
}

export interface MacSetupRun {
  signal?: AbortSignal;
  /** Fires when the operator stops waiting for the approval. It ends only that step, with mac.install_not_finished. */
  stopWaiting?: AbortSignal;
  /** A step began. */
  onStep: (step: InstallStepId) => void;
  /** Bytes the step under way has received so far, and its speed in bytes per second when that is known. */
  onReceived: (received: number, bytesPerSecond?: number | null) => void;
}

/**
 * Puts what Apple's container tool needs on a Mac, step by step, and only
 * what is missing: the tool, its running service, its kernel and its
 * startup files. Nothing here stops, removes or resets the tool, its kernel
 * or its images. It knows nothing about the engine: the engine manager runs
 * the engine install after it.
 */
export class MacSetup {
  private readonly installer: InstallerPin;
  private readonly kernel: KernelPin;
  private readonly initImage: InitImagePin;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly deps: MacSetupDeps) {
    this.installer = deps.installer ?? APPLE_CONTAINER_INSTALLER;
    this.kernel = deps.kernel ?? APPLE_CONTAINER_KERNEL;
    this.initImage = deps.initImage ?? APPLE_CONTAINER_INIT_IMAGE;
    this.sleep = deps.sleep ?? ((ms) => Bun.sleep(ms));
    this.now = deps.now ?? Date.now;
  }

  /**
   * What is missing, or null when nothing is. `toolVersion` is the release
   * the tool reported, null when it is not installed. The startup files can
   * only be asked for while the service runs.
   */
  async need(state: MacState, toolVersion: string | null): Promise<MacNeed | null> {
    const tool = state === "tool_missing";
    const pinned = tool ? this.installer.version === this.kernel.forTool : toolVersion === this.kernel.forTool;
    const kernel = !this.hasKernel();
    let init: MacNeed["init"] = null;
    if (pinned && state === "running") {
      const found = await this.initState();
      init = found.state === "present" ? null : found.state === "absent" ? "missing" : "unknown";
    } else if (pinned) {
      init = "unknown";
    }
    const need: MacNeed = { tool, service: state !== "running", kernel, init, pinned };
    return need.tool || need.service || need.kernel || need.init !== null ? need : null;
  }

  /**
   * The steps `run` will take, with what each downloads, before any of them
   * starts. `localNetwork`: the engine will be reached through a published
   * port, so macOS asks for the Local Network permission when it first
   * starts. The step is the operator's to answer, and `run` never waits on it.
   */
  steps(need: MacNeed, options: { localNetwork: boolean } = { localNetwork: true }): InstallStepView[] {
    const steps: InstallStepView[] = [];
    if (need.tool) steps.push({ id: "installer", size: this.installer.size }, { id: "approve", size: null });
    if (need.tool && options.localNetwork) steps.push({ id: "network", size: null });
    if (need.service || need.tool) steps.push({ id: "service", size: null });
    // Another release of the tool downloads a kernel of its own, whose size is not pinned.
    if (need.kernel) steps.push({ id: "kernel", size: need.pinned ? this.kernel.size : null });
    if (need.init !== null) steps.push({ id: "init", size: this.initImage.size });
    return steps;
  }

  async run(need: MacNeed, run: MacSetupRun): Promise<MacSetupResult> {
    if (need.tool) {
      const installed = await this.installTool(run);
      if (!installed.ok) return installed;
    }
    if (need.service || need.tool) {
      const started = await this.startService(need, run);
      if (!started.ok) return started;
    }
    if (need.pinned && !this.hasKernel()) {
      const kernel = await this.installKernel(run);
      if (!kernel.ok) return kernel;
    }
    if (need.pinned && need.init !== null) {
      const init = await this.installInitImage(run);
      if (!init.ok) return init;
    }
    return { ok: true };
  }

  /**
   * Starts the tool's service for an engine that is installed already: a
   * reboot stops it. Always with --disable-kernel-install, so it never asks
   * for or downloads a kernel; the one the engine ran on is still there.
   */
  startStoppedService(signal?: AbortSignal): Promise<MacSetupResult> {
    const need: MacNeed = { tool: false, service: true, kernel: false, init: null, pinned: true };
    return this.startService(need, { signal, onStep: () => {}, onReceived: () => {} });
  }

  // Inside ------------------------------------------------------------------

  private hasKernel(): boolean {
    return (this.deps.kernelPresent ?? (() => kernelPresent()))();
  }

  private downloadOptions(run: MacSetupRun): Pick<DownloadOptions, "fetch" | "signal" | "freeBytes" | "backoffMs" | "stallMs" | "idleMs" | "onProgress" | "log"> {
    return {
      fetch: this.deps.fetch,
      signal: run.signal,
      freeBytes: this.deps.freeBytes,
      backoffMs: this.deps.backoffMs,
      stallMs: this.deps.stallMs,
      idleMs: this.deps.idleMs,
      onProgress: (received) => run.onReceived(received),
      log: this.deps.log,
    };
  }

  private async installTool(run: MacSetupRun): Promise<MacSetupResult> {
    run.onStep("installer");
    const path = join(this.deps.dataFolder, "downloads", `container-${this.installer.version}-installer-signed.pkg`);
    // The downloader checks the SHA-256 before it names the file, and again for a file that is already there.
    // Nothing below runs unless that check passed.
    const downloaded = await downloadVerified(
      { url: this.installer.url, size: this.installer.size, sha256: this.installer.sha256, path },
      { ...this.downloadOptions(run), label: `Apple's installer ${this.installer.version}` },
    );
    if (!downloaded.ok) return { ok: false, step: "installer", error: downloaded.error };

    run.onStep("approve");
    // Opening the package makes macOS ask for the administrator password, once.
    const opening = ["open", downloaded.path];
    const opened = await this.deps.runner.run(opening);
    if (opened.exitCode !== 0) return this.notFinished("open_failed");

    // A dismissed prompt cannot be seen from here: the tool just never appears.
    const deadline = this.now() + (this.deps.waitMs ?? INSTALLER_WAIT_MS);
    for (;;) {
      if (run.signal?.aborted) return { ok: false, step: "approve", error: { code: "download.cancelled", data: {} } };
      if (run.stopWaiting?.aborted) return this.notFinished("cancelled");
      if (await this.toolAnswers()) return { ok: true };
      if (this.now() >= deadline) return this.notFinished("timeout");
      await this.pause(run.stopWaiting);
    }
  }

  private notFinished(reason: "timeout" | "open_failed" | "cancelled"): MacSetupResult {
    return { ok: false, step: "approve", error: { code: "mac.install_not_finished", data: { reason } } };
  }

  /** Waits for the next poll, or until the operator stops waiting. */
  private async pause(stop: AbortSignal | undefined): Promise<void> {
    const wait = this.sleep(this.deps.pollMs ?? INSTALLER_POLL_MS);
    if (stop === undefined) return wait;
    if (stop.aborted) return;
    let onStop = (): void => {};
    const stopped = new Promise<void>((resolve) => {
      onStop = resolve;
      stop.addEventListener("abort", onStop, { once: true });
    });
    await Promise.race([wait, stopped]);
    stop.removeEventListener("abort", onStop);
  }

  /**
   * The tool has appeared when it answers `--version` with its version line.
   * A file that is there but does not answer yet does not count. Only the
   * installer's own path is asked, never a tool of the same name found through PATH.
   */
  private async toolAnswers(): Promise<boolean> {
    const answer = await this.deps.runner.run([APPLE_TOOL, "--version"]);
    return answer.exitCode === 0 && parseToolVersion(answer.stdout) !== null;
  }

  /**
   * Starts the system service. In the tool's source at 1.6.1 the start
   * returns before the kernel question when a kernel is installed, and asks
   * on standard input when none is and no flag says what to do. So the
   * flag is always there: --disable-kernel-install for the pinned release,
   * whose kernel aidm-ui installs itself from a checked download, and
   * --enable-kernel-install only for another release that has no kernel,
   * which then downloads its own. The kernel option never comes with a
   * kernel that is there.
   */
  private async startService(need: MacNeed, run: MacSetupRun): Promise<MacSetupResult> {
    const ownKernel = !need.pinned && !this.hasKernel();
    const argv = [APPLE_TOOL, "system", "start", ownKernel ? "--enable-kernel-install" : "--disable-kernel-install"];
    const step: InstallStepId = ownKernel ? "kernel" : "service";
    run.onStep(step);
    // The tool reads its subnet at this start, and a fresh tool has never had one.
    if (need.tool) await this.deps.network?.prepareFirstStart();
    const result = await this.deps.runner.stream(argv, {
      signal: run.signal,
      onLine: (line) => {
        this.deps.log(line);
        // The tool's own kernel download says its bytes on its progress lines.
        const bytes = ownKernel ? parseAppleProgress(line)?.bytes : undefined;
        if (bytes !== undefined && bytes !== null) run.onReceived(bytes.done);
      },
    });
    if (result.exitCode === 0) return { ok: true };
    if (run.signal?.aborted) return { ok: false, step, error: { code: "download.cancelled", data: {} } };
    this.deps.log(`Service check failed: expected "container system start" to exit 0, found exit ${result.exitCode}`);
    return { ok: false, step, error: { code: "mac.start_failed", data: { step, exitCode: result.exitCode } } };
  }

  /**
   * Downloads the pinned kernel archive with resume and its checksum, then
   * hands the file to the tool's own kernel command, which installs it as
   * the default (1.6.1: KernelSet.swift takes a local tar and checks the
   * digest). Never with --force, so a kernel that is there is never replaced.
   * The archive goes once the tool has it.
   */
  private async installKernel(run: MacSetupRun): Promise<MacSetupResult> {
    run.onStep("kernel");
    const path = join(this.deps.dataFolder, "downloads", `kata-static-${this.kernel.version}-arm64.tar.zst`);
    const downloaded = await downloadVerified(
      { url: this.kernel.url, size: this.kernel.size, sha256: this.kernel.sha256, path },
      { ...this.downloadOptions(run), label: `Linux system for Apple's tool (Kata ${this.kernel.version})` },
    );
    if (!downloaded.ok) return { ok: false, step: "kernel", error: downloaded.error };
    const argv = [APPLE_TOOL, "system", "kernel", "set", "--tar", path, "--binary", this.kernel.member, "--digest", `sha256:${this.kernel.sha256}`];
    const result = await this.deps.runner.run(argv, { timeoutMs: KERNEL_SET_TIMEOUT_MS });
    if (result.exitCode !== 0) {
      this.deps.log(`Kernel check failed: expected the tool's kernel set to exit 0, found exit ${result.exitCode}: ${excerpt(result.stderr || result.stdout)}`);
      return { ok: false, step: "kernel", error: { code: "mac.kernel_failed", data: { exitCode: result.exitCode } } };
    }
    rmSync(path, { force: true });
    return { ok: true };
  }

  /**
   * Whether the tool holds the startup files under the name it looks for.
   * Needs the service. The tool hides its own infrastructure images (the
   * startup files and the builder) from inspect, list and delete
   * (1.6.1: Utility.isInfraImage in ImageInspect.swift), so for them inspect
   * exits 0 with an empty list when the image is there, and exits 1 with
   * "image not found" when it is not. The empty list is the answer "present":
   * nothing in it can be checked.
   */
  private async initState(): Promise<{ state: "present" | "absent" } | { state: "unknown"; exitCode: number }> {
    const argv = [APPLE_TOOL, "image", "inspect", this.initImage.reference];
    const result = await this.deps.runner.run(argv, { timeoutMs: INSPECT_TIMEOUT_MS });
    if (result.exitCode === 0) return { state: "present" };
    if (IMAGE_NOT_FOUND.test(`${result.stderr}\n${result.stdout}`)) return { state: "absent" };
    this.deps.log(`Startup files check failed: expected exit 0 (there) or "image not found" (missing), found exit ${result.exitCode}: ${excerpt(result.stderr || result.stdout)}`);
    return { state: "unknown", exitCode: result.exitCode };
  }

  /**
   * The startup files come through the image downloader and the tool's own
   * load, like the engine (ADR 0005): the tool's pull keeps nothing from a
   * failed try. Startup files that are there are left as they are. Every blob
   * is checked against its digest before the load, and the load counts when
   * it exits 0 and names the image it loaded. The tool shows no digest of its
   * infrastructure images afterwards, so nothing more can be asked: the first
   * container start is the last proof.
   */
  private async installInitImage(run: MacSetupRun): Promise<MacSetupResult> {
    run.onStep("init");
    const before = await this.initState();
    if (before.state === "present") return { ok: true };
    if (before.state === "unknown") {
      return { ok: false, step: "init", error: { code: "mac.init_check_failed", data: { exitCode: before.exitCode } } };
    }
    const pinned: PinnedImage = { repository: this.initImage.repository, digest: this.initImage.digest, name: this.initImage.reference };
    const folder = imageFolder(this.deps.dataFolder, pinned);
    const options: ImageDownloadOptions = {
      fetch: this.deps.fetch,
      signal: run.signal,
      backoffMs: this.deps.backoffMs,
      stallMs: this.deps.stallMs,
      idleMs: this.deps.idleMs,
      onProgress: (progress) => run.onReceived(progress.received, progress.bytesPerSecond),
      log: this.deps.log,
    };
    const downloaded = await downloadImage(pinned, folder, options);
    if (!downloaded.ok) return { ok: false, step: "init", error: downloaded.error };
    const loaded = await loadIntoAppleTool(this.deps.runner, downloaded.image, { signal: run.signal, log: this.deps.log });
    if (!loaded.ok) {
      if (loaded.error.code === "download.cancelled" || loaded.error.code === "runtime.apple_not_started") {
        return { ok: false, step: "init", error: loaded.error };
      }
      return { ok: false, step: "init", error: { code: "mac.init_load_failed", data: { exitCode: loaded.error.data.exitCode ?? null } } };
    }
    if (!loaded.references.includes(this.initImage.reference)) {
      this.deps.log(`Startup files check failed: expected the load to name ${this.initImage.reference}, found ${loaded.references.join(", ") || "no name"}`);
      return { ok: false, step: "init", error: { code: "mac.init_not_named", data: {} } };
    }
    removeImageDownload(folder);
    return { ok: true };
  }
}
