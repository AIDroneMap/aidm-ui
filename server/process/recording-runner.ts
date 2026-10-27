import { appendFileSync, closeSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import os from "node:os";
import { dirname } from "node:path";
import { hideTokenArguments, type CommandRunner } from "./command-runner.ts";

export interface RecordingOptions {
  /** The JSON Lines file. Its folder is made when it is missing. */
  file: string;
  /** The secrets to hide, asked again for every command because an engine token can appear later. */
  secrets: () => string[];
  now?: () => number;
  /** The whole file stops growing here. Default 64 MiB. */
  maxBytes?: number;
  /** The version of aidm-ui, for the session record. */
  version?: string;
}

/** How much of the end of an earlier file is read to learn where its numbers stopped. */
const TAIL_BYTES = 1024 * 1024;

/**
 * The last command number and session number in a file an earlier start left,
 * read from its last records. A file that cannot be read starts at 0.
 */
export function lastNumbers(file: string): { seq: number; session: number } {
  let seq = 0;
  let session = 0;
  try {
    const size = statSync(file).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const fd = openSync(file, "r");
    const buffer = Buffer.alloc(size - start);
    try {
      readSync(fd, buffer, 0, buffer.length, start);
    } finally {
      closeSync(fd);
    }
    for (const line of buffer.toString("utf8").split("\n")) {
      if (!line.startsWith("{")) continue;
      try {
        const record = JSON.parse(line) as { seq?: unknown; session?: unknown };
        if (typeof record.seq === "number" && record.seq > seq) seq = record.seq;
        if (typeof record.session === "number" && record.session > session) session = record.session;
      } catch {
        // A line cut by the size limit or a crash says nothing.
      }
    }
  } catch {
    // No file yet.
  }
  return { seq, session };
}

export const DEFAULT_RECORDING_MAX_BYTES = 64 * 1024 * 1024;
/** A command that streams for hours (a followed log) would otherwise fill the file by itself. */
export const MAX_LINES_PER_COMMAND = 5000;
/** A shorter secret would hide ordinary text, so it is left alone. */
export const MIN_SECRET_LENGTH = 8;

/**
 * A diagnostic copy of every command that goes through the inner runner, with
 * its output and exit code, so that a run on a real machine can become test
 * fixtures. Each record is appended at once, so a crash loses nothing already
 * written. The result handed back is the inner one, untouched: only the file
 * is redacted. A write that fails stops the recording and never the command.
 * The first record of each start is a session record with the time and the
 * version of aidm-ui, so that a file filled by several starts can be told
 * apart, and the numbers of the commands go on where the file left off, so
 * no two commands in one file share a number.
 */
export function recordingRunner(inner: CommandRunner, options: RecordingOptions): CommandRunner {
  const now = options.now ?? Date.now;
  const maxBytes = options.maxBytes ?? DEFAULT_RECORDING_MAX_BYTES;
  const earlier = lastNumbers(options.file);
  let sequence = earlier.seq;
  let stopped = false;
  let written = 0;

  try {
    mkdirSync(dirname(options.file), { recursive: true, mode: 0o700 });
    // An empty append makes the file now, owner-only, and tells how much an earlier run left in it.
    appendFileSync(options.file, "", { mode: 0o600 });
    written = statSync(options.file).size;
  } catch {
    stopped = true;
  }

  const append = (text: string): void => {
    try {
      appendFileSync(options.file, text, { mode: 0o600 });
    } catch {
      // A full disk or a vanished folder must not break the command that is running.
      stopped = true;
    }
  };

  // The record is built inside, so that a secrets() that fails also only stops the recording.
  const write = (build: () => Record<string, unknown>): void => {
    if (stopped) return;
    let text: string;
    try {
      text = `${JSON.stringify(build())}\n`;
    } catch {
      stopped = true;
      return;
    }
    const size = Buffer.byteLength(text);
    if (written + size > maxBytes) {
      stopped = true;
      append(`${JSON.stringify({ kind: "stopped", reason: "size_limit" })}\n`);
      return;
    }
    append(text);
    written += size;
  };

  // Only what tells one machine type from another, and nothing that names this machine or its owner.
  write(() => ({
    kind: "session",
    session: earlier.session + 1,
    at: new Date(now()).toISOString(),
    version: options.version ?? null,
    firstSeq: earlier.seq + 1,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
  }));

  /** Asked for every piece of text, because an engine token can appear while a command runs. */
  const redact = (text: string): string => {
    // Longest first, so that a secret inside a longer one cannot leave a tail behind.
    const secrets = options
      .secrets()
      .filter((secret) => secret.length >= MIN_SECRET_LENGTH)
      .sort((a, b) => b.length - a.length);
    return secrets.reduce((kept, secret) => kept.split(secret).join("***"), text);
  };
  const redactArgv = (argv: string[]): string[] => hideTokenArguments(argv).map(redact);

  return {
    async run(argv, runOptions) {
      const seq = ++sequence;
      const started = now();
      const result = await inner.run(argv, runOptions);
      write(() => ({
        seq,
        at: new Date(started).toISOString(),
        kind: "run",
        argv: redactArgv(argv),
        exitCode: result.exitCode,
        stdout: redact(result.stdout),
        stderr: redact(result.stderr),
        durationMs: now() - started,
      }));
      return result;
    },
    async stream(argv, streamOptions) {
      const seq = ++sequence;
      const started = now();
      write(() => ({ seq, at: new Date(started).toISOString(), kind: "stream-start", argv: redactArgv(argv), ...(streamOptions.stdin === undefined ? {} : { stdin: "archive" }) }));
      let lines = 0;
      let droppedLines = 0;
      const result = await inner.stream(argv, {
        ...streamOptions,
        onLine(line, from) {
          if (lines < MAX_LINES_PER_COMMAND) {
            lines++;
            write(() => ({ seq, kind: "line", from, text: redact(line) }));
          } else {
            droppedLines++;
          }
          streamOptions.onLine(line, from);
        },
      });
      write(() => ({ seq, kind: "stream-end", exitCode: result.exitCode, durationMs: now() - started, droppedLines }));
      return result;
    },
  };
}
