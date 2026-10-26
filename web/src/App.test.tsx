import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import en from "./i18n/en.json";
import { App } from "./App.tsx";

test("the placeholder page shows only text from the translation file", () => {
  const html = renderToStaticMarkup(<App />);
  const texts = [...html.matchAll(/>([^<]+)</g)].map((match) => (match[1] ?? "").trim()).filter(Boolean);
  expect(texts).toEqual([en["home.title"], en["home.body"]]);
});
