import { expect, test } from "bun:test";
import { applyTheme, chooseTheme, storedTheme, THEME_KEY } from "./theme.ts";

function memory(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    values,
  };
}

function root() {
  const attributes = new Map<string, string>();
  return {
    setAttribute: (name: string, value: string) => void attributes.set(name, value),
    removeAttribute: (name: string) => void attributes.delete(name),
    attributes,
  };
}

test("with nothing kept, the theme follows the device", () => {
  expect(storedTheme(memory())).toBe("system");
});

test("a kept choice is read back, and anything else counts as following the device", () => {
  expect(storedTheme(memory({ [THEME_KEY]: "dark" }))).toBe("dark");
  expect(storedTheme(memory({ [THEME_KEY]: "light" }))).toBe("light");
  expect(storedTheme(memory({ [THEME_KEY]: "sepia" }))).toBe("system");
});

test("a browser that refuses storage still gets a theme", () => {
  const refusing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }, removeItem: () => { throw new Error("denied"); } };
  expect(storedTheme(refusing)).toBe("system");
  const page = root();
  chooseTheme("dark", refusing, page);
  expect(page.attributes.get("data-theme")).toBe("dark");
});

test("light and dark fix the page, and following the device lets go of it", () => {
  const page = root();
  applyTheme("dark", page);
  expect(page.attributes.get("data-theme")).toBe("dark");
  applyTheme("light", page);
  expect(page.attributes.get("data-theme")).toBe("light");
  applyTheme("system", page);
  expect(page.attributes.has("data-theme")).toBe(false);
});

test("a choice is kept in the browser in both directions, and following the device forgets it", () => {
  const storage = memory(), page = root();
  chooseTheme("dark", storage, page);
  expect(storedTheme(storage)).toBe("dark");
  chooseTheme("light", storage, page);
  expect(storedTheme(storage)).toBe("light");
  expect(page.attributes.get("data-theme")).toBe("light");
  chooseTheme("system", storage, page);
  expect(storage.values.has(THEME_KEY)).toBe(false);
  expect(page.attributes.has("data-theme")).toBe(false);
});
