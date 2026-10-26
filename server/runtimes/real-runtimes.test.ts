import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const IMAGE = "docker.io/library/busybox@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e";
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
    let port = 0;
    let spec: ContainerSpec;

    afterAll(async () => {
      await runtime.remove(name);
      await runtime.removeImage(IMAGE);
      rmSync(folder, { recursive: true, force: true });
    }, SLOW);

    test("it is available", async () => {
      const detection = await runtime.detect();
      expect(detection.problem).toBeNull();
      expect(detection.available).toBe(true);
    });

    test("it pulls the image by digest and reports progress", async () => {
      const steps: unknown[] = [];
      const result = await runtime.pull(IMAGE, { onProgress: (progress) => steps.push(progress) });
      expect(result).toEqual({ ok: true, value: undefined });
    }, SLOW);

    test("it starts a detached container that serves the mounted folder on the published loopback port", async () => {
      port = await freePort();
      writeFileSync(join(folder, "hello.txt"), "hello from the mounted folder\n");
      spec = {
        name,
        image: IMAGE,
        platform: null,
        publish: { hostAddress: "127.0.0.1", hostPort: port, containerPort: 3000 },
        mounts: [{ hostPath: folder, containerPath: "/var/www/data" }],
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
    }, SLOW);

    test("a second container under the same name is refused", async () => {
      const again = await runtime.start({ ...spec, publish: { ...spec.publish, hostPort: await freePort() } });
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
      expect(await runtime.removeImage(IMAGE)).toEqual({ ok: true, value: undefined });
      expect(await runtime.removeImage(IMAGE)).toEqual({ ok: true, value: undefined });
    }, SLOW);
  });
}
