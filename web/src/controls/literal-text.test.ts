import { expect, test } from "bun:test";
import { literalText } from "./literal-text.ts";

test("literal component text and labels are rejected", () => {
  expect(literalText('const C = () => <button title="Save">Save</button>;')).toEqual(["Save", "Save"]);
  expect(literalText('const C = () => <button title={t("save")}>{t("save")}</button>;')).toEqual([]);
  expect(literalText('const C = () => <p>Line one!<br />Line two.</p>;')).toEqual(["Line one!", "Line two."]);
  expect(literalText('const C = () => <p>{"Literal"}</p>;')).toEqual(["Literal"]);
  expect(literalText('const C = () => <TextField label="Name" />;')).toEqual(["Name"]);
});

test("interface components contain no literal text", async () => {
  const files = new Bun.Glob("**/*.tsx");
  const failures: string[] = [];
  for await (const path of files.scan(new URL("..", import.meta.url).pathname)) {
    if (path.endsWith(".test.tsx") || path.endsWith("browser-check.tsx")) continue;
    const found = literalText(await Bun.file(new URL(`../${path}`, import.meta.url)).text());
    if (found.length) failures.push(`${path}: ${found.join(", ")}`);
  }
  expect(failures).toEqual([]);
});
