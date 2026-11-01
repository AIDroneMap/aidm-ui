import { expect, test } from "bun:test";
import { join } from "node:path";
import { verifyBuiltinManifest } from "./builtin.ts";
import { ACCEPTED_KEYS } from "./keys.ts";
import { releaseKeyProblems } from "./verify.ts";

const root = join(import.meta.dir, "../..");

async function buildScript(...args: string[]): Promise<{ code: number; output: string }> {
  const child = Bun.spawn([process.execPath, "scripts/build.ts", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, output: out + err };
}

test("a build is a release build unless it says otherwise, and today's keys let it go ahead", async () => {
  const result = await buildScript("--check-keys-only");
  expect(result.output).not.toContain("test key");
  expect(result.output).toContain("Release key check passed.");
  expect(result.code).toBe(0);
});

test("only the publisher's release key is accepted", () => {
  expect(ACCEPTED_KEYS.map((key) => key.id)).toEqual(["api-release-2026"]);
  expect(ACCEPTED_KEYS.some((key) => key.test)).toBe(false);
});

test("the release check still refuses a test key and names the flag that skips it", () => {
  const withTestKey = [...ACCEPTED_KEYS, { id: "development-test-key", publicKey: "/ZvJB2b6/5SBwz1giwTJS3e8x8KvLyrAeYIrzGNoYck=", test: true }];
  expect(releaseKeyProblems(withTestKey, "api-release-2026")).toEqual(['The accepted key "development-test-key" is a test key.']);
  expect(releaseKeyProblems(withTestKey, "development-test-key")).toContain('The built-in manifest entry is signed with the test key "development-test-key".');
});

test("a default build names every problem the key check finds", async () => {
  const builtin = await verifyBuiltinManifest();
  const problems = releaseKeyProblems(ACCEPTED_KEYS, builtin.ok ? builtin.keyId : null);
  const result = await buildScript("--check-keys-only");
  for (const problem of problems) expect(result.output).toContain(problem);
});

test("a development build does not run the key check", async () => {
  const result = await buildScript("--development", "--check-keys-only");
  expect(result.code).toBe(0);
  expect(result.output).not.toContain("test key");
});

test("the old --release flag is not known any more", async () => {
  expect((await buildScript("--release", "--check-keys-only")).code).toBe(2);
});

test("an unknown flag is refused before anything is built", async () => {
  expect((await buildScript("--relase")).code).toBe(2);
});
