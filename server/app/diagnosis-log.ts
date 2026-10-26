import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/** The log of the server, in the logs folder of the data folder. The engine's own lines go to engine.log next to it. */
export const DIAGNOSIS_LOG_FILE = "aidm-ui.log";
export const DIAGNOSIS_LOG_ROTATE_BYTES = 5 * 1024 * 1024;
/** aidm-ui.log.1 to aidm-ui.log.3 are kept; the oldest goes. */
export const DIAGNOSIS_LOG_KEPT_FILES = 3;
/** How much of a tool's output a line quotes when a check fails. */
export const EXCERPT_CHARACTERS = 300;
/** A shorter secret would hide ordinary words, so it is left alone. */
const MIN_SECRET_LENGTH = 8;

export interface DiagnosisLogOptions {
  dataFolder: string;
  /** Where each line also goes: the terminal. */
  terminal: (line: string) => void;
  /** Engine tokens, asked for each line: none may reach the log, even by mistake. */
  secrets?: () => string[];
  now?: () => number;
  rotateBytes?: number;
  keptFiles?: number;
}

/** The first part of a tool's output on one line, for a line about a check that failed. */
export function excerpt(text: string, characters = EXCERPT_CHARACTERS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat === "") return "(no output)";
  return flat.length <= characters ? flat : `${flat.slice(0, characters)}...`;
}

/** Seconds with one decimal, for a duration in a line. */
export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

/**
 * The readable log for diagnosis: every line goes to the terminal and to a
 * rotated file in the data folder, each with the time. The interface never
 * shows it; it keeps its own plain messages. A file that cannot be written
 * leaves the terminal working.
 */
export function openDiagnosisLog(options: DiagnosisLogOptions): (line: string) => void {
  const now = options.now ?? Date.now;
  const rotateBytes = options.rotateBytes ?? DIAGNOSIS_LOG_ROTATE_BYTES;
  const keptFiles = options.keptFiles ?? DIAGNOSIS_LOG_KEPT_FILES;
  const folder = join(options.dataFolder, "logs");
  const file = join(folder, DIAGNOSIS_LOG_FILE);
  let size = 0;
  let writable = true;
  try {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    size = existsSync(file) ? statSync(file).size : 0;
  } catch {
    writable = false;
  }

  const rotate = () => {
    rmSync(`${file}.${keptFiles}`, { force: true });
    for (let n = keptFiles - 1; n >= 1; n--) {
      if (existsSync(`${file}.${n}`)) renameSync(`${file}.${n}`, `${file}.${n + 1}`);
    }
    if (existsSync(file)) renameSync(file, `${file}.1`);
    size = 0;
  };

  // The last secrets that could be read, for a line logged after the database closed.
  let known: string[] = [];
  const redact = (line: string): string => {
    try {
      known = options.secrets?.() ?? [];
    } catch {
      // Keep the ones read before.
    }
    return known
      .filter((secret) => secret.length >= MIN_SECRET_LENGTH)
      .sort((a, b) => b.length - a.length)
      .reduce((kept, secret) => kept.split(secret).join("***"), line);
  };

  return (line) => {
    const text = `${new Date(now()).toISOString()} ${redact(line)}`;
    options.terminal(text);
    if (!writable) return;
    try {
      const bytes = Buffer.byteLength(text) + 1;
      if (size > 0 && size + bytes > rotateBytes) rotate();
      appendFileSync(file, `${text}\n`, { mode: 0o600 });
      size += bytes;
    } catch {
      // A full disk must not stop the server; the terminal still has the line.
      writable = false;
    }
  };
}
