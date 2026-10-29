import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import en from "./i18n/en.json";
import { App } from "./App.tsx";
import { Layout } from "./components/Layout.tsx";
import { HomePage } from "./pages/HomePage.tsx";
import { textNodes, untranslatedText } from "./test-helpers.ts";

test("the home page shows only text from the translation file", () => {
  const html = renderToStaticMarkup(
    <Layout route="home">
      <HomePage onAuthRequired={() => {}} />
    </Layout>,
  );
  expect(untranslatedText(html)).toEqual([]);
  expect(textNodes(html)).toContain(en["projects.loading"]);
});

test("the navigation marks the current page", () => {
  const html = renderToStaticMarkup(
    <Layout route="settings">
      <p />
    </Layout>,
  );
  expect(html).toContain('<a href="#/settings" aria-current="page">Settings</a>');
  expect(html).not.toContain('<a href="#/" aria-current');
});

test("before the session answer, the app only says it is loading", () => {
  const html = renderToStaticMarkup(<App />);
  expect(textNodes(html)).toEqual([en["app.loading"]]);
});
