import { isAbsolute } from "node:path";
import type { ApiError } from "../../shared/api-error.ts";
import type { CheckLine, RuntimeSetupView, SetupPhase } from "../../shared/api-types.ts";
import type { MachineChecks } from "../machine/machine-checks.ts";
import { systemRunner, type CommandResult, type CommandRunner } from "../process/command-runner.ts";
import { isValidUserName, readDistribution, SETUP_EXIT, type SystemFiles } from "./setup-command.ts";

/** What pkexec exits with when the operator closed the password window, and when it was not allowed or had nobody to ask. */
export const EXIT_DISMISSED = 126;
export const EXIT_NOT_AUTHORISED = 127;

/** The operator may take a while to find the password, and the install may take minutes after that. */
const PRIVILEGED_TIMEOUT_MS = 45 * 60_000;
const MIGRATE_TIMEOUT_MS = 2 * 60_000;

/** The one way the server asks for administrator rights, so that tests can answer for it. */
export interface PrivilegedRunner {
  /**
   * Runs the aidm-ui executable with these arguments as the administrator,
   * after the desktop has asked the operator once. `onLine` hears each line the
   * program prints, which is how the server knows the approval was given.
   */
  runAsRoot(argv: string[], onLine?: (line: string) => void): Promise<CommandResult>;
}

/**
 * The real one. The executable is named by its full path, so that the
 * desktop's window shows a path the operator recognises, and no script is
 * written anywhere.
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
        timeoutMs: PRIVILEGED_TIMEOUT_MS,
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
    try {
      const result = await deps.privileged.runAsRoot(["setup-podman", "--user", deps.operator], () => {
        // The first line comes after the approval, so the password window is gone by now.
        if (this.current?.phase === "approval") this.set("installing");
      });
      const problem = problemFor(result.exitCode, distributionId);
      if (problem !== null) {
        deps.log(`Setting up Podman failed with exit code ${result.exitCode}.`);
        this.set("failed", problem);
        return;
      }

      this.set("checking");
      // Podman keeps a background process that does not see new ID ranges until it is stopped, and this stops it.
      const migrated = await deps.runner.run(["podman", "system", "migrate"], { timeoutMs: MIGRATE_TIMEOUT_MS });
      if (migrated.exitCode !== 0) deps.log(`podman system migrate exited with ${migrated.exitCode}.`);
      const check = await deps.checks.fresh();
      if (!runtimeWorks(check.lines.find((candidate) => candidate.id === "runtime"))) {
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

/** The message for an exit code of the privileged step, or null for success. */
function problemFor(exitCode: number, distributionId: string): ApiError | null {
  if (exitCode === SETUP_EXIT.done) return null;
  if (exitCode === EXIT_DISMISSED) return { code: "setup.dismissed", data: {} };
  if (exitCode === EXIT_NOT_AUTHORISED) return { code: "setup.not_authorised", data: {} };
  if (exitCode === SETUP_EXIT.unsupportedDistribution) {
    return { code: "setup.unsupported_distribution", data: { id: distributionId } };
  }
  return { code: "setup.failed", data: { code: exitCode } };
}
