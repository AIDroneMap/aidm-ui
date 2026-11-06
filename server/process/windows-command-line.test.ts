import { expect, test } from "bun:test";
import { windowsCommandLine } from "../../test-support/windows-command-line.ts";
import { splitWindowsCommandLine } from "./windows-command-line.ts";

test("a quoted path with a space is one argument, without its quotes", () => {
  expect(
    splitWindowsCommandLine(
      '"C:\\Users\\Field Operator\\AppData\\Local\\aidm-ui\\engine-packages\\2.7.0\\aidm-api.exe" --config "C:\\Users\\Field Operator\\AppData\\Local\\aidm-ui\\engine-config\\native-2.7.0.json" --test',
    ),
  ).toEqual([
    "C:\\Users\\Field Operator\\AppData\\Local\\aidm-ui\\engine-packages\\2.7.0\\aidm-api.exe",
    "--config",
    "C:\\Users\\Field Operator\\AppData\\Local\\aidm-ui\\engine-config\\native-2.7.0.json",
    "--test",
  ]);
});

test("arguments without quotes are split on spaces and tabs, and runs of them count once", () => {
  expect(splitWindowsCommandLine("C:\\aidm\\aidm-api.exe  --config\tC:\\a\\b.json   ")).toEqual(["C:\\aidm\\aidm-api.exe", "--config", "C:\\a\\b.json"]);
  expect(splitWindowsCommandLine("")).toEqual([]);
});

test("backslashes are plain except before a quote, where each pair gives one and an odd one makes the quote plain", () => {
  expect(splitWindowsCommandLine('a.exe C:\\work\\ "C:\\with space\\\\" x\\"y "a\\\\\\"b"')).toEqual([
    "a.exe",
    "C:\\work\\",
    "C:\\with space\\",
    'x"y',
    'a\\"b',
  ]);
});

test("a quote may start in the middle of an argument, and two quotes inside a quoted part give one", () => {
  expect(splitWindowsCommandLine('a.exe --config="C:\\a b\\c.json" "say ""hi"""')).toEqual(["a.exe", "--config=C:\\a b\\c.json", 'say "hi"']);
});

test("the program runs to its closing quote and keeps its backslashes", () => {
  expect(splitWindowsCommandLine('"C:\\Program Files\\x\\" --config b')).toEqual(["C:\\Program Files\\x\\", "--config", "b"]);
  expect(splitWindowsCommandLine("C:\\x\\a.exe")).toEqual(["C:\\x\\a.exe"]);
});

test("an argument list quoted the way Windows programs expect splits back to the same list", () => {
  const argv = ["C:\\Users\\Field Operator\\aidm-api.exe", "--config", "C:\\Users\\Field Operator\\cfg.json", "", 'say "hi"', "C:\\end with space\\", "plain"];
  expect(splitWindowsCommandLine(windowsCommandLine(argv))).toEqual(argv);
});
