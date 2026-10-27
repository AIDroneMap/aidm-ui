import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadImage, localName, type DownloadedImage } from "../images/image-download.ts";
import { systemRunner } from "../process/command-runner.ts";
import { dockerRuntime } from "./docker.ts";
import { podmanRuntime } from "./podman.ts";
import type { ContainerRuntime, ContainerSpec } from "./runtime.ts";

// These tests drive the real tools, so they run only where AIDM_REAL_RUNTIMES
// names them ("podman", "docker" or "podman,docker"). The image is a tiny
// public one (busybox 1.37), never the engine image.
const requested = (process.env.AIDM_REAL_RUNTIMES ?? "")
  .split(",")
  .map((name) => name.trim())
  .filter((name) => name !== "");

// The linux/amd64 manifest of the busybox index at
// docker.io/library/busybox@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e.
// aidm-ui downloads a manifest and not an index, so the manifest is pinned.
const PINNED = {
  repository: "docker.io/library/busybox",
  digest: "sha256:66a6306db78bf2dbf3487f293aa8d6990d8e506fdffab9cc43fe422becf886e4",
};
/** The name the runtime keeps the loaded image under. */
const IMAGE_NAME = localName(PINNED);
const SLOW = 180_000;

async function freePort(): Promise<number> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = server.port as number;
  await server.stop(true);
  return port;
}

async function eventually<T>(attempt: () => Promise<T | undefined>, seconds = 10): Promise<T | undefined> {
  const until = Date.now() + seconds * 1000;
  for (;;) {
    const value = await attempt().catch(() => undefined);
    if (value !== undefined || Date.now() > until) return value;
    await Bun.sleep(250);
  }
}

const makers: Record<string, (runner: ReturnType<typeof systemRunner>) => ContainerRuntime> = {
  podman: podmanRuntime,
  docker: dockerRuntime,
};

for (const id of ["podman", "docker"]) {
  describe.skipIf(!requested.includes(id))(`the real ${id}`, () => {
    const runtime = (makers[id] as (runner: ReturnType<typeof systemRunner>) => ContainerRuntime)(systemRunner());
    const name = `aidm-ui-ci-${crypto.randomUUID().slice(0, 8)}`;
    const folder = mkdtempSync(join(tmpdir(), "aidm-ui-ci-"));
    chmodSync(folder, 0o755);
    const settingsFolder = mkdtempSync(join(tmpdir(), "aidm-ui-ci-settings-"));
    chmodSync(settingsFolder, 0o755);
    const downloadFolder = mkdtempSync(join(tmpdir(), "aidm-ui-ci-image-"));
    let image: DownloadedImage | undefined;
    /** What the runtime says to run the loaded image by. */
    let reference = "";
    let port = 0;
    let spec: ContainerSpec;

    afterAll(async () => {
      await runtime.remove(name);
      await runtime.removeImage(image?.name ?? IMAGE_NAME);
      rmSync(folder, { recursive: true, force: true });
      rmSync(settingsFolder, { recursive: true, force: true });
      rmSync(downloadFolder, { recursive: true, force: true });
    }, SLOW);

    test("it is available", async () => {
      const detection = await runtime.detect();
      if (!detection.available) {
        // Show the tool's own answers, so a failure on a runner can be read from the log.
        for (const argv of [[id, "version", "--format", "json"], [id, "info", "--format", "json"]]) {
          const answer = await systemRunner().run(argv, { timeoutMs: 120_000 });
          console.log(`${argv.join(" ")} exited ${answer.exitCode}`);
          console.log(answer.stdout.slice(0, 4000));
          console.log(answer.stderr.slice(0, 4000));
        }
      }
      expect(detection.problem).toBeNull();
      expect(detection.available).toBe(true);
    }, SLOW);

    test("it downloads the image by digest, loads it, and verifies that the runtime holds it", async () => {
      // This reaches the real Docker Hub, which hands out a token for the repository first.
      const progress: unknown[] = [];
      const download = () => downloadImage(PINNED, downloadFolder, { onProgress: (step) => progress.push(step) });
      let downloaded = await download();
      if (!downloaded.ok) {
        // A registry may refuse a shared runner for a while, so one more try after a short wait.
        await Bun.sleep(10_000);
        downloaded = await download();
      }
      expect(downloaded.ok).toBe(true);
      if (!downloaded.ok) return;
      image = downloaded.image;
      expect(image.name).toBe(IMAGE_NAME);
      expect(progress.length).toBeGreaterThan(0);

      expect(await runtime.load(image)).toEqual({ ok: true, value: undefined });
      const verified = await runtime.verifyImage(image);
      expect(verified.ok).toBe(true);
      if (verified.ok) reference = verified.value;
      expect(reference).not.toBe("");
    }, SLOW);

    test("it starts a detached container that serves the mounted folder on the published loopback port", async () => {
      port = await freePort();
      writeFileSync(join(folder, "hello.txt"), "hello from the mounted folder\n");
      writeFileSync(join(settingsFolder, "settings.txt"), "read-only settings\n");
      // The mount point exists beforehand, so the runtime does not create it as another user.
      mkdirSync(join(folder, "settings"));
      spec = {
        name,
        image: reference,
        platform: null,
        publish: { hostAddress: "127.0.0.1", hostPort: port, containerPort: 3000 },
        mounts: [
          { hostPath: folder, containerPath: "/var/www/data", readOnly: false },
          { hostPath: settingsFolder, containerPath: "/var/www/data/settings", readOnly: true },
        ],
        memoryBytes: 256 * 1024 ** 2,
        cpus: 1,
        gpu: false,
        args: ["httpd", "-f", "-v", "-p", "3000", "-h", "/var/www/data"],
      };
      const started = await runtime.start(spec);
      expect(started.ok).toBe(true);
      if (started.ok) expect(started.value.containerId).toMatch(/^[0-9a-f]{12,64}$/);

      const text = await eventually(async () => {
        const response = await fetch(`http://127.0.0.1:${port}/hello.txt`);
        return response.ok ? await response.text() : undefined;
      });
      expect(text).toBe("hello from the mounted folder\n");

      const settings = await fetch(`http://127.0.0.1:${port}/settings/settings.txt`);
      expect(await settings.text()).toBe("read-only settings\n");

      // The tool's own inspect command says the folder is read-only.
      const inspect = id === "podman" ? ["podman", "container", "inspect", name] : ["docker", "inspect", "--type", "container", name];
      const inspecting = Bun.spawn(inspect, { stdout: "pipe", stderr: "pipe" });
      const details = JSON.parse(await new Response(inspecting.stdout).text()) as Array<{
        Mounts: Array<{ Destination: string; RW: boolean }>;
      }>;
      const mounts = details[0]?.Mounts ?? [];
      expect(mounts.find((mount) => mount.Destination === "/var/www/data/settings")?.RW).toBe(false);
      expect(mounts.find((mount) => mount.Destination === "/var/www/data")?.RW).toBe(true);
    }, SLOW);

    test("a second container under the same name is refused", async () => {
      const again = await runtime.start({ ...spec, publish: { hostAddress: "127.0.0.1", containerPort: 3000, hostPort: await freePort() } });
      expect(again).toEqual({ ok: false, error: { code: "runtime.name_in_use", data: { name } } });
    }, SLOW);

    test("its status is running", async () => {
      expect(await runtime.status(name)).toEqual({
        ok: true,
        value: { state: "running", exitCode: null, oomKilled: false },
      });
    });

    test("its log holds a line from the web server", async () => {
      const lines = await eventually(async () => {
        const seen: string[] = [];
        const result = await runtime.logs(name, { follow: false, tail: 20, onLine: (line) => seen.push(line) });
        return result.ok && seen.length > 0 ? seen : undefined;
      });
      expect(lines?.some((line) => line.includes("response:200"))).toBe(true);
    }, SLOW);

    test("it stops, and the status is stopped", async () => {
      expect(await runtime.stop(name, 2)).toEqual({ ok: true, value: undefined });
      const status = await runtime.status(name);
      expect(status.ok && status.value.state).toBe("stopped");
    }, SLOW);

    test("it removes the container, and the status is missing", async () => {
      expect(await runtime.remove(name)).toEqual({ ok: true, value: undefined });
      expect(await runtime.status(name)).toEqual({
        ok: true,
        value: { state: "missing", exitCode: null, oomKilled: null },
      });
      expect(await runtime.remove(name)).toEqual({ ok: true, value: undefined });
    }, SLOW);

    test("it removes the image, and removing it again is fine", async () => {
      const loadedName = image?.name ?? IMAGE_NAME;
      expect(await runtime.removeImage(loadedName)).toEqual({ ok: true, value: undefined });
      expect(await runtime.removeImage(loadedName)).toEqual({ ok: true, value: undefined });
    }, SLOW);
  });
}
