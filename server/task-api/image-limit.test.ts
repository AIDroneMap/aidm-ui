import { expect, test } from "bun:test";
import { FakeTaskApi } from "../../test-support/fake-task-api.ts";
import { TaskClient } from "./task-client.ts";

test("reported image limits preserve a finite limit, no limit and an unknown value", async () => {
  const fake = new FakeTaskApi();
  await fake.start();
  try {
    const client = new TaskClient({ address: fake.address, token: fake.token });
    for (const [raw, expected] of [[12, 12], [null, null], [-1, undefined], ["12", undefined], [undefined, undefined]] as const) {
      fake.info.maxImages = raw;
      const result = await client.info();
      expect(result.ok).toBe(true);
      if (result.ok) expect((result.value as { maxImages?: number | null }).maxImages).toBe(expected);
    }
  } finally { await fake.stop(); }
});
