import { seconds } from "../app/diagnosis-log.ts";
import { describeCommand, type CommandRunner } from "./command-runner.ts";

/**
 * Writes one line to the diagnosis log for every command: the command line
 * with the value after --token hidden, the exit code and how long it took.
 * A streamed command, which may run for minutes, also gets a line when it
 * starts. One that aidm-ui ends itself, through its signal, is said to be
 * stopped, not to have ended with the exit code the kill gave it (137 reads
 * like a crash). Its output is not logged: the recording option keeps it whole.
 */
export function loggingRunner(inner: CommandRunner, log: (line: string) => void, now: () => number = Date.now): CommandRunner {
  return {
    async run(argv, options) {
      const started = now();
      const result = await inner.run(argv, options);
      log(`Command: ${describeCommand(argv)} -> exit ${result.exitCode} after ${seconds(now() - started)}`);
      return result;
    },
    async stream(argv, options) {
      const started = now();
      log(`Command started: ${describeCommand(argv)}${options.stdin === undefined ? "" : " (with input)"}`);
      const result = await inner.stream(argv, options);
      if (options.signal?.aborted === true) log(`Command stopped by aidm-ui: ${describeCommand(argv)} after ${seconds(now() - started)}`);
      else log(`Command ended: ${describeCommand(argv)} -> exit ${result.exitCode} after ${seconds(now() - started)}`);
      return result;
    },
  };
}
