import { afterEach, expect, test } from "bun:test";
import { eventually, lanAddress, openHarness, type Harness } from "../testing/harness.ts";
import { SESSION_COOKIE } from "../auth/sessions.ts";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const lan = lanAddress();
const PASSPHRASE = "tablet-on-the-field";

async function readFirst(response: Response): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const first = await reader.read();
  expect(first.done).toBe(false);
  return reader;
}

/** True when the stream ends within the time, false when it is still open. */
async function endsWithin(reader: ReadableStreamDefaultReader<Uint8Array>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const left = deadline - Date.now();
    const chunk = await Promise.race([reader.read(), Bun.sleep(left).then(() => "open" as const)]);
    if (chunk === "open") return false;
    if (chunk.done) return true;
  }
  return false;
}

test("at most 32 event streams are open, and a closed one frees its place", async () => {
  harness = openHarness();
  const url = `${harness.base}/api/engines/events`;
  const open: Response[] = [];
  try {
    for (let i = 0; i < 32; i++) {
      const response = await fetch(url);
      expect(response.status).toBe(200);
      open.push(response);
    }
    const extra = await fetch(url);
    expect(extra.status).toBe(503);
    expect(await extra.json()).toEqual({ error: { code: "api.too_many_streams", data: {} } });

    await (open.shift() as Response).body?.cancel();
    await eventually(async () => {
      const response = await fetch(url);
      if (response.status === 200) {
        open.push(response);
        return true;
      }
      await response.body?.cancel();
      return false;
    });
  } finally {
    await Promise.all(open.map((response) => response.body?.cancel()));
  }
});

test.skipIf(lan === undefined)("ending the sessions closes the streams of other computers and keeps the operator's own", async () => {
  harness = openHarness({ hostname: "0.0.0.0" });
  const lanSwitch = (passphrase: string) =>
    fetch(`${harness?.base}/api/settings/lan`, { method: "PUT", body: JSON.stringify({ enabled: true, passphrase }) });
  expect((await lanSwitch(PASSPHRASE)).status).toBe(200);

  const remote = `http://${lan}:${harness.port}`;
  const login = await fetch(`${remote}/api/auth/login`, { method: "POST", body: JSON.stringify({ passphrase: PASSPHRASE }) });
  expect(login.status).toBe(204);
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  expect(cookie).toContain(SESSION_COOKIE);

  const tablet = await fetch(`${remote}/api/engines/events`, { headers: { cookie } });
  expect(tablet.status).toBe(200);
  const tabletReader = await readFirst(tablet);
  const own = await fetch(`${harness.base}/api/engines/events`);
  const ownReader = await readFirst(own);

  expect((await lanSwitch("another-passphrase")).status).toBe(200);

  expect(await endsWithin(tabletReader, 3000)).toBe(true);
  expect(await endsWithin(ownReader, 300)).toBe(false);
  await ownReader.cancel();
});
