import { parseArgs } from "node:util";

export interface CommandLine {
  port?: number;
  dataFolder?: string;
}

export type ParseResult =
  | { ok: true; commandLine: CommandLine }
  | { ok: false; problem: string };

// These lines go to the terminal, not to the interface, so they are plain English here.
export function parseCommandLine(argv: string[]): ParseResult {
  let values: { port?: string; "data-dir"?: string };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        port: { type: "string" },
        "data-dir": { type: "string" },
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
  return { ok: true, commandLine };
}

function badPort(value: string): ParseResult {
  return { ok: false, problem: `--port must be a number from 1 to 65535, got "${value}"` };
}

function firstLine(text: string): string {
  return text.split("\n")[0] ?? text;
}
