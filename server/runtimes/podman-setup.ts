import { isAbsolute } from "node:path";
import type { ApiError } from "../../shared/api-error.ts";
import type { CheckLine, RuntimeSetupView, SetupPhase } from "../../shared/api-types.ts";
import type { MachineChecks } from "../machine/machine-checks.ts";
import { EXIT_CANNOT_RUN, systemRunner, type CommandResult, type CommandRunner } from "../process/command-runner.ts";
import { isValidUserName, readDistribution, SETUP_EXIT, type SystemFiles } from "./setup-command.ts";

/** What pkexec exits with when the operator closed the password window, and when it was not allowed or had nobody to ask. */
export const EXIT_DISMISSED = 126;
export const EXIT_NOT_AUTHORISED = 127;

const MIGRATE_TIMEOUT_MS = 2 * 60_000;
/** How many of the last lines the privileged step printed are kept for the server log when it fails. */
const KEPT_LINES = 20;
const KEPT_LINE_LENGTH = 300;

/** The one way the server asks for administrator rights, so that tests can answer for it. */
export interface PrivilegedRunner {
  /**
   * Runs the aidm-ui executable with these arguments as the administrator,
   * after the desktop has asked the operator once. `onLine` hears each line the
   * program prints, which is how the server knows the approval was given.
   *
   * It has no time limit: a program that runs as the administrator cannot be
   * stopped from here, so the call waits for it to end. A result with
   * `spawnFailure` set means the asking program could not be started at all,
   * and its exit code is not an answer from the operator or the desktop.
   */
  runAsRoot(argv: string[], onLine?: (line: string) => void): Promise<CommandResult>;
}

/**
 * The real one. The executable is named by its full path, so that the
 * desktop's window shows a path the operator recognises, and no script is
 * written anywhere.
 *
 * The setup subcommand is reachable only from the compiled executable. In
 * development `process.execPath` is bun itself, so this would ask the desktop
 * to run bun as the administrator with arguments it does not understand, and
 * the setup is not meant to be tried that way.
 */
export function pkexecRunner(executable: string, runner: CommandRunner = systemRunner()): PrivilegedRunner {
  if (!isAbsolute(executable)) throw new Error("The program to run with administrator rights needs a full path.");
  return {
    runAsRoot: (argv, onLine) =>
      runner.stream(["pkexec", executable, ...argv], {
        // pkexec's own complaints go to the other stream and say nothing about the approval.
        onLine: (line, from) => {
          if (from === "stdout") onLine?.(line);
        },
      }),
  };
}

export type SetupStart = { ok: true } | { ok: false; status: number; error: ApiError };

export interface RuntimeSetupDeps {
  platform: string;
  /** The user name of the operator, who gets the ID ranges. */
  operator: string;
  privileged: PrivilegedRunner;
  /** The operator's own view of the files, for the first look at the distribution. */
  files: SystemFiles;
  /** Runs programs as the operator. */
  runner: CommandRunner;
  checks: Pick<MachineChecks, "fresh">;
  /** The install of the local engine, which goes on by itself once a tool works. */
  install: () => Promise<{ ok: true } | { ok: false; error: ApiError }>;
  log: (line: string) => void;
}

function refusal(status: number, code: ApiError["code"]): SetupStart {
  return { ok: false, status, error: { code, data: {} } };
}

/** A tool that works, even one that cannot limit memory. */
export function runtimeWorks(line: CheckLine | undefined): boolean {
  return line !== undefined && (line.result === "pass" || line.message.code === "machine.runtime_no_memory_cap");
}

/**
 * Installs Podman where no container tool works, with one approval from the
 * operator, and then carries on with the install of the engine.
 */
export class RuntimeSetup {
  private current: RuntimeSetupView | null = null;
  private running = false;
  private background: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(view: RuntimeSetupView) => void>();
  private published: string | undefined;

  constructor(private readonly deps: RuntimeSetupDeps) {}

  /** Null until a setup has begun. */
  view(): RuntimeSetupView | null {
    return this.current;
  }

  /** True from the click until the setup has ended, whatever way it ended. */
  isRunning(): boolean {
    return this.running;
  }

  subscribe(listener: (view: RuntimeSetupView) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Resolves when the setup in the background has ended. For tests. */
  settled(): Promise<void> {
    return this.background;
  }

  /**
   * Begins the setup. A refusal means nothing started. Otherwise the answer is
   * "ok" at once, and the view tells how it goes, including a failure that
   * came before any prompt, such as a distribution that is not supported.
   */
  async start(): Promise<SetupStart> {
    if (this.running) return refusal(409, "setup.already_running");
    if (this.deps.platform !== "linux") return refusal(409, "setup.not_offered");
    this.running = true;
    let began = false;
    try {
      const check = await this.deps.checks.fresh();
      const line = check.lines.find((candidate) => candidate.id === "runtime");
      if (line === undefined) return refusal(409, "setup.not_offered");
      if (runtimeWorks(line)) return refusal(409, "setup.not_needed");

      // Looked at as the operator, so an unsupported computer is never asked for a password.
      const distribution = readDistribution(this.deps.files);
      if (!distribution.supported) {
        this.set("failed", { code: "setup.unsupported_distribution", data: { id: distribution.id } });
        return { ok: true };
      }
      // The second of three checks of the user name, kept on purpose: see isValidUserName.
      if (!isValidUserName(this.deps.operator)) {
        this.set("failed", { code: "setup.failed", data: { code: SETUP_EXIT.badArguments } });
        return { ok: true };
      }

      this.set("approval");
      began = true;
      this.background = this.run(distribution.id).finally(() => {
        this.running = false;
      });
      return { ok: true };
    } finally {
      if (!began) this.running = false;
    }
  }

  private async run(distributionId: string): Promise<void> {
    const { deps } = this;
    // The last lines of what the privileged step said, for the server log and never for the browser.
    const printed: string[] = [];
    const logPrinted = () => {
      for (const line of printed) deps.log(`  setup output: ${line}`);
    };
    try {
      const result = await deps.privileged.runAsRoot(["setup-podman", "--user", deps.operator], (line) => {
        printed.push(line.slice(0, KEPT_LINE_LENGTH));
        if (printed.length > KEPT_LINES) printed.shift();
        // The first line comes after the approval, so the password window is gone by now.
        if (this.current?.phase === "approval") this.set("installing");
      });
      const problem = problemFor(result, distributionId);
      if (problem !== null) {
        deps.log(
          result.spawnFailure === undefined
            ? `Setting up Podman failed with exit code ${result.exitCode}.`
            : `Setting up Podman failed: the program that asks for approval could not be started (${result.spawnFailure}).`,
        );
        logPrinted();
        this.set("failed", problem);
        return;
      }

      this.set("checking");
      // Podman keeps a background process that does not see new ID ranges until it is stopped, and this stops it.
      const migrated = await deps.runner.run(["podman", "system", "migrate"], { timeoutMs: MIGRATE_TIMEOUT_MS });
      if (migrated.exitCode !== 0) deps.log(`podman system migrate exited with ${migrated.exitCode}.`);
      const check = await deps.checks.fresh();
      if (!runtimeWorks(check.lines.find((candidate) => candidate.id === "runtime"))) {
        deps.log("Podman was installed but the check still finds no working container tool.");
        logPrinted();
        this.set("failed", { code: "setup.runtime_not_working", data: {} });
        return;
      }

      const installed = await deps.install();
      if (!installed.ok) {
        this.set("failed", installed.error);
        return;
      }
      this.set("done");
    } catch (error) {
      deps.log(`Setting up Podman failed: ${error instanceof Error ? error.message : String(error)}`);
      this.set("failed", { code: "server.internal_error", data: {} });
    }
  }

  private set(phase: SetupPhase, problem: ApiError | null = null): void {
    this.current = { phase, problem };
    const json = JSON.stringify(this.current);
    if (json === this.published) return;
    this.published = json;
    for (const listener of [...this.listeners]) {
      try {
        listener(this.current);
      } catch (error) {
        this.deps.log(`A setup listener failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

/** The message for the end of the privileged step, or null for success. */
function problemFor(result: CommandResult, distributionId: string): ApiError | null {
  // A program that could not be started gave no answer, so its exit code is not read as one of pkexec's.
  if (result.spawnFailure === "not_found") return { code: "setup.not_available", data: {} };
  if (result.spawnFailure === "cannot_run") return { code: "setup.failed", data: { code: EXIT_CANNOT_RUN } };
  const exitCode = result.exitCode;
  if (exitCode === SETUP_EXIT.done) return null;
  if (exitCode === EXIT_DISMISSED) return { code: "setup.dismissed", data: {} };
  if (exitCode === EXIT_NOT_AUTHORISED) return { code: "setup.not_authorised", data: {} };
  if (exitCode === SETUP_EXIT.unsupportedDistribution) {
    return { code: "setup.unsupported_distribution", data: { id: distributionId } };
  }
  return { code: "setup.failed", data: { code: exitCode } };
}
