// A native engine package for tests: a tar.gz with the layout of the real
// archives (one folder holding the executable `aidm-api`), whose executable
// starts the fake native engine, and the manifest entry that names it.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import type { VariantId } from "../shared/api-types.ts";
import type { Manifest } from "../server/manifest/schema.ts";
import { systemRunner, type CommandRunner } from "../server/process/command-runner.ts";
import { recorded } from "./scripted-runner.ts";
import { BUILTIN_SEQUENCE, sampleManifest } from "./signed-manifest.ts";

const FAKE_ENGINE = join(import.meta.dir, "fake-native-engine.ts");

export interface TestArchive {
  version: string;
  /** The file name, as the release has it. */
  name: string;
  bytes: Uint8Array;
  sha256: string;
  /** Where the fake file server should serve it. */
  path: string;
}

function quoted(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/** What the program of a package does, beyond answering like a task API. */
export interface FakeProgramOptions {
  /** The version it reports. */
  reports: string;
  /** Runs without listening on anything, like an engine that never gets ready. */
  silent?: boolean;
  /** Ignores SIGTERM, so that only SIGKILL ends it. */
  ignoreTerm?: boolean;
  /** Prints this many lines of output, in bursts, after it starts. */
  noiseLines?: number;
  /** Answers the info route without a version, so that it never counts as ready. */
  badInfo?: boolean;
}

/** A shell script that starts the fake native engine with the given behaviour and the arguments it was given. */
export function fakeProgramScript(options: FakeProgramOptions): string {
  return [
    "#!/bin/sh",
    `AIDM_FAKE_VERSION=${quoted(options.reports)} AIDM_FAKE_SILENT=${options.silent ? "1" : "0"} AIDM_FAKE_IGNORE_TERM=${options.ignoreTerm ? "1" : "0"} AIDM_FAKE_NOISE_LINES=${options.noiseLines ?? 0} AIDM_FAKE_BAD_INFO=${options.badInfo ? "1" : "0"} exec ${quoted(process.execPath)} ${quoted(FAKE_ENGINE)} "$@"`,
    "",
  ].join("\n");
}

/** An archive whose executable runs the fake engine, which reports `reports` (default: the package version). */
export async function buildNativeArchive(options: {
  version: string;
  reports?: string;
  silent?: boolean;
  ignoreTerm?: boolean;
  noiseLines?: number;
  badInfo?: boolean;
  /** A package that holds no program. */
  omitExecutable?: boolean;
}): Promise<TestArchive> {
  const platform = "linux-x64";
  const folder = `aidm-api-${options.version}-${platform}`;
  const work = mkdtempSync(join(os.tmpdir(), "aidm-ui-archive-"));
  try {
    mkdirSync(join(work, folder, "engine"), { recursive: true });
    writeFileSync(join(work, folder, "engine", "README"), "A stand-in for the engine.\n");
    const executable = join(work, folder, "aidm-api");
    if (options.omitExecutable !== true) {
      writeFileSync(executable, fakeProgramScript({ ...options, reports: options.reports ?? options.version }));
      chmodSync(executable, 0o755);
    }
    return await packFolder(work, folder, options.version);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function packFolder(work: string, folder: string, version: string, tarArguments: string[] = []): Promise<TestArchive> {
  const name = `${folder}.tar.gz`;
  const made = Bun.spawnSync(["tar", "-czf", join(work, name), ...tarArguments, "-C", work, folder]);
  if (made.exitCode !== 0) throw new Error(`tar failed: ${made.stderr.toString()}`);
  const bytes = new Uint8Array(await Bun.file(join(work, name)).arrayBuffer());
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  return { version, name, bytes, sha256, path: `/releases/download/v${version}/${name}` };
}

/** The ways an archive can try to harm the computer that unpacks it. */
export type Hostility =
  /** An entry with an absolute path. */
  | { kind: "absolute_path"; target: string }
  /** An entry that climbs out of the folder with "..". */
  | { kind: "parent_path" }
  /** A link to a place outside the folder; `target` is where the link points. */
  | { kind: "link_outside"; target: string }
  /** The program is a link to a file in the package. */
  | { kind: "program_is_link" }
  /** A file that unpacks to far more than the archive's size. */
  | { kind: "size_bomb"; bytes: number };

/** An archive made with tar to do one hostile thing, and otherwise a good package. */
export async function buildHostileArchive(version: string, hostility: Hostility): Promise<TestArchive> {
  const folder = `aidm-api-${version}-linux-x64`;
  const work = mkdtempSync(join(os.tmpdir(), "aidm-ui-hostile-"));
  try {
    mkdirSync(join(work, folder, "engine"), { recursive: true });
    writeFileSync(join(work, folder, "engine", "README"), "A stand-in for the engine.\n");
    const script = join(work, folder, "aidm-api");
    const program = fakeProgramScript({ reports: version });
    if (hostility.kind === "program_is_link") {
      writeFileSync(join(work, folder, "engine", "program"), program);
      chmodSync(join(work, folder, "engine", "program"), 0o755);
      symlinkSync(join("engine", "program"), script);
    } else {
      writeFileSync(script, program);
      chmodSync(script, 0o755);
    }
    // -P keeps a leading "/" and "../" in the names that --transform makes.
    const tarArguments: string[] = [];
    if (hostility.kind === "absolute_path") tarArguments.push("-P", `--transform=s,^,${hostility.target}/,`);
    if (hostility.kind === "parent_path") tarArguments.push("-P", "--transform=s,^,../,");
    if (hostility.kind === "link_outside") symlinkSync(hostility.target, join(work, folder, "engine", "link"));
    if (hostility.kind === "size_bomb") writeFileSync(join(work, folder, "engine", "zeros"), new Uint8Array(hostility.bytes));
    return await packFolder(work, folder, version, tarArguments);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Where the archive is said to be, in a manifest. The fetch of the test sends this host to the fake file server. */
export const ARCHIVE_HOST = "https://releases.example.test";

/** A synthetic manifest after the built-in sequence, with the native archive for the variant. */
export function nativeRelease(
  archive: TestArchive,
  sequenceOffset: number,
  overrides: Partial<Manifest> = {},
  variant: VariantId = "linux-amd64-cpu",
): Manifest {
  return sampleManifest({
    sequence: BUILTIN_SEQUENCE + sequenceOffset,
    packageVersion: archive.version,
    variants: {
      [variant]: {
        kind: "native",
        url: `${ARCHIVE_HOST}${archive.path}`,
        size: archive.bytes.length,
        sha256: archive.sha256,
        gpu: false,
      },
    },
    ...overrides,
  });
}

/** A fetch that sends the archive host of the manifest to a fake file server, and every other address where it points. */
export function archiveFetch(serverUrl: (path: string) => string): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return fetch(url.startsWith(ARCHIVE_HOST) ? serverUrl(url.slice(ARCHIVE_HOST.length)) : url, init);
  }) as typeof fetch;
}

/**
 * The real programs, except that systemd answers from recordings. With systemd
 * present, `systemctl --user show-environment` gives its recorded output, and
 * the trial scope of `systemd-run` works or, when `scope` is false, fails
 * the way it does without a user bus. Without systemd neither program is found
 * (exit 127). `calls` collects every systemd command with its options.
 */
export function runnerWithSystemd(
  present: boolean,
  options: { scope?: boolean; real?: CommandRunner; calls?: Array<{ argv: string[]; timeoutMs: number | undefined }> } = {},
): CommandRunner {
  const real = options.real ?? systemRunner();
  const isSystemd = (argv: string[]) => argv[0] === "systemctl" || argv[0] === "systemd-run";
  const answer = (argv: string[]) => {
    if (!present) return { exitCode: 127, stdout: "", stderr: "not found" };
    if (argv[0] === "systemctl") return recorded("systemd", "show-environment");
    return recorded("systemd", options.scope === false ? "run-scope-no-bus" : "run-scope");
  };
  return {
    run: (argv, runOptions) => {
      if (!isSystemd(argv)) return real.run(argv, runOptions);
      options.calls?.push({ argv, timeoutMs: runOptions?.timeoutMs });
      return Promise.resolve(answer(argv));
    },
    stream: (argv, streamOptions) => (isSystemd(argv) ? Promise.resolve(answer(argv)) : real.stream(argv, streamOptions)),
  };
}
