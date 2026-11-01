import { expect, test } from "bun:test";
import { linuxInputs, recordedMachine } from "../../test-support/recorded-machine.ts";
import { openHarness } from "../testing/harness.ts";
import legacy from "./builtin/2.5.0.json";
import type { ManifestVariant } from "./schema.ts";

for (const machine of [
  { name: "Linux x64", platform: "linux", arch: "x64", variant: "linux-amd64-cpu", size: 573636504 },
  { name: "Apple silicon", platform: "darwin", arch: "arm64", variant: "linux-arm64-cpu", size: 510384603 },
] as const) {
  test(`a fresh ${machine.name} install offers the published API and engine without a release refresh`, async () => {
    const requests: string[] = [];
    const h = openHarness({
      machine: recordedMachine(linuxInputs({ platform: machine.platform, arch: machine.arch })),
      manifest: {
        fetch: async (url) => {
          requests.push(url);
          throw new Error("No release lookup was requested by the operator");
        },
      },
    });
    try {
      const response = await fetch(`${h.base}/api/packages`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        offer: {
          packageVersion: "2.7.0",
          engineVersion: "0.2.0",
          variant: machine.variant,
          size: machine.size,
          source: "builtin",
        },
        reason: null,
      });
      const held = await h.manifests.held();
      expect(held.manifest.sequence).toBe(2007000);
      expect(held.manifest.variants[machine.variant]).toMatchObject({ taskApiSocket: true });
      expect(requests).toEqual([]);
    } finally {
      await h.stop();
    }
  });
}

test("a remembered older installation gets the current update offer without a refresh or silent replacement", async () => {
  const h = openHarness();
  const previous = {
    packageVersion: "2.5.0",
    variant: "linux-amd64-cpu" as const,
    runtime: "podman" as const,
    container: legacy.variants["linux-amd64-cpu"] as Extract<ManifestVariant, { kind: "container" }>,
  };
  try {
    h.settings.set("local.enabled", false);
    h.settings.set("local.package", previous);
    h.engineStore.addLocal({ name: "Local engine", token: "test-only-token", packageKind: "container", installedVersion: "2.5.0" });
    const response = await fetch(`${h.base}/api/local-engine`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      installed: { packageVersion: "2.5.0" },
      update: { available: { packageVersion: "2.7.0", size: 573636504 } },
    });
    expect(h.settings.get("local.package")).toEqual(previous);
    expect(h.runtimes.podman?.starts).toEqual([]);
    expect(h.images.downloads).toEqual([]);
  } finally {
    await h.stop();
  }
});
