import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiFailure } from "../api.ts";
import { untranslatedText, unlabelledInputs } from "../test-helpers.ts";
import { LoginView } from "./LoginPage.tsx";

function render(failure: ApiFailure | null): string {
  return renderToStaticMarkup(
    <LoginView passphrase="" onPassphraseChange={() => {}} failure={failure} signingIn={false} onSubmit={() => {}} />,
  );
}

test("the passphrase field is a labelled password input", () => {
  const html = render(null);
  expect(html).toContain('<label for="login-passphrase">Passphrase</label>');
  expect(html).toContain('type="password"');
  expect(unlabelledInputs(html)).toEqual([]);
  expect(untranslatedText(html)).toEqual([]);
});

test("a wrong passphrase shows its text in an alert", () => {
  const html = render(new ApiFailure(401, "auth.passphrase_wrong"));
  expect(html).toContain('role="alert"');
  expect(html).toContain("That passphrase is not right. Check it and try again.");
  expect(untranslatedText(html)).toEqual([]);
});
