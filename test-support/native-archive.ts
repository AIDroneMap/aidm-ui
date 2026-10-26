// A native engine package for tests: a tar.gz with the layout of the real
// archives (one folder holding the executable `aidm-api`), whose executable
// starts the fake native engine, and the manifest entry that names it.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import type { VariantId } from "../shared/api-types.ts";
import type { Manifest } from "../server/manifest/schema.ts";
import { systemRunner, type CommandRunner } from "../server/process/command-runner.ts";
import { recorded } from "./scripted-runner.ts";
import { sampleManifest } from "./signed-manifest.ts";

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

/** An archive whose executable runs the fake engine, which reports `reports` (default: the package version). */
export async function buildNativeArchive(options: {
  version: string;
  reports?: string;
  silent?: boolean;
  /** A package that holds no program. */
  omitExecutable?: boolean;
}): Promise<TestArchive> {
  const platform = "linux-x64";
  const folder = `aidm-api-${options.version}-${platform}`;
  const work = mkdtempSync(join(os.tmpdir(), "aidm-ui-archive-"));
  try {
    mkdirSync(join(work, folder, "engine"), { recursive: true });
    writeFileSync(join(work, folder, "engine", "README"), "A stand-in for the engine.\n");
    const script = [
      "#!/bin/sh",
      `AIDM_FAKE_VERSION=${quoted(options.reports ?? options.version)} AIDM_FAKE_SILENT=${options.silent ? "1" : "0"} exec ${quoted(process.execPath)} ${quoted(FAKE_ENGINE)} "$@"`,
      "",
    ].join("\n");
    const executable = join(work, folder, "aidm-api");
    if (options.omitExecutable !== true) {
      writeFileSync(executable, script);
      chmodSync(executable, 0o755);
    }

    const name = `${folder}.tar.gz`;
    const made = Bun.spawnSync(["tar", "-czf", join(work, name), "-C", work, folder]);
    if (made.exitCode !== 0) throw new Error(`tar failed: ${made.stderr.toString()}`);
    const bytes = new Uint8Array(await Bun.file(join(work, name)).arrayBuffer());
    const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    return { version: options.version, name, bytes, sha256, path: `/releases/download/v${options.version}/${name}` };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Where the archive is said to be, in a manifest. The fetch of the test sends this host to the fake file server. */
export const ARCHIVE_HOST = "https://releases.example.test";

/** A manifest whose entry for the variant (by default linux-amd64-cpu) is the native archive. */
export function nativeRelease(
  archive: TestArchive,
  sequence: number,
  overrides: Partial<Manifest> = {},
  variant: VariantId = "linux-amd64-cpu",
): Manifest {
  return sampleManifest({
    sequence,
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
 * The real programs, except that systemctl answers from a recording: with
 * systemd it is the recorded output of `systemctl --user show-environment`,
 * without it the program is not found (exit 127).
 */
export function runnerWithSystemd(present: boolean, real: CommandRunner = systemRunner()): CommandRunner {
  const isSystemctl = (argv: string[]) => argv[0] === "systemctl";
  const answer = () => (present ? recorded("systemd", "show-environment") : { exitCode: 127, stdout: "", stderr: "not found" });
  return {
    run: (argv, options) => (isSystemctl(argv) ? Promise.resolve(answer()) : real.run(argv, options)),
    stream: (argv, options) => (isSystemctl(argv) ? Promise.resolve(answer()) : real.stream(argv, options)),
  };
}
