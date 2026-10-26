import { expect, test } from "bun:test";
import { openerCommand } from "./open-browser.ts";

const url = "http://127.0.0.1:8823/";

test("linux opens the browser with xdg-open", () => {
  expect(openerCommand("linux", url)).toEqual(["xdg-open", url]);
});

test("darwin opens the browser with open", () => {
  expect(openerCommand("darwin", url)).toEqual(["open", url]);
});

test("win32 opens the browser with cmd start", () => {
  expect(openerCommand("win32", url)).toEqual(["cmd", "/c", "start", "", url]);
});

test("other platforms use xdg-open", () => {
  expect(openerCommand("freebsd", url)).toEqual(["xdg-open", url]);
});
