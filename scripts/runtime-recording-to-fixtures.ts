// Turns a recording of runtime commands into fixture files. For the maintainer.
//
//   bun scripts/runtime-recording-to-fixtures.ts <recording.jsonl> <out-folder>
//
// The recording comes from starting aidm-ui with --record-runtime-commands on
// the machine to learn from. The out folder gets, for each command, the files
// that test-support/recorded/README.md describes: <NNN>-<slug>.txt with the
// standard output, and <NNN>-<slug>.json with the exit code and standard error
// when either is not the plain success case. The cases are numbered in the
// order they appear in the file, across all the sessions (starts of aidm-ui)
// the file holds. index.txt lists every case with its command line, so that a
// person can rename the cases and check that nothing private is left in them
// before they join test-support/recorded.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FixtureFile {
  name: string;
  content: string;
}

interface Command {
  argv: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  finished: boolean;
}

/** What a session record says about the machine. Absent for the records of an older file. */
interface Session {
  platform: string;
  arch: string;
  osRelease: string;
}

/** The commands of one start of aidm-ui. The numbers of the commands begin at 1 again in each. */
interface Scope {
  session: Session | null;
  commands: Command[];
}

const MAX_SLUG_LENGTH = 40;

/** The words after the program name, as lower case letters and digits joined by single dashes. */
export function slugOf(argv: string[]): string {
  const slug = argv
    .slice(1)
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "command" : slug;
}

function linesToText(lines: string[]): string {
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/**
 * Reads the recording in file order. A session record opens a new scope, and
 * the lines and the end of a stream belong to the start with the same number
 * in the current scope, so repeated numbers in later sessions never merge.
 * Records before the first session record make one scope without a session.
 * The file may end in half a line when the program was killed.
 */
function readScopes(recording: string): Scope[] {
  const scopes: Scope[] = [];
  let streams = new Map<number, { command: Command; out: string[]; err: string[] }>();
  const current = (): Scope => {
    let scope = scopes.at(-1);
    if (scope === undefined) {
      scope = { session: null, commands: [] };
      scopes.push(scope);
    }
    return scope;
  };
  const argvOf = (argv: unknown) => (Array.isArray(argv) ? argv.map(String) : []);
  for (const text of recording.split("\n")) {
    if (text.trim() === "") continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(text) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (record.kind === "session") {
      scopes.push({
        session: {
          platform: String(record.platform ?? "unknown"),
          arch: String(record.arch ?? "unknown"),
          osRelease: String(record.osRelease ?? "unknown"),
        },
        commands: [],
      });
      streams = new Map();
      continue;
    }
    const seq = record.seq;
    if (typeof seq !== "number") continue;
    if (record.kind === "run") {
      current().commands.push({
        argv: argvOf(record.argv),
        exitCode: Number(record.exitCode),
        stdout: String(record.stdout ?? ""),
        stderr: String(record.stderr ?? ""),
        finished: true,
      });
    } else if (record.kind === "stream-start") {
      const command: Command = { argv: argvOf(record.argv), exitCode: 0, stdout: "", stderr: "", finished: false };
      current().commands.push(command);
      streams.set(seq, { command, out: [], err: [] });
    } else if (record.kind === "line") {
      const stream = streams.get(seq);
      if (stream === undefined) continue;
      (record.from === "stderr" ? stream.err : stream.out).push(String(record.text ?? ""));
      // The lines are joined the way the fixtures keep them.
      stream.command.stdout = linesToText(stream.out);
      stream.command.stderr = linesToText(stream.err);
    } else if (record.kind === "stream-end") {
      const stream = streams.get(seq);
      if (stream === undefined) continue;
      stream.command.exitCode = Number(record.exitCode);
      stream.command.finished = true;
    }
  }
  return scopes;
}

/** The fixture files for a recording, in the order of the commands. Pure: it touches no file. */
export function convertRecording(recording: string): FixtureFile[] {
  const files: FixtureFile[] = [];
  const index: string[] = [];
  // The cases are numbered by their place in the whole file, so that nothing from two sessions shares a number.
  let number = 0;
  for (const scope of readScopes(recording)) {
    if (scope.session !== null) {
      const { platform, arch, osRelease } = scope.session;
      index.push(`# session: platform ${platform}, arch ${arch}, os release ${osRelease}`);
    }
    for (const command of scope.commands) {
      const name = `${String(++number).padStart(3, "0")}-${slugOf(command.argv)}`;
      files.push({ name: `${name}.txt`, content: command.stdout });
      if (command.exitCode !== 0 || command.stderr !== "") {
        files.push({
          name: `${name}.json`,
          content: `${JSON.stringify({ exitCode: command.exitCode, stderr: command.stderr }, null, 2)}\n`,
        });
      }
      index.push(`${name}: ${command.argv.join(" ")}${command.finished ? "" : " (the recording ends before this command did)"}`);
    }
  }
  files.push({ name: "index.txt", content: linesToText(index) });
  return files;
}

/** Writes the conversion to a new or empty folder. The result is a plain English problem, or null. */
export function convertFile(recordingPath: string, outFolder: string): string | null {
  if (!existsSync(recordingPath) || !statSync(recordingPath).isFile()) {
    return `There is no recording file at ${recordingPath}.`;
  }
  if (existsSync(outFolder) && (!statSync(outFolder).isDirectory() || readdirSync(outFolder).length > 0)) {
    return `${outFolder} already exists and is not empty. Pass a new folder so that nothing is overwritten.`;
  }
  const files = convertRecording(readFileSync(recordingPath, "utf8"));
  mkdirSync(outFolder, { recursive: true });
  for (const file of files) writeFileSync(join(outFolder, file.name), file.content);
  return null;
}

export function main(args: string[], log: (line: string) => void = console.log): number {
  const [recordingPath, outFolder, ...extra] = args;
  if (recordingPath === undefined || outFolder === undefined || extra.length > 0) {
    log("Usage: bun scripts/runtime-recording-to-fixtures.ts <recording.jsonl> <out-folder>");
    return 1;
  }
  const problem = convertFile(recordingPath, outFolder);
  if (problem !== null) {
    log(problem);
    return 1;
  }
  log(`Wrote the fixture files to ${outFolder}. Read index.txt, rename the cases, and check them for private details.`);
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
