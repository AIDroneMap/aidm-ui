import { readFileSync } from "node:fs";
import { systemRunner, type CommandRunner } from "../process/command-runner.ts";

// This file is the part of AIDM UI that runs as the administrator, through the
// desktop's approval prompt. It does two things and nothing else: it installs
// Podman and it gives the operator's user name a range of subordinate IDs.
// It receives a user name and nothing more. It never opens anything of the
// operator's, and it writes no file of its own.

/** The only files the setup command reads. */
export const OS_RELEASE_FILE = "/etc/os-release";
export const SUBUID_FILE = "/etc/subuid";
export const SUBGID_FILE = "/etc/subgid";
/** Read for the numeric ID of the user, because the ID range files may name a user by name or by number. */
export const PASSWD_FILE = "/etc/passwd";

/** What the command exits with. 126 and 127 are left to pkexec, which uses them for a dismissed prompt and a refusal. */
export const SETUP_EXIT = {
  done: 0,
  badArguments: 2,
  unsupportedDistribution: 3,
  packageManagerFailed: 4,
  usermodFailed: 5,
} as const;

/** The files of the computer the setup command may read, so that a test can say what it read. */
export interface SystemFiles {
  /** The text of the file, or null when it cannot be read. */
  readFile(path: string): string | null;
}

export function systemFiles(): SystemFiles {
  return {
    readFile(path) {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
  };
}

// The distribution ---------------------------------------------------------

export interface OsRelease {
  id: string;
  idLike: string[];
}

function unquote(value: string): string {
  const trimmed = value.trim();
  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed.length >= 2 && trimmed.endsWith(quote)) return trimmed.slice(1, -1);
  return trimmed;
}

/** The ID and ID_LIKE of an os-release file. A missing ID is "linux", as the file's manual says. */
export function parseOsRelease(text: string): OsRelease {
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const equals = trimmed.indexOf("=");
    if (equals === -1) continue;
    values.set(trimmed.slice(0, equals).trim(), unquote(trimmed.slice(equals + 1)));
  }
  const id = (values.get("ID") ?? "").toLowerCase();
  const like = (values.get("ID_LIKE") ?? "").toLowerCase();
  return { id: id === "" ? "linux" : id, idLike: like.split(/\s+/).filter((word) => word !== "") };
}

export type PackageManager = "apt" | "dnf" | "zypper" | "pacman";

function managerOf(id: string): PackageManager | null {
  if (id === "debian" || id === "ubuntu") return "apt";
  if (id === "fedora" || id === "rhel") return "dnf";
  if (id === "suse" || id === "sles" || id === "sled" || id.startsWith("opensuse")) return "zypper";
  if (id === "arch") return "pacman";
  return null;
}

/** The package manager for the distribution: its own ID first, then the ones it says it is like, in order. */
export function packageManagerFor(release: OsRelease): PackageManager | null {
  for (const id of [release.id, ...release.idLike]) {
    const manager = managerOf(id);
    if (manager !== null) return manager;
  }
  return null;
}

export type Distribution = { supported: true; id: string; manager: PackageManager } | { supported: false; id: string };

const MAX_DISTRIBUTION_ID = 64;

/**
 * The ID as it may leave this program: at most 64 characters, each one a
 * lowercase letter, a digit, a dot, an underscore or a hyphen. The file is the
 * computer's own, but the ID goes to the browser, so it is cleaned first.
 */
export function safeDistributionId(id: string): string {
  return id.slice(0, MAX_DISTRIBUTION_ID).replace(/[^a-z0-9._-]/g, "_");
}

/** Reads the one file that names the distribution. An unreadable file is an unsupported "unknown". */
export function readDistribution(files: SystemFiles): Distribution {
  const text = files.readFile(OS_RELEASE_FILE);
  if (text === null) return { supported: false, id: "unknown" };
  const release = parseOsRelease(text);
  const manager = packageManagerFor(release);
  const id = safeDistributionId(release.id);
  return manager === null ? { supported: false, id } : { supported: true, id, manager };
}

export interface PlannedCommand {
  argv: string[];
  /** Added to the fixed environment of the setup command. */
  env?: Record<string, string>;
  /** A failure of this step is not the end: the install after it decides. */
  optional?: boolean;
}

const NON_INTERACTIVE = { DEBIAN_FRONTEND: "noninteractive" };

/** The commands that install Podman, in order. */
export function installCommands(manager: PackageManager): PlannedCommand[] {
  switch (manager) {
    case "apt":
      return [
        // One repository that is down makes the update fail, and the install can still work from the index it has.
        { argv: ["apt-get", "update"], env: NON_INTERACTIVE, optional: true },
        { argv: ["apt-get", "install", "-y", "podman"], env: NON_INTERACTIVE },
      ];
    case "dnf":
      return [{ argv: ["dnf", "install", "-y", "podman"] }];
    case "zypper":
      return [{ argv: ["zypper", "--non-interactive", "install", "podman"] }];
    case "pacman":
      return [{ argv: ["pacman", "-S", "--noconfirm", "--needed", "podman"] }];
  }
}

// The user and the ID ranges -----------------------------------------------

/**
 * Letters, digits, dot, underscore and hyphen, as POSIX allows, and no hyphen first so it cannot pass for an option.
 * The user name is checked three times on purpose, once in the command line
 * reader, once in the server before it asks for approval, and once here
 * before anything runs, because this program runs with administrator rights and
 * must not trust that an earlier check happened.
 */
export function isValidUserName(name: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9._-]{0,31}$/.test(name);
}

export interface SubIdRange {
  first: number;
  last: number;
}

/** What rootless Podman needs for one user. */
const RANGE_SIZE = 65536;
const RANGE_START = 100000;
/** The largest ID the kernel accepts, less one. */
const LAST_ID = 4294967294;

interface SubIdLine {
  name: string;
  first: number;
  count: number;
}

function subIdLines(text: string | null): SubIdLine[] {
  const lines: SubIdLine[] = [];
  for (const line of (text ?? "").split("\n")) {
    const parts = line.trim().split(":");
    if (parts.length !== 3 || parts[0] === "" || !/^\d+$/.test(parts[1] ?? "") || !/^\d+$/.test(parts[2] ?? "")) continue;
    lines.push({ name: parts[0] as string, first: Number(parts[1]), count: Number(parts[2]) });
  }
  return lines;
}

/**
 * True when the file has a line of at least 65536 IDs for one of these names.
 * The files name a user either by name or by number, so the caller gives both.
 */
export function hasSubIds(text: string | null, names: string[]): boolean {
  return subIdLines(text).some((line) => names.includes(line.name) && line.count >= RANGE_SIZE);
}

/** The numeric ID of the user in the text of a passwd file, or null when the user has no line. */
export function userIdOf(passwd: string | null, user: string): string | null {
  for (const line of (passwd ?? "").split("\n")) {
    const parts = line.split(":");
    if (parts[0] === user && /^\d+$/.test(parts[2] ?? "")) return parts[2] as string;
  }
  return null;
}

/**
 * A range of 65536 IDs that no line of the files uses: it starts at 100000, or
 * just after the highest range in use. Null when the IDs have run out.
 */
export function chooseSubIdRange(files: Array<string | null>): SubIdRange | null {
  let first = RANGE_START;
  for (const text of files) {
    for (const line of subIdLines(text)) first = Math.max(first, line.first + line.count);
  }
  const last = first + RANGE_SIZE - 1;
  return last > LAST_ID ? null : { first, last };
}

// The command --------------------------------------------------------------

export interface SetupCommandDeps {
  user: string;
  files: SystemFiles;
  runner: CommandRunner;
  /** One line per step, for the terminal or the log of whoever started the command. */
  print: (line: string) => void;
}

/** A package manager may run for a long time on a slow connection. */
const STEP_TIMEOUT_MS = 30 * 60_000;

/**
 * Where the package managers are looked for, and the only environment they get.
 * Nothing is taken from the environment this program was started with. The
 * desktop's approval prompt cleans it, but this must also be safe if the
 * command is run through sudo, which can pass much of it on.
 */
export const SAFE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const SAFE_ENV = { PATH: SAFE_PATH, LANG: "C" };

function lastLine(text: string): string {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  return (lines[lines.length - 1] ?? "").trim().slice(0, 200);
}

/** Runs the setup. Returns the exit code. */
export async function runPodmanSetup(deps: SetupCommandDeps): Promise<number> {
  const { user, files, runner, print } = deps;
  // Checked again here on purpose: see isValidUserName.
  if (!isValidUserName(user)) {
    print("The user name has characters that are not allowed.");
    return SETUP_EXIT.badArguments;
  }

  // Decided before anything runs, so an unsupported computer is left as it was.
  const distribution = readDistribution(files);
  if (!distribution.supported) {
    print(`Podman cannot be installed on this distribution (${distribution.id}).`);
    return SETUP_EXIT.unsupportedDistribution;
  }

  print(`Installing Podman with ${distribution.manager}.`);
  for (const command of installCommands(distribution.manager)) {
    const result = await runner.run(command.argv, {
      timeoutMs: STEP_TIMEOUT_MS,
      env: { ...SAFE_ENV, ...command.env },
      inheritEnv: false,
    });
    if (result.exitCode !== 0 && command.optional !== true) {
      print(`Installing Podman failed (${command.argv[0]} exited with ${result.exitCode}). ${lastLine(result.stderr)}`.trim());
      return SETUP_EXIT.packageManagerFailed;
    }
  }
  print("Podman is installed.");

  // Read after the install, because installing the tools can create the files.
  const subuid = files.readFile(SUBUID_FILE);
  const subgid = files.readFile(SUBGID_FILE);
  const uid = userIdOf(files.readFile(PASSWD_FILE), user);
  const names = uid === null ? [user] : [user, uid];
  const missingUid = !hasSubIds(subuid, names);
  const missingGid = !hasSubIds(subgid, names);
  if (!missingUid && !missingGid) {
    print(`${user} already has a range of IDs for containers.`);
    return SETUP_EXIT.done;
  }

  const range = chooseSubIdRange([subuid, subgid]);
  if (range === null) {
    print("There is no free range of IDs left for containers.");
    return SETUP_EXIT.usermodFailed;
  }
  const text = `${range.first}-${range.last}`;
  const argv = ["usermod"];
  if (missingUid) argv.push("--add-subuids", text);
  if (missingGid) argv.push("--add-subgids", text);
  argv.push(user);
  print(`Adding a range of IDs for containers to ${user}.`);
  const result = await runner.run(argv, { timeoutMs: STEP_TIMEOUT_MS, env: SAFE_ENV, inheritEnv: false });
  if (result.exitCode !== 0) {
    print(`Adding the range of IDs failed (usermod exited with ${result.exitCode}). ${lastLine(result.stderr)}`.trim());
    return SETUP_EXIT.usermodFailed;
  }
  print("Done.");
  return SETUP_EXIT.done;
}

/** The setup as the real command: real files, real programs, lines on standard output. */
export function runSetupFromCommandLine(user: string): Promise<number> {
  return runPodmanSetup({ user, files: systemFiles(), runner: systemRunner(), print: (line) => console.log(line) });
}
