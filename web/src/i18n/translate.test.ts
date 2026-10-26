import { expect, test } from "bun:test";
import { t } from "./translate.ts";

test("a known key returns its text", () => {
  expect(t("home.title")).toBe("AIDM UI is running");
});

test("an unknown key is shown as the key itself", () => {
  expect(t("no.such.key")).toBe("no.such.key");
});
