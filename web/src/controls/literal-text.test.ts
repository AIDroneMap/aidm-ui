import { expect, test } from "bun:test";
import { literalText, literalTexts } from "./literal-text.ts";

test("literal component text and labels are rejected", async () => {
  expect(await literalText('const C = () => <button title="Save">Save</button>;')).toEqual(["Save", "Save"]);
  expect(await literalText('const C = () => <button title={t("save")}>{t("save")}</button>;')).toEqual([]);
  expect(await literalText('const C = () => <p>Line one!<br />Line two.</p>;')).toEqual(["Line one!", "Line two."]);
  expect(await literalText('const C = () => <p>{"Literal"}</p>;')).toEqual(["Literal"]);
  expect(await literalText('const C = () => <TextField label="Name" />;')).toEqual(["Name"]);
});

test("interface components contain no literal text", async () => {
  const files = new Bun.Glob("**/*.tsx");
  const paths: string[] = [];
  for await (const path of files.scan(new URL("..", import.meta.url).pathname)) {
    if (!path.endsWith(".test.tsx") && !path.endsWith("browser-check.tsx")) paths.push(path);
  }
  const sources = await Promise.all(paths.map((path) => Bun.file(new URL(`../${path}`, import.meta.url)).text()));
  const results = await literalTexts(sources);
  const failures = results.flatMap((found, index) => found.length ? [`${paths[index]}: ${found.join(", ")}`] : []);
  expect(failures).toEqual([]);
});

test("computed text rejects literals in output branches but permits data and translation lookups", async () => {
  const source = `const C = ({ flag, value, error }) => <>
    <p>{flag ? "Ready" : t("waiting")}</p>
    <p>{flag && "Pending"}</p>
    <p>{flag ? value : error.message}</p>
    <code>{\`http://\${value}:\${port}/\`}</code>
    <p>{\`http://\${value} Hello\`}</p>
    <p>{t("message", { name: value, code: "engine" })}</p>
    <p>{\`Hello \${value}\`}</p>
    <button title={flag ? "Open" : t("close")} aria-label={flag && "More"} data-kind="static" className="field">{value}</button>
  </>`;
  expect(await literalText(source)).toEqual(["Ready", "Pending", " Hello", "Hello ", "Open", "More"]);
});

test("nested output expressions are checked without treating conditions and lookup arguments as text", async () => {
  const source = `const C = ({ state, count, data }) => <>
    <p>{state === "ready" ? (count + " photos") : (data.name ?? "Unknown")}</p>
    <p>{[t("first"), state && "Second"]}</p>
    <input aria-description={state ? \`Status: \${state}\` : t("status")} value={"field value"} type="text" />
  </>`;
  expect(await literalText(source)).toEqual([" photos", "Unknown", "Second", "Status: "]);
});
