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

test("a release build refuses the test key and passes once only production keys remain", async () => {
  const builtin = await verifyBuiltinManifest();
  const problems = releaseKeyProblems(ACCEPTED_KEYS, builtin.ok ? builtin.keyId : null);
  const result = await buildScript("--release", "--check-keys-only");
  expect(result.code).toBe(problems.length === 0 ? 0 : 1);
  if (problems.length > 0) {
    for (const problem of problems) expect(result.output).toContain(problem);
  }
  // While the development key is accepted, this is the line that fails the build.
  if (ACCEPTED_KEYS.some((key) => key.test)) expect(result.code).toBe(1);
});

test("a development build does not run the key check", async () => {
  const result = await buildScript("--check-keys-only");
  expect(result.code).toBe(0);
  expect(result.output).not.toContain("test key");
});

test("an unknown flag is refused before anything is built", async () => {
  expect((await buildScript("--relase")).code).toBe(2);
});
