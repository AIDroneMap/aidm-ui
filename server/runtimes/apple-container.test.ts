import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedRunner, recorded, recordedText, type ScriptedRule } from "../../test-support/scripted-runner.ts";
import { localName, type DownloadedImage } from "../images/image-download.ts";
import { appleContainerRuntime, runArgv } from "./apple-container.ts";
import type { ContainerSpec } from "./runtime.ts";

const IMAGE = "ghcr.io/aidronemap/aidm-api@sha256:107b6ef1049699b3bdcc055b4ecc704eaf0a9380202294a944e9eeff6c44e7fd";
const NAME = "aidm-engine";
const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
/** What the engine manager would give on a computer with 32 GiB and 8 cores. */
const DEFAULTS = { memoryBytes: 25 * GIB, cpus: 8 };

/** Spelled out here on purpose: the tool is always called by this path (section C of the runtime facts). */
const TOOL = "/usr/local/bin/container";

function spec(patch: Partial<ContainerSpec> = {}): ContainerSpec {
  return {
    name: NAME,
    image: IMAGE,
    platform: null,
    publish: { hostAddress: "127.0.0.1", hostPort: 41823, containerPort: 3000 },
    mounts: [
      { hostPath: "/Users/operator/engine-data", containerPath: "/var/www/data", readOnly: false },
      { hostPath: "/Users/operator/aidm-ui/engine-config/container", containerPath: "/etc/aidm-ui", readOnly: true },
    ],
    memoryBytes: 8 * GIB,
    cpus: 4,
    gpu: false,
    args: ["--config", "/etc/aidm-ui/task-api.json"],
    ...patch,
  };
}

const rec = (name: string) => recorded("apple-container", name);

const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
const scratch = mkdtempSync(join(tmpdir(), "aidm-ui-apple-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const digestOf = (bytes: Uint8Array) => `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;

/** A small image really on disk, as the downloader leaves it: blobs whose contents hash to their digests, `oci-layout` and `index.json`. */
function tinyImage(): DownloadedImage {
  const folder = mkdtempSync(join(scratch, "image-"));
  mkdirSync(join(folder, "blobs", "sha256"), { recursive: true });
  const put = (bytes: Uint8Array) => {
    const digest = digestOf(bytes);
    writeFileSync(join(folder, "blobs", "sha256", digest.slice(7)), bytes);
    return { digest, size: bytes.length };
  };
  const config = put(new TextEncoder().encode('{"architecture":"arm64","os":"linux"}\n'));
  // Not a multiple of 512, so the archive has to pad it.
  const layer = put(new Uint8Array(1000).map((_, index) => index % 251));
  const manifest = put(
    new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: OCI_MANIFEST,
        config: { mediaType: "application/vnd.oci.image.config.v1+json", ...config },
        layers: [{ mediaType: "application/vnd.oci.image.layer.v1.tar", ...layer }],
      }),
    ),
  );
  const pinned = { repository: "ghcr.io/aidm-ui-loadtest/tiny", digest: manifest.digest };
  const name = localName(pinned);
  writeFileSync(join(folder, "oci-layout"), '{"imageLayoutVersion":"1.0.0"}\n');
  writeFileSync(
    join(folder, "index.json"),
    JSON.stringify({
      schemaVersion: 2,
      manifests: [{ mediaType: OCI_MANIFEST, ...manifest, annotations: { "io.containerd.image.name": name } }],
    }),
  );
  return { pinned, folder, name, manifest: { ...manifest, mediaType: OCI_MANIFEST }, config, layers: [layer] };
}

const tiny = tinyImage();

/** The entries of a tar, by the 512-byte headers: name and bytes. */
function tarEntries(bytes: Uint8Array): Array<{ name: string; body: Uint8Array }> {
  const entries: Array<{ name: string; body: Uint8Array }> = [];
  for (let at = 0; at + 512 <= bytes.length; ) {
    const header = bytes.subarray(at, at + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = new TextDecoder().decode(header.subarray(0, header.indexOf(0)));
    const size = Number.parseInt(new TextDecoder().decode(header.subarray(124, 135)), 8);
    at += 512;
    entries.push({ name, body: bytes.subarray(at, at + size) });
    at += Math.ceil(size / 512) * 512;
  }
  return entries;
}

const argv = {
  run: runArgv(spec(), DEFAULTS),
  load: [TOOL, "image", "load"],
  imageInspect: [TOOL, "image", "inspect", tiny.name],
  inspect: [TOOL, "inspect", NAME],
  stop: [TOOL, "stop", NAME],
  delete: [TOOL, "delete", "--force", NAME],
  imageDelete: [TOOL, "image", "delete", IMAGE],
  logs: [TOOL, "logs", NAME],
  version: [TOOL, "--version"],
  status: [TOOL, "system", "status", "--format", "json"],
};

function make(rules: ScriptedRule[]) {
  const runner = new ScriptedRunner(rules);
  return { runner, runtime: appleContainerRuntime(runner, { defaults: () => DEFAULTS }) };
}

describe("the command line that starts the container", () => {
  test("it carries the tool's path, the fixed name, the memory and CPU caps, the loopback publish, the bind mounts and the arguments after the image", () => {
    expect(runArgv(spec(), DEFAULTS)).toEqual([
      TOOL, "run", "-d", "--name", NAME,
      "--memory", "8192M", "--cpus", "4",
      "-p", "127.0.0.1:41823:3000",
      "-v", "/Users/operator/engine-data:/var/www/data",
      "-v", "/Users/operator/aidm-ui/engine-config/container:/etc/aidm-ui:ro",
      IMAGE, "--config", "/etc/aidm-ui/task-api.json",
    ]);
  });

  test("a spec without caps still sends both, filled from the defaults, because the tool's own VM gets 1 GiB", () => {
    const line = runArgv(spec({ memoryBytes: null, cpus: null }), DEFAULTS);
    expect(line[line.indexOf("--memory") + 1]).toBe(`${(25 * GIB) / MIB}M`);
    expect(line[line.indexOf("--cpus") + 1]).toBe("8");
  });

  test("the memory is whole MiB, rounded up", () => {
    const line = runArgv(spec({ memoryBytes: 3 * GIB + 1 }), DEFAULTS);
    expect(line[line.indexOf("--memory") + 1]).toBe("3073M");
  });

  test("there is no restart flag, no pull flag, and the publish is on loopback once", () => {
    const line = runArgv(spec({ gpu: true }), DEFAULTS);
    expect(line.some((part) => part.startsWith("--restart") || part === "--pull=never")).toBe(false);
    expect(line.filter((part) => part === "-p")).toEqual(["-p"]);
    expect(line[line.indexOf("-p") + 1]?.startsWith("127.0.0.1:")).toBe(true);
  });

  test("every mount is a -v, and a read-only one ends in :ro", () => {
    const line = runArgv(
      spec({
        mounts: [
          { hostPath: "/a", containerPath: "/x", readOnly: false },
          { hostPath: "/b", containerPath: "/y", readOnly: true },
        ],
      }),
      DEFAULTS,
    );
    expect(line.filter((part) => part === "-v")).toHaveLength(2);
    expect(line).toContain("/a:/x");
    expect(line).toContain("/b:/y:ro");
  });

  // The flags the tool lists for run name no platform: the image aidm-ui loaded is the arm64 one, and run uses it.
  test("run has no platform flag, even when the spec names a platform", () => {
    expect(runArgv(spec(), DEFAULTS)).not.toContain("--platform");
    expect(runArgv(spec({ platform: "linux/arm64/v8" }), DEFAULTS)).not.toContain("--platform");
  });
});

describe("detect", () => {
  const versionRule = (): ScriptedRule => ({ argv: argv.version, result: rec("cli-version") });
  const statusRule = (name: string): ScriptedRule => ({ argv: argv.status, result: rec(name) });

  test("the tool is asked by its path with --version first, and then for the state of its service", async () => {
    const { runtime, runner } = make([versionRule(), statusRule("system-status-running")]);
    expect(await runtime.detect()).toEqual({
      id: "apple-container",
      available: true,
      version: "1.6.1",
      memoryCapEnforced: true,
      cpuCapEnforced: true,
      storagePath: null,
      problem: null,
    });
    expect(runner.calls).toEqual([argv.version, argv.status]);
  });

  // The status output is reconstructed from the tool's source, not captured, so the answer leans on --version.
  test("a tool that answers --version while its service is not running is apple_not_started, with its version", async () => {
    for (const status of ["system-status-not-running", "system-status-unregistered"]) {
      const { runtime } = make([versionRule(), statusRule(status)]);
      const found = await runtime.detect();
      expect(found.available, status).toBe(false);
      expect(found.version, status).toBe("1.6.1");
      expect(found.problem, status).toEqual({ code: "runtime.apple_not_started", data: {} });
    }
  });

  test("a status the code cannot read, from a tool that answered --version, is still apple_not_started and never unusable", async () => {
    for (const result of [
      { exitCode: 1, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "something new\n", stderr: "" },
      { exitCode: 124, stdout: "", stderr: "" },
    ]) {
      const { runtime } = make([versionRule(), { argv: argv.status, result }]);
      expect((await runtime.detect()).problem).toEqual({ code: "runtime.apple_not_started", data: {} });
    }
  });

  test("no tool at the path is runtime.not_installed, and no status is asked", async () => {
    const { runtime, runner } = make([]);
    expect((await runtime.detect()).problem).toEqual({ code: "runtime.not_installed", data: { runtime: "apple-container" } });
    expect(runner.calls).toEqual([argv.version]);
  });

  test("a file that does not run, or prints something other than the version line, is runtime.unusable", async () => {
    for (const result of [
      { exitCode: 126, stdout: "", stderr: "permission denied" },
      { exitCode: 0, stdout: "hello\n", stderr: "" },
      { exitCode: 1, stdout: "container CLI version 1.6.1 (build: release, commit: 804209b)\n", stderr: "" },
    ]) {
      const { runtime } = make([{ argv: argv.version, result }]);
      expect((await runtime.detect()).problem, JSON.stringify(result)).toEqual({ code: "runtime.unusable", data: { runtime: "apple-container" } });
    }
  });

  test("a container tool elsewhere on the search path is never run", async () => {
    const { runtime, runner } = make([
      { argv: ["container", "--version"], result: rec("cli-version") },
      { argv: ["container", "system", "status", "--format", "json"], result: rec("system-status-running") },
      { argv: ["container", "image", "load"], result: { exitCode: 0, stdout: "", stderr: "" } },
      { argv: ["container", "image", "inspect", tiny.name], result: { exitCode: 0, stdout: "[]", stderr: "" } },
      { argv: ["container", "inspect", NAME], result: rec("inspect-running") },
    ]);
    expect((await runtime.detect()).problem?.code).toBe("runtime.not_installed");
    expect((await runtime.load(tiny)).ok).toBe(false);
    expect((await runtime.verifyImage(tiny)).ok).toBe(false);
    expect((await runtime.status(NAME)).ok).toBe(false);
    await runtime.start(spec());
    await runtime.stop(NAME);
    await runtime.remove(NAME);
    await runtime.removeImage(IMAGE);
    await runtime.logs(NAME, { follow: false, onLine: () => {} });
    expect(runner.calls.length).toBeGreaterThan(0);
    expect(runner.calls.every((call) => call[0] === TOOL)).toBe(true);
  });
});

describe("start", () => {
  test("it runs the recorded command and gives the ID the tool prints", async () => {
    const { runtime, runner } = make([{ argv: argv.run, result: rec("run") }]);
    expect(await runtime.start(spec())).toEqual({ ok: true, value: { containerId: "aidm-engine" } });
    expect(runner.calls).toEqual([argv.run]);
  });

  test("a name that is in use gives runtime.name_in_use and leaves that container alone", async () => {
    const { runtime, runner } = make([{ argv: argv.run, result: rec("run-name-in-use") }]);
    expect(await runtime.start(spec())).toEqual({ ok: false, error: { code: "runtime.name_in_use", data: { name: NAME } } });
    expect(runner.calls).not.toContainEqual(argv.delete);
  });

  // A failed run says nothing that shows it made the container, so start never deletes one it cannot be sure it made.
  test("a port that is in use gives runtime.port_in_use and deletes nothing", async () => {
    const { runtime, runner } = make([{ argv: argv.run, result: rec("run-port-in-use") }]);
    expect(await runtime.start(spec())).toEqual({ ok: false, error: { code: "runtime.port_in_use", data: { port: 41823 } } });
    expect(runner.calls.some((call) => call.includes("delete"))).toBe(false);
  });

  test("an image that is not stored gives runtime.image_not_found", async () => {
    const { runtime, runner } = make([{ argv: argv.run, result: rec("run-image-not-found") }]);
    expect(await runtime.start(spec())).toEqual({ ok: false, error: { code: "runtime.image_not_found", data: {} } });
    expect(runner.calls.some((call) => call.includes("delete"))).toBe(false);
  });

  // The text is made up for the test: only the shape matters, a not-found error that is not about the image.
  test("a missing kernel is not a missing image: it gives runtime.start_failed with the exit code", async () => {
    const { runtime, runner } = make([
      { argv: argv.run, result: { exitCode: 1, stdout: "", stderr: 'Error: notFound: "default kernel not found"\n' } },
    ]);
    expect(await runtime.start(spec())).toEqual({ ok: false, error: { code: "runtime.start_failed", data: { exitCode: 1 } } });
    expect(runner.calls.some((call) => call.includes("delete"))).toBe(false);
  });

  test("an access error that does not name the image is runtime.start_failed too", async () => {
    const { runtime } = make([
      { argv: argv.run, result: { exitCode: 1, stdout: "", stderr: 'Error: internalError: "permission denied on the mounted folder"\n' } },
    ]);
    expect(await runtime.start(spec())).toEqual({ ok: false, error: { code: "runtime.start_failed", data: { exitCode: 1 } } });
  });

  test("a system service that is off gives runtime.apple_not_started", async () => {
    const { runtime } = make([{ argv: argv.run, result: rec("run-service-down") }]);
    expect(await runtime.start(spec())).toEqual({ ok: false, error: { code: "runtime.apple_not_started", data: {} } });
  });

  test("any other failure gives runtime.start_failed with the exit code and deletes nothing", async () => {
    const { runtime, runner } = make([{ argv: argv.run, result: { exitCode: 3, stdout: "", stderr: "Error: something odd\n" } }]);
    expect(await runtime.start(spec())).toEqual({ ok: false, error: { code: "runtime.start_failed", data: { exitCode: 3 } } });
    expect(runner.calls).toEqual([argv.run]);
  });

  // Exit 0 means the tool made the container in this call (a taken name fails with "container already exists"), so it is ours to remove.
  test("a success that prints no ID counts as failed and clears the container this call made", async () => {
    const { runtime, runner } = make([
      { argv: argv.run, result: { exitCode: 0, stdout: "", stderr: "" } },
      { argv: argv.delete, result: rec("delete") },
    ]);
    expect(await runtime.start(spec())).toEqual({ ok: false, error: { code: "runtime.start_failed", data: { exitCode: 0 } } });
    expect(runner.calls).toContainEqual(argv.delete);
  });

  test("it asks for the defaults of the manager when the spec has no caps", async () => {
    const wanted = runArgv(spec({ memoryBytes: null, cpus: null }), DEFAULTS);
    const { runtime, runner } = make([{ argv: wanted, result: rec("run") }]);
    expect((await runtime.start(spec({ memoryBytes: null, cpus: null }))).ok).toBe(true);
    expect(runner.calls[0]).toContain("--memory");
    expect(runner.calls[0]).toContain("--cpus");
  });
});

describe("load", () => {
  test("it streams an OCI layout to the standard input of image load, with no manifest.json", async () => {
    const { runtime, runner } = make([{ argv: argv.load, result: { exitCode: 0, stdout: "", stderr: "" } }]);
    expect(await runtime.load(tiny)).toEqual({ ok: true, value: undefined });
    expect(runner.calls).toEqual([argv.load]);
    expect(runner.inputs.map((input) => input.argv)).toEqual([argv.load]);
    const entries = tarEntries(runner.inputs[0]?.bytes ?? new Uint8Array());
    const blobs = [tiny.manifest, tiny.config, ...tiny.layers].map((blob) => `blobs/sha256/${blob.digest.slice(7)}`);
    expect(entries.map((entry) => entry.name)).toEqual(["oci-layout", "index.json", ...blobs]);
    expect(entries.map((entry) => entry.name)).not.toContain("manifest.json");
    for (const entry of entries.filter((entry) => entry.name.startsWith("blobs/sha256/"))) {
      expect(digestOf(entry.body)).toBe(`sha256:${entry.name.slice("blobs/sha256/".length)}`);
    }
  });

  test("it counts three copies of the download on the disk while it loads", () => {
    expect(make([]).runtime.loadCopies).toBe(3);
  });

  test("a system service that is off gives runtime.apple_not_started", async () => {
    // The recorded text of a pull against a stopped service, which every call of the tool says alike.
    const { runtime } = make([{ argv: argv.load, result: rec("pull-service-down") }]);
    expect(await runtime.load(tiny)).toEqual({ ok: false, error: { code: "runtime.apple_not_started", data: {} } });
  });

  test("any other failure gives runtime.load_failed with the exit code, even after the output said 100%", async () => {
    const { runtime } = make([
      { argv: argv.load, result: { exitCode: 1, stdout: "", stderr: "Loading image 100%\nError: the connection was reset\n" } },
    ]);
    expect(await runtime.load(tiny)).toEqual({ ok: false, error: { code: "runtime.load_failed", data: { exitCode: 1 } } });
  });

  test("a signal that fired before the load gives download.cancelled and runs nothing", async () => {
    const controller = new AbortController();
    controller.abort();
    const { runtime, runner } = make([{ argv: argv.load, result: { exitCode: 0, stdout: "", stderr: "" } }]);
    expect(await runtime.load(tiny, { signal: controller.signal })).toEqual({
      ok: false,
      error: { code: "download.cancelled", data: {} },
    });
    expect(runner.calls).toEqual([]);
  });
});

// No recording of the tool's image inspect exists. This JSON follows the tool's source at 1.6.1 (ImageResource): the
// image's own descriptor under configuration, and the digests of the loaded manifests under variants.
describe("verifyImage", () => {
  const inspectJson = (descriptor: string, variants: string[]) =>
    JSON.stringify([
      {
        name: tiny.name,
        configuration: { descriptor: { mediaType: "application/vnd.oci.image.index.v1+json", digest: descriptor, size: 400 } },
        variants: variants.map((digest) => ({ platform: { os: "linux", architecture: "arm64" }, digest, size: 610 })),
      },
    ]);
  const answer = (stdout: string) => ({ argv: argv.imageInspect, result: { exitCode: 0, stdout, stderr: "" } });
  const OTHER = `sha256:${"3".repeat(64)}`;
  const INDEX = `sha256:${"4".repeat(64)}`;

  test("(follows the tool's source at 1.6.1) an image with the manifest digest among its variants is verified, and is run by its name", async () => {
    const { runtime, runner } = make([answer(inspectJson(INDEX, [OTHER, tiny.manifest.digest]))]);
    expect(await runtime.verifyImage(tiny)).toEqual({ ok: true, value: tiny.name });
    expect(runner.calls).toEqual([argv.imageInspect]);
  });

  test("(follows the tool's source at 1.6.1) an image without the manifest digest among its variants is runtime.image_not_verified", async () => {
    const { runtime } = make([answer(inspectJson(INDEX, [OTHER]))]);
    expect(await runtime.verifyImage(tiny)).toEqual({
      ok: false,
      error: { code: "runtime.image_not_verified", data: { name: tiny.name } },
    });
  });

  test("an image the tool does not have is runtime.image_not_verified", async () => {
    // The text is made up for the test.
    const { runtime } = make([
      { argv: argv.imageInspect, result: { exitCode: 1, stdout: "", stderr: `Error: notFound: "image not found: ${tiny.name}"\n` } },
    ]);
    expect(await runtime.verifyImage(tiny)).toEqual({
      ok: false,
      error: { code: "runtime.image_not_verified", data: { name: tiny.name } },
    });
  });

  test("an answer that is not the tool's JSON is runtime.image_not_verified", async () => {
    const { runtime } = make([answer("not json")]);
    expect((await runtime.verifyImage(tiny)).ok).toBe(false);
  });

  test("a system service that is off gives runtime.apple_not_started", async () => {
    const { runtime } = make([{ argv: argv.imageInspect, result: rec("pull-service-down") }]);
    expect(await runtime.verifyImage(tiny)).toEqual({ ok: false, error: { code: "runtime.apple_not_started", data: {} } });
  });
});

describe("status", () => {
  const states = [
    ["inspect-running", { state: "running", exitCode: null, oomKilled: null }],
    ["inspect-stopped", { state: "stopped", exitCode: null, oomKilled: null }],
    ["inspect-stopping", { state: "stopped", exitCode: null, oomKilled: null }],
    ["inspect-unknown", { state: "stopped", exitCode: null, oomKilled: null }],
  ] as const;
  for (const [recording, expected] of states) {
    test(`${recording} reads as ${expected.state}`, async () => {
      const { runtime } = make([{ argv: argv.inspect, result: rec(recording) }]);
      expect(await runtime.status(NAME)).toEqual({ ok: true, value: expected });
    });
  }

  test("a plain string in status is not a state the tool prints, so it is runtime.command_failed", async () => {
    const flat = '[{"id":"aidm-engine","status":"running"}]';
    const { runtime } = make([{ argv: argv.inspect, result: { exitCode: 0, stdout: flat, stderr: "" } }]);
    expect(await runtime.status(NAME)).toEqual({
      ok: false,
      error: { code: "runtime.command_failed", data: { operation: "status", exitCode: 0 } },
    });
  });

  // The text is made up for the test.
  test("a not-found error about something else is not a missing container", async () => {
    const { runtime } = make([
      { argv: argv.inspect, result: { exitCode: 1, stdout: "", stderr: 'Error: notFound: "default kernel not found"\n' } },
    ]);
    expect(await runtime.status(NAME)).toEqual({
      ok: false,
      error: { code: "runtime.command_failed", data: { operation: "status", exitCode: 1 } },
    });
  });

  test("a container that is not found is missing, not an error", async () => {
    const { runtime } = make([{ argv: argv.inspect, result: rec("inspect-missing") }]);
    expect(await runtime.status(NAME)).toEqual({ ok: true, value: { state: "missing", exitCode: null, oomKilled: null } });
  });

  test("an empty list is missing too", async () => {
    const { runtime } = make([{ argv: argv.inspect, result: { exitCode: 0, stdout: "[]\n", stderr: "" } }]);
    expect(await runtime.status(NAME)).toEqual({ ok: true, value: { state: "missing", exitCode: null, oomKilled: null } });
  });

  test("a service that is off gives runtime.apple_not_started", async () => {
    const { runtime } = make([{ argv: argv.inspect, result: rec("inspect-service-down") }]);
    expect(await runtime.status(NAME)).toEqual({ ok: false, error: { code: "runtime.apple_not_started", data: {} } });
  });

  test("an answer that makes no sense, or another failure, gives runtime.command_failed", async () => {
    const odd = make([{ argv: argv.inspect, result: { exitCode: 0, stdout: '[{"status":{"state":"flying"}}]', stderr: "" } }]);
    expect(await odd.runtime.status(NAME)).toEqual({
      ok: false,
      error: { code: "runtime.command_failed", data: { operation: "status", exitCode: 0 } },
    });
    const broken = make([{ argv: argv.inspect, result: { exitCode: 2, stdout: "", stderr: "Error: boom\n" } }]);
    expect(await broken.runtime.status(NAME)).toEqual({
      ok: false,
      error: { code: "runtime.command_failed", data: { operation: "status", exitCode: 2 } },
    });
  });
});

describe("logs", () => {
  test("the recorded lines reach the caller, with -f and -n when asked", async () => {
    const followed = [TOOL, "logs", "-f", "-n", "50", NAME];
    const { runtime, runner } = make([{ argv: followed, result: rec("logs") }]);
    const lines: string[] = [];
    expect(await runtime.logs(NAME, { follow: true, tail: 50, onLine: (line) => lines.push(line) })).toEqual({ ok: true, value: undefined });
    expect(runner.calls).toEqual([followed]);
    expect(lines).toEqual(["AIDM API 2.5.0 listening on port 3000", "queue: 0 tasks"]);
  });

  test("a plain read has no flags", async () => {
    const { runtime, runner } = make([{ argv: argv.logs, result: rec("logs") }]);
    await runtime.logs(NAME, { follow: false, onLine: () => {} });
    expect(runner.calls).toEqual([argv.logs]);
  });

  test("a container that is gone ends the log quietly and its message is not a log line", async () => {
    const { runtime } = make([{ argv: argv.logs, result: rec("logs-missing") }]);
    const lines: string[] = [];
    expect(await runtime.logs(NAME, { follow: false, onLine: (line) => lines.push(line) })).toEqual({ ok: true, value: undefined });
    expect(lines).toEqual([]);
  });

  test("another failure gives runtime.command_failed", async () => {
    const { runtime } = make([{ argv: argv.logs, result: { exitCode: 4, stdout: "", stderr: "Error: boom\n" } }]);
    expect(await runtime.logs(NAME, { follow: false, onLine: () => {} })).toEqual({
      ok: false,
      error: { code: "runtime.command_failed", data: { operation: "logs", exitCode: 4 } },
    });
  });
});

describe("stop, remove and removeImage", () => {
  test("stop gives the container the time asked for, and the tool's default otherwise", async () => {
    const timed = [TOOL, "stop", "-t", "30", NAME];
    const { runtime, runner } = make([
      { argv: argv.stop, result: rec("stop") },
      { argv: timed, result: rec("stop") },
    ]);
    expect((await runtime.stop(NAME)).ok).toBe(true);
    expect((await runtime.stop(NAME, 30)).ok).toBe(true);
    expect(runner.calls).toEqual([argv.stop, timed]);
  });

  test("stopping a container that is not running, or is gone, or whose service is off, is fine", async () => {
    for (const recording of ["stop-not-running", "stop-missing", "run-service-down"]) {
      const { runtime } = make([{ argv: argv.stop, result: rec(recording) }]);
      expect(await runtime.stop(NAME), recording).toEqual({ ok: true, value: undefined });
    }
  });

  test("another stop failure gives runtime.command_failed", async () => {
    const { runtime } = make([{ argv: argv.stop, result: { exitCode: 1, stdout: "", stderr: "Error: boom\n" } }]);
    expect(await runtime.stop(NAME)).toEqual({
      ok: false,
      error: { code: "runtime.command_failed", data: { operation: "stop", exitCode: 1 } },
    });
  });

  test("remove forces the delete, and a missing container is fine", async () => {
    const found = make([{ argv: argv.delete, result: rec("delete") }]);
    expect(await found.runtime.remove(NAME)).toEqual({ ok: true, value: undefined });
    expect(found.runner.calls).toEqual([argv.delete]);
    const missing = make([{ argv: argv.delete, result: rec("delete-missing") }]);
    expect(await missing.runtime.remove(NAME)).toEqual({ ok: true, value: undefined });
  });

  test("a delete that fails for another reason gives runtime.command_failed, and a service that is off its own code", async () => {
    const refused = make([
      { argv: argv.delete, result: { exitCode: 1, stdout: "", stderr: 'Error: invalidState: "container aidm-engine is running and can not be deleted"\n' } },
    ]);
    expect(await refused.runtime.remove(NAME)).toEqual({
      ok: false,
      error: { code: "runtime.command_failed", data: { operation: "remove", exitCode: 1 } },
    });
    const down = make([{ argv: argv.delete, result: rec("run-service-down") }]);
    expect(await down.runtime.remove(NAME)).toEqual({ ok: false, error: { code: "runtime.apple_not_started", data: {} } });
  });

  test("removeImage deletes by reference, and an image that is gone is fine", async () => {
    const found = make([{ argv: argv.imageDelete, result: rec("image-delete") }]);
    expect(await found.runtime.removeImage(IMAGE)).toEqual({ ok: true, value: undefined });
    expect(found.runner.calls).toEqual([argv.imageDelete]);
    const missing = make([{ argv: argv.imageDelete, result: rec("image-delete-missing") }]);
    expect(await missing.runtime.removeImage(IMAGE)).toEqual({ ok: true, value: undefined });
  });

  test("an image that is in use stays, with runtime.command_failed", async () => {
    const { runtime } = make([{ argv: argv.imageDelete, result: rec("image-delete-in-use") }]);
    expect(await runtime.removeImage(IMAGE)).toEqual({
      ok: false,
      error: { code: "runtime.command_failed", data: { operation: "removeImage", exitCode: 1 } },
    });
  });
});

test("the version the tool prints on its own is the recorded line", () => {
  expect(recordedText("apple-container", "cli-version")).toMatch(/^container CLI version 1\.6\.1 \(build: release, commit: [0-9a-f]{7}\)\n$/);
});

test("a one-off run is refused without running anything, since no Mac package needs one", async () => {
  const { runtime, runner } = make([]);
  const result = await runtime.runOnce({ name: "aidm-gpu-check", image: IMAGE, platform: null, gpu: true, args: ["nvidia-smi"] }, 1000);
  expect(result).toEqual({ ok: false, error: { code: "runtime.command_failed", data: { operation: "run_once", exitCode: null } } });
  expect(runner.calls).toEqual([]);
});
