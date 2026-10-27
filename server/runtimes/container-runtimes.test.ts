import type { CommandRunner } from "../process/command-runner.ts";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedRunner, recorded, recordedText, type ScriptedRule } from "../../test-support/scripted-runner.ts";
import { localName, type DownloadedImage } from "../images/image-download.ts";
import { loggingRunner } from "../process/logging-runner.ts";
import { dockerRuntime, runArgv as dockerRunArgv } from "./docker.ts";
import { podmanRuntime, runArgv as podmanRunArgv } from "./podman.ts";
import type { ContainerRuntime, ContainerSpec, RuntimeDetection } from "./runtime.ts";

const IMAGE = "docker.io/library/busybox@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e";
const NAME = "aidm-engine";
const GIB = 1024 ** 3;

const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
const BUSYBOX_MANIFEST = "sha256:66a6306db78bf2dbf3487f293aa8d6990d8e506fdffab9cc43fe422becf886e4";
const BUSYBOX_CONFIG = "sha256:30ecbe1509090b38ef3260f3609d64d8261230464eaa4d235901db496e9647fb";
const BUSYBOX_LAYER = "sha256:68fe9bff2ad4ad46da3e58db03faa64eb73c0ff16d546b0c42539eaa9854cb7f";
const BUSYBOX_PINNED = { repository: "ghcr.io/aidm-ui-loadtest/busybox", digest: BUSYBOX_MANIFEST };

/**
 * The image behind the recordings of load and inspect (busybox 1.37, linux/amd64).
 * The blobs are not on disk: the tests that use it only read its digests and its
 * name. The config size is not known from the recordings and no test reads it.
 */
const busybox: DownloadedImage = {
  pinned: BUSYBOX_PINNED,
  folder: "/home/operator/aidm-ui/downloads/images/busybox",
  name: localName(BUSYBOX_PINNED),
  manifest: { digest: BUSYBOX_MANIFEST, size: 610, mediaType: OCI_MANIFEST },
  config: { digest: BUSYBOX_CONFIG, size: 0 },
  layers: [{ digest: BUSYBOX_LAYER, size: 2211514 }],
};

const scratch = mkdtempSync(join(tmpdir(), "aidm-ui-runtimes-test-"));
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
  const config = put(new TextEncoder().encode('{"architecture":"amd64","os":"linux"}\n'));
  // Not a multiple of 512, so the archive has to pad it.
  const layer = put(new Uint8Array(1000).map((_, index) => index % 251));
  const manifestBytes = new TextEncoder().encode(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: OCI_MANIFEST,
      config: { mediaType: "application/vnd.oci.image.config.v1+json", ...config },
      layers: [{ mediaType: "application/vnd.oci.image.layer.v1.tar", ...layer }],
    }),
  );
  const manifest = put(manifestBytes);
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

/** The blob entries an archive of this image must hold, as tar names. */
const blobNames = (image: DownloadedImage) =>
  [image.manifest, image.config, ...image.layers].map((blob) => `blobs/sha256/${blob.digest.slice(7)}`);

function spec(patch: Partial<ContainerSpec> = {}): ContainerSpec {
  return {
    name: NAME,
    image: IMAGE,
    platform: null,
    publish: { hostAddress: "127.0.0.1", hostPort: 41823, containerPort: 3000 },
    mounts: [{ hostPath: "/home/operator/engine-data", containerPath: "/var/www/data", readOnly: false }],
    memoryBytes: 8 * GIB,
    cpus: 4,
    gpu: false,
    args: ["--token", "s3cret-token", "--port", "3000"],
    ...patch,
  };
}

function detection(
  id: "podman" | "docker",
  memoryCapEnforced: boolean | null = true,
  cpuCapEnforced: boolean | null = true,
): RuntimeDetection {
  return { id, available: true, version: "1", memoryCapEnforced, cpuCapEnforced, storagePath: null, problem: null };
}

const tools = [
  {
    id: "podman" as const,
    make: (runner: CommandRunner, log?: (line: string) => void): ContainerRuntime => podmanRuntime(runner, log),
    runArgv: podmanRunArgv,
    mountSuffix: ":Z",
    readOnlySuffix: ":ro,Z",
    inspect: (name: string) => ["podman", "container", "inspect", name],
    detectRules: [
      { argv: ["podman", "version", "--format", "json"], result: recorded("podman", "version") },
      { argv: ["podman", "info", "--format", "json"], result: recorded("podman", "info-rootless") },
    ] as ScriptedRule[],
    imageInspect: "image-inspect-loaded",
  },
  {
    id: "docker" as const,
    make: (runner: CommandRunner, log?: (line: string) => void): ContainerRuntime => dockerRuntime(runner, log),
    runArgv: dockerRunArgv,
    mountSuffix: "",
    readOnlySuffix: ":ro",
    inspect: (name: string) => ["docker", "inspect", "--type", "container", name],
    detectRules: [
      { argv: ["docker", "version", "--format", "json"], result: recorded("docker", "version") },
      { argv: ["docker", "info", "--format", "json"], result: recorded("docker", "info") },
    ] as ScriptedRule[],
    imageInspect: "image-inspect-containerd",
  },
];

describe("the command line that starts the container", () => {
  test("Podman publishes on loopback, labels the mount, caps memory and CPUs, and puts the arguments after the image", () => {
    expect(podmanRunArgv(spec({ platform: "linux/amd64" }), detection("podman"))).toEqual([
      "podman", "run", "-d", "--pull=never", "--name", NAME,
      "-p", "127.0.0.1:41823:3000",
      "-v", "/home/operator/engine-data:/var/www/data:Z",
      "--memory", "8589934592b", "--cpus", "4",
      "--platform", "linux/amd64",
      IMAGE, "--token", "s3cret-token", "--port", "3000",
    ]);
  });

  test("Docker is the same without the mount label", () => {
    expect(dockerRunArgv(spec(), detection("docker"))).toEqual([
      "docker", "run", "-d", "--pull=never", "--name", NAME,
      "-p", "127.0.0.1:41823:3000",
      "-v", "/home/operator/engine-data:/var/www/data",
      "--memory", "8589934592b", "--cpus", "4",
      IMAGE, "--token", "s3cret-token", "--port", "3000",
    ]);
  });

  for (const tool of tools) {
    test(`${tool.id} never pulls when it starts, so a missing image is an error and not a download`, () => {
      expect(tool.runArgv(spec(), detection(tool.id))).toContain("--pull=never");
    });

    test(`${tool.id} leaves out the memory cap alone when only that one would not be enforced`, () => {
      const argv = tool.runArgv(spec(), detection(tool.id, false, true));
      expect(argv).not.toContain("--memory");
      expect(argv).toContain("--cpus");
      expect(argv).toContain(IMAGE);
    });

    test(`${tool.id} leaves out the CPU cap alone when only that one would not be enforced`, () => {
      const argv = tool.runArgv(spec(), detection(tool.id, true, false));
      expect(argv).toContain("--memory");
      expect(argv).not.toContain("--cpus");
      expect(argv).toContain(IMAGE);
    });

    test(`${tool.id} leaves both caps out when neither would be enforced`, () => {
      const argv = tool.runArgv(spec(), detection(tool.id, false, false));
      expect(argv).not.toContain("--memory");
      expect(argv).not.toContain("--cpus");
    });

    test(`${tool.id} keeps the caps when it cannot tell whether they are enforced`, () => {
      expect(tool.runArgv(spec(), detection(tool.id, null))).toContain("--memory");
    });

    test(`${tool.id} sends no cap that the spec leaves out`, () => {
      const argv = tool.runArgv(spec({ memoryBytes: null, cpus: null }), detection(tool.id));
      expect(argv).not.toContain("--memory");
      expect(argv).not.toContain("--cpus");
    });

    test(`${tool.id} never sets a restart policy and publishes on loopback only`, () => {
      const argv = tool.runArgv(spec({ platform: "linux/arm64", gpu: true }), detection(tool.id));
      expect(argv.some((part) => part.startsWith("--restart"))).toBe(false);
      const publish = argv[argv.indexOf("-p") + 1];
      expect(publish?.startsWith("127.0.0.1:")).toBe(true);
      expect(argv.filter((part) => part === "-p")).toHaveLength(1);
    });

    test(`${tool.id} mounts every folder the spec lists`, () => {
      const argv = tool.runArgv(
        spec({
          mounts: [
            { hostPath: "/a", containerPath: "/x", readOnly: false },
            { hostPath: "/b", containerPath: "/y", readOnly: false },
          ],
        }),
        detection(tool.id),
      );
      expect(argv.filter((part) => part === "-v")).toHaveLength(2);
      expect(argv).toContain(`/a:/x${tool.mountSuffix}`);
      expect(argv).toContain(`/b:/y${tool.mountSuffix}`);
    });

    test(`${tool.id} marks a read-only mount and leaves a writable one as it was`, () => {
      const argv = tool.runArgv(
        spec({
          mounts: [
            { hostPath: "/a", containerPath: "/x", readOnly: true },
            { hostPath: "/b", containerPath: "/y", readOnly: false },
          ],
        }),
        detection(tool.id),
      );
      expect(argv).toContain(`/a:/x${tool.readOnlySuffix}`);
      expect(argv).toContain(`/b:/y${tool.mountSuffix}`);
    });
  }
});

const GPU_FLAGS = { podman: ["--device", "nvidia.com/gpu=all"], docker: ["--gpus", "all"] } as const;

describe("the graphics card flag", () => {
  for (const tool of tools) {
    test(`${tool.id} passes the graphics card through when the spec asks, just before the image`, () => {
      const argv = tool.runArgv(spec({ gpu: true }), detection(tool.id));
      const at = argv.indexOf(IMAGE);
      expect(argv.slice(at - 2, at)).toEqual([...GPU_FLAGS[tool.id]]);
    });

    test(`${tool.id} passes no graphics card flag for the processor package`, () => {
      const argv = tool.runArgv(spec({ gpu: false }), detection(tool.id));
      expect(argv).not.toContain("--gpus");
      expect(argv).not.toContain("--device");
    });

    test(`${tool.id} runs one command with the entry point replaced, the card passed through, and removes the container`, async () => {
      const oneOff = { ...spec({ gpu: true, args: ["-L"] }), entrypoint: "nvidia-smi" };
      const argv = [
        tool.id, "run", "--rm", "--name", NAME, "--pull=never", "--entrypoint", "nvidia-smi", ...GPU_FLAGS[tool.id], IMAGE, "-L",
      ];
      const runner = new ScriptedRunner([{ argv, result: recorded("nvidia", "smi-l") }]);
      const result = await tool.make(runner).runOnce(oneOff, 120_000);
      expect(result).toEqual({ ok: true, value: { exitCode: 0, stdout: recordedText("nvidia", "smi-l"), stderr: "" } });
      expect(runner.calls).toEqual([[tool.id, "rm", "-f", NAME], argv]);
    });

    test(`${tool.id} clears a check container left by a crash before a one-off run`, async () => {
      const oneOff = { ...spec({ gpu: true, args: ["-L"] }), entrypoint: "nvidia-smi" };
      const runner = new ScriptedRunner([]);
      await tool.make(runner).runOnce(oneOff, 120_000);
      expect(runner.calls[0]).toEqual([tool.id, "rm", "-f", NAME]);
    });

    test(`${tool.id} hands back the exit code and the message of a one-off run that failed`, async () => {
      const oneOff = { ...spec({ gpu: true, args: ["-L"] }), entrypoint: "nvidia-smi" };
      const argv = [
        tool.id, "run", "--rm", "--name", NAME, "--pull=never", "--entrypoint", "nvidia-smi", ...GPU_FLAGS[tool.id], IMAGE, "-L",
      ];
      const runner = new ScriptedRunner([{ argv, result: recorded("nvidia", "smi-l-no-driver") }]);
      const result = await tool.make(runner).runOnce(oneOff, 120_000);
      expect(result).toEqual({
        ok: true,
        value: { exitCode: 9, stdout: "", stderr: expect.stringContaining("couldn't communicate with the NVIDIA driver") },
      });
      // A run that failed leaves no container behind.
      expect(runner.calls).toContainEqual([tool.id, "rm", "-f", NAME]);
    });

    test(`${tool.id} removes the container of a one-off run that ran out of time, and gives the time limit to the tool`, async () => {
      const oneOff = { ...spec({ gpu: true, args: ["-L"] }), entrypoint: "nvidia-smi" };
      const argv = [
        tool.id, "run", "--rm", "--name", NAME, "--pull=never", "--entrypoint", "nvidia-smi", ...GPU_FLAGS[tool.id], IMAGE, "-L",
      ];
      const runner = new ScriptedRunner([{ argv, result: { exitCode: 124, stdout: "", stderr: "timed out" } }]);
      const result = await tool.make(runner).runOnce(oneOff, 120_000);
      expect(result).toMatchObject({ ok: true, value: { exitCode: 124 } });
      expect(runner.timeouts[1]).toBe(120_000);
      expect(runner.calls).toContainEqual([tool.id, "rm", "-f", NAME]);
    });

    test(`${tool.id} stops a one-off run when the signal fires, and removes its container`, async () => {
      const oneOff = { ...spec({ gpu: true, args: ["-L"] }), entrypoint: "nvidia-smi" };
      const argv = [
        tool.id, "run", "--rm", "--name", NAME, "--pull=never", "--entrypoint", "nvidia-smi", ...GPU_FLAGS[tool.id], IMAGE, "-L",
      ];
      const controller = new AbortController();
      let running = () => {};
      const started = new Promise<void>((resolve) => (running = resolve));
      const runner = new ScriptedRunner([
        {
          argv,
          result: (_argv, signal) =>
            new Promise((resolve) => {
              running();
              signal?.addEventListener("abort", () => resolve({ exitCode: 137, stdout: "", stderr: "" }), { once: true });
            }),
        },
      ]);
      const pending = tool.make(runner).runOnce(oneOff, 120_000, controller.signal);
      await started;
      expect(runner.calls).toEqual([[tool.id, "rm", "-f", NAME], argv]);
      controller.abort();
      await pending;
      expect(runner.calls).toContainEqual([tool.id, "rm", "-f", NAME]);
    });

    test(`${tool.id} removes the container of a one-off run whose signal fired before it began`, async () => {
      const controller = new AbortController();
      controller.abort();
      const runner = new ScriptedRunner([]);
      await tool.make(runner).runOnce(spec({ gpu: false, args: ["true"] }), 1000, controller.signal);
      expect(runner.calls.filter((call) => call[1] === "run")).toEqual([]);
      expect(runner.calls).toContainEqual([tool.id, "rm", "-f", NAME]);
    });

    test(`${tool.id} leaves the card flag out of a one-off run for the processor package`, async () => {
      const runner = new ScriptedRunner([]);
      await tool.make(runner).runOnce(spec({ gpu: false, args: ["true"] }), 1000);
      expect(runner.calls[1]).toEqual([tool.id, "run", "--rm", "--name", NAME, "--pull=never", IMAGE, "true"]);
    });
  }
});

for (const tool of tools) {
  describe(`${tool.id} through recorded outputs`, () => {
    const binary = tool.id;
    const cases = (name: string): ScriptedRule["result"] => recorded(binary, name);
    const argv = {
      run: tool.runArgv(spec(), detection(tool.id)),
      rm: [binary, "rm", "-f", NAME],
      inspect: tool.inspect(NAME),
    };

    async function started(runCase: string, extra: ScriptedRule[] = []) {
      const runner = new ScriptedRunner([...tool.detectRules, { argv: argv.run, result: cases(runCase) }, ...extra]);
      return { runner, result: await tool.make(runner).start(spec()) };
    }

    test("a start gives the container ID the tool prints", async () => {
      const { result, runner } = await started("run");
      expect(result).toEqual({ ok: true, value: { containerId: recordedText(binary, "run").trim() } });
      expect(runner.calls).toContainEqual(argv.run);
    });

    test("a name that is in use gives runtime.name_in_use and leaves that container alone", async () => {
      const { result, runner } = await started("run-name-in-use");
      expect(result).toEqual({ ok: false, error: { code: "runtime.name_in_use", data: { name: NAME } } });
      expect(runner.calls).not.toContainEqual(argv.rm);
    });

    test("a port that is in use gives runtime.port_in_use and clears the half-made container", async () => {
      const { result, runner } = await started("run-port-in-use", [{ argv: argv.rm, result: cases("rm") }]);
      expect(result).toEqual({ ok: false, error: { code: "runtime.port_in_use", data: { port: 41823 } } });
      expect(runner.calls).toContainEqual(argv.rm);
    });

    test("any other failure gives runtime.start_failed with the exit code", async () => {
      const runner = new ScriptedRunner([
        ...tool.detectRules,
        { argv: argv.run, result: { exitCode: 125, stdout: "", stderr: "Error: something odd\n" } },
        { argv: argv.rm, result: cases("rm") },
      ]);
      expect(await tool.make(runner).start(spec())).toEqual({
        ok: false,
        error: { code: "runtime.start_failed", data: { exitCode: 125 } },
      });
      expect(runner.calls).toContainEqual(argv.rm);
    });

    test("a start against an image that is not stored fails at once with runtime.image_not_found, and never pulls", async () => {
      const { result, runner } = await started("run-image-not-found", [{ argv: argv.rm, result: cases("rm") }]);
      expect(result).toEqual({ ok: false, error: { code: "runtime.image_not_found", data: {} } });
      expect(runner.calls.some((call) => call[1] === "pull")).toBe(false);
      expect(runner.calls).toContainEqual(argv.run);
    });

    test("a program missing inside the image is a failed start, not a missing image", async () => {
      const runner = new ScriptedRunner([
        ...tool.detectRules,
        {
          argv: argv.run,
          result: { exitCode: 127, stdout: "", stderr: 'exec: "aidm-api": executable file not found in $PATH\n' },
        },
      ]);
      const result = await tool.make(runner).start(spec());
      expect(result).toEqual({ ok: false, error: { code: "runtime.start_failed", data: { exitCode: 127 } } });
    });

    test("a start that prints no container ID is a failed start, and clears the container it may have made", async () => {
      const runner = new ScriptedRunner([
        ...tool.detectRules,
        { argv: argv.run, result: { exitCode: 0, stdout: "", stderr: "" } },
        { argv: argv.rm, result: cases("rm") },
      ]);
      expect(await tool.make(runner).start(spec())).toEqual({
        ok: false,
        error: { code: "runtime.start_failed", data: { exitCode: 0 } },
      });
      expect(runner.calls).toContainEqual(argv.rm);
    });

    test("a loaded image is verified by asking the tool for the image by its name", async () => {
      const runner = new ScriptedRunner([{ argv: [binary, "image", "inspect", busybox.name], result: cases(tool.imageInspect) }]);
      const result = await tool.make(runner).verifyImage(busybox);
      expect(result.ok).toBe(true);
      expect(runner.calls).toEqual([[binary, "image", "inspect", busybox.name]]);
    });

    test("an image the tool does not hold is runtime.image_not_verified", async () => {
      const runner = new ScriptedRunner([{ argv: [binary, "image", "inspect", busybox.name], result: cases("image-inspect-missing") }]);
      expect(await tool.make(runner).verifyImage(busybox)).toEqual({
        ok: false,
        error: { code: "runtime.image_not_verified", data: { name: busybox.name } },
      });
    });

    test("an image whose ID and digest are neither digest of the download is runtime.image_not_verified", async () => {
      // A copy of the recording, edited: some other image under the same name.
      const [entry] = JSON.parse(recordedText(binary, tool.imageInspect)) as Array<Record<string, unknown>>;
      const other = { ...entry, Id: `sha256:${"0".repeat(64)}`, Digest: `sha256:${"1".repeat(64)}` };
      const runner = new ScriptedRunner([
        { argv: [binary, "image", "inspect", busybox.name], result: { exitCode: 0, stdout: JSON.stringify([other]), stderr: "" } },
      ]);
      expect(await tool.make(runner).verifyImage(busybox)).toEqual({
        ok: false,
        error: { code: "runtime.image_not_verified", data: { name: busybox.name } },
      });
    });

    test("a tool that cannot be run cannot verify an image", async () => {
      const result = await tool.make(new ScriptedRunner([])).verifyImage(busybox);
      expect(result).toEqual({ ok: false, error: { code: "runtime.image_not_verified", data: { name: busybox.name } } });
    });

    test("the loaded name is removed with the tool's rmi, and the recording of that is a success", async () => {
      const runner = new ScriptedRunner([{ argv: [binary, "rmi", busybox.name], result: cases("rmi-loaded") }]);
      expect(await tool.make(runner).removeImage(busybox.name)).toEqual({ ok: true, value: undefined });
    });
    test("a running container reports running, with no exit code", async () => {
      const runner = new ScriptedRunner([{ argv: argv.inspect, result: cases("inspect-running") }]);
      expect(await tool.make(runner).status(NAME)).toEqual({
        ok: true,
        value: { state: "running", exitCode: null, oomKilled: false },
      });
    });

    test("a container that was killed reports stopped with exit code 137", async () => {
      const runner = new ScriptedRunner([{ argv: argv.inspect, result: cases("inspect-exited") }]);
      expect(await tool.make(runner).status(NAME)).toEqual({
        ok: true,
        value: { state: "stopped", exitCode: 137, oomKilled: false },
      });
    });

    test("a container that is not there reports missing", async () => {
      const runner = new ScriptedRunner([{ argv: argv.inspect, result: cases("inspect-missing") }]);
      expect(await tool.make(runner).status(NAME)).toEqual({
        ok: true,
        value: { state: "missing", exitCode: null, oomKilled: null },
      });
    });

    test("an inspect that says nothing useful is runtime.command_failed", async () => {
      const runner = new ScriptedRunner([{ argv: argv.inspect, result: { exitCode: 0, stdout: "not json", stderr: "" } }]);
      expect(await tool.make(runner).status(NAME)).toEqual({
        ok: false,
        error: { code: "runtime.command_failed", data: { operation: "status", exitCode: 0 } },
      });
    });

    test("a tool that cannot be reached is runtime.command_failed, not a missing container", async () => {
      const runner = new ScriptedRunner([
        { argv: argv.inspect, result: { exitCode: 125, stdout: "", stderr: "Error: cannot connect\n" } },
      ]);
      expect(await tool.make(runner).status(NAME)).toEqual({
        ok: false,
        error: { code: "runtime.command_failed", data: { operation: "status", exitCode: 125 } },
      });
    });

    test("logs ask for the last lines and hand over every line, from either stream", async () => {
      const runner = new ScriptedRunner([{ argv: [binary, "logs", "--tail", "50", NAME], result: cases("logs") }]);
      const lines: string[] = [];
      const result = await tool.make(runner).logs(NAME, { follow: false, tail: 50, onLine: (line) => lines.push(line) });
      expect(result).toEqual({ ok: true, value: undefined });
      expect(lines).toEqual(["[::ffff:192.0.2.1]:35504: response:200"]);
    });

    test("logs follow with -f", async () => {
      const runner = new ScriptedRunner([{ argv: [binary, "logs", "-f", NAME], result: cases("logs") }]);
      const result = await tool.make(runner).logs(NAME, { follow: true, onLine: () => {} });
      expect(result.ok).toBe(true);
    });

    test("logs of a container that is gone end quietly, without passing the tool's message on", async () => {
      const runner = new ScriptedRunner([{ argv: [binary, "logs", NAME], result: cases("logs-missing") }]);
      const lines: string[] = [];
      const result = await tool.make(runner).logs(NAME, { follow: false, onLine: (line) => lines.push(line) });
      expect(result).toEqual({ ok: true, value: undefined });
      expect(lines).toEqual([]);
    });

    test("logs that fail for another reason are runtime.command_failed", async () => {
      const runner = new ScriptedRunner([
        { argv: [binary, "logs", NAME], result: { exitCode: 1, stdout: "", stderr: "disk on fire\n" } },
      ]);
      const result = await tool.make(runner).logs(NAME, { follow: false, onLine: () => {} });
      expect(result).toEqual({
        ok: false,
        error: { code: "runtime.command_failed", data: { operation: "logs", exitCode: 1 } },
      });
    });

    test("a stop waits 30 seconds by default and takes a time of its own", async () => {
      const runner = new ScriptedRunner([
        { argv: [binary, "stop", "-t", "30", NAME], result: cases("stop") },
        { argv: [binary, "stop", "-t", "5", NAME], result: cases("stop") },
      ]);
      const runtime = tool.make(runner);
      expect(await runtime.stop(NAME)).toEqual({ ok: true, value: undefined });
      expect(await runtime.stop(NAME, 5)).toEqual({ ok: true, value: undefined });
    });

    test("stopping a container that is gone is fine, and any other failure is runtime.command_failed", async () => {
      const gone = new ScriptedRunner([{ argv: [binary, "stop", "-t", "30", NAME], result: cases("stop-missing") }]);
      expect((await tool.make(gone).stop(NAME)).ok).toBe(true);
      const broken = new ScriptedRunner([
        { argv: [binary, "stop", "-t", "30", NAME], result: { exitCode: 1, stdout: "", stderr: "denied\n" } },
      ]);
      expect(await tool.make(broken).stop(NAME)).toEqual({
        ok: false,
        error: { code: "runtime.command_failed", data: { operation: "stop", exitCode: 1 } },
      });
    });

    test("a remove is forced, and a missing container is fine", async () => {
      for (const name of ["rm", "rm-missing"]) {
        const runner = new ScriptedRunner([{ argv: argv.rm, result: cases(name) }]);
        expect(await tool.make(runner).remove(NAME)).toEqual({ ok: true, value: undefined });
      }
      const broken = new ScriptedRunner([{ argv: argv.rm, result: { exitCode: 1, stdout: "", stderr: "denied\n" } }]);
      expect(await tool.make(broken).remove(NAME)).toEqual({
        ok: false,
        error: { code: "runtime.command_failed", data: { operation: "remove", exitCode: 1 } },
      });
    });

    test("an image removal is fine when the image is there or not", async () => {
      for (const name of ["rmi", "rmi-missing"]) {
        const runner = new ScriptedRunner([{ argv: [binary, "rmi", IMAGE], result: cases(name) }]);
        expect(await tool.make(runner).removeImage(IMAGE)).toEqual({ ok: true, value: undefined });
      }
    });

    test("the token is hidden in every command line that is logged, and absent from errors", async () => {
      const logged: string[] = [];
      const runner = new ScriptedRunner([
        ...tool.detectRules,
        { argv: argv.run, result: cases("run-port-in-use") },
        { argv: argv.rm, result: cases("rm") },
      ]);
      // Every command goes through the logging runner, which writes the diagnosis log.
      const result = await tool.make(loggingRunner(runner, (line) => logged.push(line)), (line) => logged.push(line)).start(spec());
      expect(logged.length).toBeGreaterThan(0);
      expect(logged.join("\n")).not.toContain("s3cret-token");
      expect(logged.some((line) => line.includes("--token ***"))).toBe(true);
      expect(JSON.stringify(result)).not.toContain("s3cret-token");
    });
  });
}

describe("Podman loads a downloaded image", () => {
  const load = ["podman", "load", "-i", busybox.folder];
  const tag = ["podman", "tag", BUSYBOX_CONFIG, busybox.name];

  test("it loads the folder in place, then tags the config digest with the name, and is ok", async () => {
    const runner = new ScriptedRunner([
      { argv: load, result: recorded("podman", "load-dir") },
      { argv: tag, result: recorded("podman", "tag") },
    ]);
    expect(await podmanRuntime(runner).load(busybox)).toEqual({ ok: true, value: undefined });
    expect(runner.calls).toEqual([load, tag]);
    // The folder is read where it is: nothing is sent on the standard input.
    expect(runner.inputs).toEqual([]);
  });

  test("a load that fails is runtime.load_failed with the exit code, and nothing is tagged", async () => {
    const runner = new ScriptedRunner([
      { argv: load, result: recorded("podman", "load-missing") },
      { argv: tag, result: recorded("podman", "tag") },
    ]);
    expect(await podmanRuntime(runner).load(busybox)).toEqual({
      ok: false,
      error: { code: "runtime.load_failed", data: { exitCode: 125 } },
    });
    expect(runner.calls).toEqual([load]);
  });

  // The text is made up for the test: only the exit code of the tag counts.
  test("a tag that fails is runtime.load_failed too", async () => {
    const runner = new ScriptedRunner([
      { argv: load, result: recorded("podman", "load-dir") },
      { argv: tag, result: { exitCode: 125, stdout: "", stderr: "Error: no such image\n" } },
    ]);
    expect(await podmanRuntime(runner).load(busybox)).toEqual({
      ok: false,
      error: { code: "runtime.load_failed", data: { exitCode: 125 } },
    });
  });

  test("a signal that fired before the load gives download.cancelled and runs nothing", async () => {
    const controller = new AbortController();
    controller.abort();
    const runner = new ScriptedRunner([{ argv: load, result: recorded("podman", "load-dir") }]);
    const result = await podmanRuntime(runner).load(busybox, { signal: controller.signal });
    expect(result).toEqual({ ok: false, error: { code: "download.cancelled", data: {} } });
    expect(runner.calls).toEqual([]);
  });

  test("it counts one copy of the download on the disk while it loads", () => {
    expect(podmanRuntime(new ScriptedRunner([])).loadCopies).toBe(1);
  });

  test("the recorded inspect gives the ID of the image with its algorithm, which is the config digest", async () => {
    const runner = new ScriptedRunner([
      { argv: ["podman", "image", "inspect", busybox.name], result: recorded("podman", "image-inspect-loaded") },
    ]);
    expect(await podmanRuntime(runner).verifyImage(busybox)).toEqual({ ok: true, value: BUSYBOX_CONFIG });
  });

  test("an image with the manifest digest of the download is verified even when its ID is another", async () => {
    const [entry] = JSON.parse(recordedText("podman", "image-inspect-loaded")) as Array<Record<string, unknown>>;
    const other = { ...entry, Id: "2".repeat(64) };
    const runner = new ScriptedRunner([
      { argv: ["podman", "image", "inspect", busybox.name], result: { exitCode: 0, stdout: JSON.stringify([other]), stderr: "" } },
    ]);
    expect(await podmanRuntime(runner).verifyImage(busybox)).toEqual({ ok: true, value: `sha256:${"2".repeat(64)}` });
  });
});

describe("Docker loads a downloaded image", () => {
  const tiny = tinyImage();
  const load = ["docker", "load"];

  test("it streams an archive to the standard input of docker load, and is ok for both image stores", async () => {
    for (const recording of ["load", "load-classic"]) {
      const runner = new ScriptedRunner([{ argv: load, result: recorded("docker", recording) }]);
      expect(await dockerRuntime(runner).load(tiny), recording).toEqual({ ok: true, value: undefined });
      expect(runner.calls, recording).toEqual([load]);
      expect(runner.inputs.map((input) => input.argv), recording).toEqual([load]);
    }
  });

  test("the archive holds the layout files, the manifest.json of docker save, and then the blobs", async () => {
    const runner = new ScriptedRunner([{ argv: load, result: recorded("docker", "load") }]);
    await dockerRuntime(runner).load(tiny);
    const entries = tarEntries(runner.inputs[0]?.bytes ?? new Uint8Array());
    expect(entries.map((entry) => entry.name)).toEqual(["oci-layout", "index.json", "manifest.json", ...blobNames(tiny)]);
    for (const entry of entries.filter((entry) => entry.name.startsWith("blobs/sha256/"))) {
      expect(digestOf(entry.body)).toBe(`sha256:${entry.name.slice("blobs/sha256/".length)}`);
    }
    const [saved] = JSON.parse(new TextDecoder().decode(entries[2]?.body)) as Array<{ RepoTags: string[] }>;
    expect(saved?.RepoTags).toEqual([tiny.name]);
  });

  test("a load that fails is runtime.load_failed with the exit code", async () => {
    const runner = new ScriptedRunner([{ argv: load, result: recorded("docker", "load-truncated") }]);
    expect(await dockerRuntime(runner).load(tiny)).toEqual({
      ok: false,
      error: { code: "runtime.load_failed", data: { exitCode: 1 } },
    });
  });

  test("a signal that fired before the load gives download.cancelled and runs nothing", async () => {
    const controller = new AbortController();
    controller.abort();
    const runner = new ScriptedRunner([{ argv: load, result: recorded("docker", "load") }]);
    const result = await dockerRuntime(runner).load(tiny, { signal: controller.signal });
    expect(result).toEqual({ ok: false, error: { code: "download.cancelled", data: {} } });
    expect(runner.calls).toEqual([]);
  });

  test("it counts one copy of the download on the disk while it loads", () => {
    expect(dockerRuntime(new ScriptedRunner([])).loadCopies).toBe(1);
  });

  test("the containerd image store gives the manifest digest as the ID, and that is the reference", async () => {
    const runner = new ScriptedRunner([
      { argv: ["docker", "image", "inspect", busybox.name], result: recorded("docker", "image-inspect-containerd") },
    ]);
    expect(await dockerRuntime(runner).verifyImage(busybox)).toEqual({ ok: true, value: BUSYBOX_MANIFEST });
  });

  test("the classic image store gives the config digest as the ID, and that is the reference", async () => {
    const runner = new ScriptedRunner([
      { argv: ["docker", "image", "inspect", busybox.name], result: recorded("docker", "image-inspect-classic") },
    ]);
    expect(await dockerRuntime(runner).verifyImage(busybox)).toEqual({ ok: true, value: BUSYBOX_CONFIG });
  });
});

for (const [missing, info, memory, cpus] of [
  ["memory", "info-rootless-no-memory", false, true],
  ["CPU", "info-rootless-no-cpu", true, false],
] as const) {
  test(`Podman without the ${missing} controller starts the container without that cap and with the other`, async () => {
    const expected = podmanRunArgv(spec(), detection("podman", memory, cpus));
    expect(expected.includes("--memory")).toBe(memory);
    expect(expected.includes("--cpus")).toBe(cpus);
    const runner = new ScriptedRunner([
      { argv: ["podman", "version", "--format", "json"], result: recorded("podman", "version") },
      { argv: ["podman", "info", "--format", "json"], result: recorded("podman", info) },
      { argv: expected, result: recorded("podman", "run") },
    ]);
    expect((await podmanRuntime(runner).start(spec())).ok).toBe(true);
    expect(runner.calls.at(-1)).toEqual(expected);
  });
}

test("Docker whose daemon cannot apply a CPU quota starts the container without the CPU cap and with the memory cap", async () => {
  const expected = dockerRunArgv(spec(), detection("docker", true, false));
  const runner = new ScriptedRunner([
    { argv: ["docker", "version", "--format", "json"], result: recorded("docker", "version") },
    { argv: ["docker", "info", "--format", "json"], result: recorded("docker", "info-no-cpu-quota") },
    { argv: expected, result: recorded("docker", "run") },
  ]);
  expect((await dockerRuntime(runner).start(spec())).ok).toBe(true);
  expect(runner.calls.at(-1)).toEqual(expected);
  expect(expected).toContain("--memory");
  expect(expected).not.toContain("--cpus");
});
