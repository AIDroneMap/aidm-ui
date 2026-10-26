import { parseArgs } from "node:util";
import { isValidUserName } from "../runtimes/setup-command.ts";

export interface CommandLine {
  port?: number;
  dataFolder?: string;
  /** A diagnostic option for the maintainer. It is not shown in the interface. */
  recordRuntimeCommands?: true;
}

export type ParseResult =
  | { ok: true; commandLine: CommandLine }
  | { ok: false; problem: string };

// These lines go to the terminal, not to the interface, so they are plain English here.
export function parseCommandLine(argv: string[]): ParseResult {
  let values: { port?: string; "data-dir"?: string; "record-runtime-commands"?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        port: { type: "string" },
        "data-dir": { type: "string" },
        "record-runtime-commands": { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    return { ok: false, problem: error instanceof Error ? firstLine(error.message) : String(error) };
  }

  const commandLine: CommandLine = {};
  if (values.port !== undefined) {
    if (!/^\d+$/.test(values.port)) return badPort(values.port);
    const port = Number(values.port);
    if (port < 1 || port > 65535) return badPort(values.port);
    commandLine.port = port;
  }
  if (values["data-dir"] !== undefined) commandLine.dataFolder = values["data-dir"];
  if (values["record-runtime-commands"] === true) commandLine.recordRuntimeCommands = true;
  return { ok: true, commandLine };
}

function badPort(value: string): ParseResult {
  return { ok: false, problem: `--port must be a number from 1 to 65535, got "${value}"` };
}

function firstLine(text: string): string {
  return text.split("\n")[0] ?? text;
}

export type SetupParseResult = { ok: true; user: string } | { ok: false; problem: string };

/**
 * `setup-podman --user <name>`, the step that runs as the administrator.
 * Null when the command line is not that command, so the normal start reads it
 * as before. It takes the user name and nothing else.
 */
export function parseSetupCommand(argv: string[]): SetupParseResult | null {
  if (argv[0] !== "setup-podman") return null;
  let user: string | undefined;
  try {
    ({
      values: { user },
    } = parseArgs({ args: argv.slice(1), options: { user: { type: "string" } }, strict: true, allowPositionals: false }));
  } catch (error) {
    return { ok: false, problem: error instanceof Error ? firstLine(error.message) : String(error) };
  }
  if (user === undefined) return { ok: false, problem: "setup-podman needs --user <name>" };
  // The first of three checks of the user name, kept on purpose: see isValidUserName.
  if (!isValidUserName(user)) return { ok: false, problem: "--user must be a user name made of letters, digits, dots, hyphens and underscores" };
  return { ok: true, user };
}
