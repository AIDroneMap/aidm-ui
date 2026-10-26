import { expect, test } from "bun:test";
import { parseCommandLine } from "./cli.ts";

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
