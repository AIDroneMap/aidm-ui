import { expect, test } from "bun:test";
import { DATA_FOLDER_ENV, resolveDataFolder, type DataFolderInputs } from "./data-folder.ts";

function inputs(overrides: Partial<DataFolderInputs>): DataFolderInputs {
  return { platform: "linux", env: {}, homeDir: "/home/op", cwd: "/work", ...overrides };
}

test("linux uses the home folder when XDG_DATA_HOME is not set", () => {
  expect(resolveDataFolder(inputs({}))).toBe("/home/op/.local/share/aidm-ui");
});

test("linux uses XDG_DATA_HOME when it is set", () => {
  const env = { XDG_DATA_HOME: "/data/xdg" };
  expect(resolveDataFolder(inputs({ env }))).toBe("/data/xdg/aidm-ui");
});

test("linux ignores a relative XDG_DATA_HOME", () => {
  const env = { XDG_DATA_HOME: "relative/xdg" };
  expect(resolveDataFolder(inputs({ env }))).toBe("/home/op/.local/share/aidm-ui");
});

test("darwin uses Application Support", () => {
  expect(resolveDataFolder(inputs({ platform: "darwin", homeDir: "/Users/op" }))).toBe(
    "/Users/op/Library/Application Support/aidm-ui",
  );
});

test("win32 uses LOCALAPPDATA when it is set", () => {
  const folder = resolveDataFolder(
    inputs({
      platform: "win32",
      homeDir: "C:\\Users\\op",
      cwd: "C:\\work",
      env: { LOCALAPPDATA: "D:\\Local" },
    }),
  );
  expect(folder).toBe("D:\\Local\\aidm-ui");
});

test("win32 falls back to AppData\\Local under the home folder", () => {
  const folder = resolveDataFolder(
    inputs({ platform: "win32", homeDir: "C:\\Users\\op", cwd: "C:\\work" }),
  );
  expect(folder).toBe("C:\\Users\\op\\AppData\\Local\\aidm-ui");
});

test("the environment variable beats the platform default", () => {
  const env = { [DATA_FOLDER_ENV]: "/srv/aidm" };
  expect(resolveDataFolder(inputs({ env }))).toBe("/srv/aidm");
});

test("the flag beats the environment variable", () => {
  const env = { [DATA_FOLDER_ENV]: "/srv/aidm" };
  expect(resolveDataFolder(inputs({ env, flag: "/srv/other" }))).toBe("/srv/other");
});

test("a relative flag is resolved against the working folder", () => {
  expect(resolveDataFolder(inputs({ flag: "here/data" }))).toBe("/work/here/data");
});

test("a relative environment value is resolved against the working folder", () => {
  const env = { [DATA_FOLDER_ENV]: "data" };
  expect(resolveDataFolder(inputs({ env }))).toBe("/work/data");
});

test("an empty environment value counts as not set", () => {
  const env = { [DATA_FOLDER_ENV]: "", XDG_DATA_HOME: "" };
  expect(resolveDataFolder(inputs({ env }))).toBe("/home/op/.local/share/aidm-ui");
});
