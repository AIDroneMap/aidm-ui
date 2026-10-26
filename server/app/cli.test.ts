import { expect, test } from "bun:test";
import { join } from "node:path";
import { parseCommandLine, parseSetupCommand } from "./cli.ts";

test("no arguments gives no port and no data folder", () => {
  expect(parseCommandLine([])).toEqual({ ok: true, commandLine: {} });
});

test("--port sets the port", () => {
  expect(parseCommandLine(["--port", "9000"])).toEqual({ ok: true, commandLine: { port: 9000 } });
});

test("--data-dir sets the data folder", () => {
  expect(parseCommandLine(["--data-dir", "x"])).toEqual({
    ok: true,
    commandLine: { dataFolder: "x" },
  });
});

test("both flags can be given together", () => {
  expect(parseCommandLine(["--port", "1", "--data-dir", "y"])).toEqual({
    ok: true,
    commandLine: { port: 1, dataFolder: "y" },
  });
});

test("--record-runtime-commands is off by default and on when given", () => {
  expect(parseCommandLine(["--record-runtime-commands"])).toEqual({
    ok: true,
    commandLine: { recordRuntimeCommands: true },
  });
  expect(parseCommandLine(["--port", "9000", "--record-runtime-commands", "--data-dir", "x"])).toEqual({
    ok: true,
    commandLine: { port: 9000, dataFolder: "x", recordRuntimeCommands: true },
  });
});

test("--record-runtime-commands takes no value", () => {
  expect(parseCommandLine(["--record-runtime-commands=yes"]).ok).toBe(false);
});

test.each(["0", "70000", "abc", "-5", "80.5"])("port %s is a problem", (port) => {
  const result = parseCommandLine(["--port", port]);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.problem).toContain("--port");
});

test("an unknown flag is a problem", () => {
  const result = parseCommandLine(["--nope"]);
  expect(result.ok).toBe(false);
});

test("a flag without a value is a problem", () => {
  expect(parseCommandLine(["--port"]).ok).toBe(false);
  expect(parseCommandLine(["--data-dir"]).ok).toBe(false);
});

test("the setup command takes a user name and nothing else", () => {
  expect(parseSetupCommand(["setup-podman", "--user", "alice"])).toEqual({ ok: true, user: "alice" });
  expect(parseSetupCommand(["setup-podman", "--user=alice"])).toEqual({ ok: true, user: "alice" });
});

test("the normal start is not the setup command", () => {
  expect(parseSetupCommand([])).toBeNull();
  expect(parseSetupCommand(["--port", "9000"])).toBeNull();
  expect(parseSetupCommand(["--data-dir", "setup-podman"])).toBeNull();
  // And the setup word is not a normal start either.
  expect(parseCommandLine(["setup-podman", "--user", "alice"]).ok).toBe(false);
});

test.each([
  [["setup-podman"]],
  [["setup-podman", "--user"]],
  [["setup-podman", "--user", "a b"]],
  [["setup-podman", "--user", "-rf"]],
  [["setup-podman", "--user", ""]],
  [["setup-podman", "--user", "a;b"]],
  [["setup-podman", "--user", "alice", "--data-dir", "/x"]],
  [["setup-podman", "--port", "9000"]],
  [["setup-podman", "alice"]],
])("the setup command refuses %p", (argv) => {
  const result = parseSetupCommand(argv);
  expect(result?.ok).toBe(false);
});

test("the program itself refuses a bad user name with exit 2, before it reads any folder", async () => {
  // A bad name is refused before anything runs, so this is safe to start for real.
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "main.ts"), "setup-podman", "--user", "a b"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await proc.exited).toBe(2);
  expect(await new Response(proc.stderr).text()).toContain("--user");
});
