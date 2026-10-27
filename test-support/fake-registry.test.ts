import { afterEach, expect, test } from "bun:test";
import { FakeFileServer } from "./fake-file-server.ts";
import { FakeRegistry } from "./fake-registry.ts";

const REPOSITORY = "aidronemap/aidm-api";

let server: FakeFileServer | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
});

function bytes(length: number, seed: number): Uint8Array<ArrayBuffer> {
  return Uint8Array.from({ length }, (_, index) => (index * 31 + seed) % 251);
}

function sha256(data: Uint8Array): string {
  return `sha256:${new Bun.CryptoHasher("sha256").update(data).digest("hex")}`;
}

async function mount(options: { now?: () => number } = {}) {
  const registry = new FakeRegistry(options);
  const layer = bytes(100_000, 7);
  const image = registry.addImage({ repository: REPOSITORY, config: bytes(300, 3), layers: [layer] });
  const host = new FakeFileServer();
  host.registry = registry;
  server = host;
  await host.start();
  return { registry, image, layer, host };
}

async function getToken(host: FakeFileServer): Promise<string> {
  const response = await fetch(host.url(`/token?service=fake-registry&scope=repository:${REPOSITORY}:pull`));
  expect(response.status).toBe(200);
  const body = (await response.json()) as { token: string };
  return body.token;
}

/** Asks the registry for a blob and returns the signed address it redirects to. */
async function signedAddress(host: FakeFileServer, digest: string): Promise<string> {
  const token = await getToken(host);
  const response = await fetch(host.url(`/v2/${REPOSITORY}/blobs/${digest}`), {
    headers: { authorization: `Bearer ${token}` },
    redirect: "manual",
  });
  expect(response.status).toBe(307);
  const location = response.headers.get("location");
  expect(location).toContain("/signed/");
  return location ?? "";
}

test("the registry asks for a token, then serves a manifest that hashes to its digest", async () => {
  const { image, host } = await mount();
  const manifestPath = `/v2/${REPOSITORY}/manifests/${image.digest}`;

  const refused = await fetch(host.url(manifestPath), { redirect: "manual" });
  expect(refused.status).toBe(401);
  expect(refused.headers.get("www-authenticate")).toBe(
    `Bearer realm="${host.url("/token")}",service="fake-registry",scope="repository:${REPOSITORY}:pull"`,
  );

  const token = await getToken(host);
  const response = await fetch(host.url(manifestPath), {
    headers: { authorization: `Bearer ${token}` },
    redirect: "manual",
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("docker-content-digest")).toBe(image.digest);
  const body = new Uint8Array(await response.arrayBuffer());
  expect(sha256(body)).toBe(image.digest);
  expect(body).toEqual(new Uint8Array(image.manifest));
});

test("a blob request redirects to a signed address that serves the bytes", async () => {
  const { registry, image, layer, host } = await mount();
  const digest = image.layerDigests[0] ?? "";

  const location = await signedAddress(host, digest);
  expect(registry.redirects(digest)).toBe(1);

  const response = await fetch(location, { redirect: "manual" });
  expect(response.status).toBe(200);
  expect(response.headers.get("accept-ranges")).toBe("bytes");
  const body = new Uint8Array(await response.arrayBuffer());
  expect(body).toEqual(layer);
  expect(sha256(body)).toBe(digest);
});

test("a signed address refuses an Authorization header", async () => {
  const { image, host } = await mount();
  const location = await signedAddress(host, image.layerDigests[0] ?? "");

  const response = await fetch(location, { headers: { authorization: "Bearer tok-1" }, redirect: "manual" });
  expect(response.status).toBe(400);
});

test("a signed address stops working after its lifetime", async () => {
  let clock = 1_000_000;
  const { image, host } = await mount({ now: () => clock });
  const location = await signedAddress(host, image.layerDigests[0] ?? "");

  expect((await fetch(location, { redirect: "manual" })).status).toBe(200);
  clock += 60_001;
  expect((await fetch(location, { redirect: "manual" })).status).toBe(403);
});

test("a range request gets a 206 with the right bytes, and a start past the end gets 416", async () => {
  const { image, layer, host } = await mount();
  const location = await signedAddress(host, image.layerDigests[0] ?? "");

  const response = await fetch(location, { headers: { range: "bytes=1000-1999" }, redirect: "manual" });
  expect(response.status).toBe(206);
  expect(response.headers.get("content-range")).toBe(`bytes 1000-1999/${layer.length}`);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(layer.subarray(1000, 2000));

  const past = await fetch(location, { headers: { range: `bytes=${layer.length}-` }, redirect: "manual" });
  expect(past.status).toBe(416);
  expect(past.headers.get("content-range")).toBe(`bytes */${layer.length}`);
});

test("resetEveryMs cuts a slow body before its end", async () => {
  const { registry, image, layer, host } = await mount();
  const location = await signedAddress(host, image.layerDigests[0] ?? "");
  // About 4 chunks a second, cut after 300 ms, so far less than the 7 chunks of the layer arrive.
  registry.bytesPerSecond = 64 * 1024;
  registry.resetEveryMs = 300;

  let received = 0;
  try {
    const response = await fetch(location, { redirect: "manual" });
    const reader = response.body?.getReader();
    for (;;) {
      const next = await reader?.read();
      if (next === undefined || next.done) break;
      received += next.value.length;
    }
  } catch {
    // The connection was reset, which is the point.
  }
  expect(received).toBeLessThan(layer.length);
});

test("corruptNext changes the hash of one response only", async () => {
  const { registry, image, host } = await mount();
  const digest = image.layerDigests[0] ?? "";
  const location = await signedAddress(host, digest);
  registry.corruptNext(digest);

  const first = new Uint8Array(await (await fetch(location, { redirect: "manual" })).arrayBuffer());
  expect(sha256(first)).not.toBe(digest);
  const second = new Uint8Array(await (await fetch(location, { redirect: "manual" })).arrayBuffer());
  expect(sha256(second)).toBe(digest);
});
