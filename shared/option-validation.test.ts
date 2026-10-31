import { expect, test } from "bun:test";
import { validateOptionValue } from "./option-validation.ts";
import { validateOptions } from "../server/options/validate.ts";

test("shared and server validation agree on option values", () => {
  const option = { name: "count", type: "int" as const, domain: "positive integer", value: "1", help: "" };
  for (const [value, reason] of [[2, null], [-1, "domain"], [1.5, "type"], [Number.MAX_SAFE_INTEGER + 1, "type"]] as const) {
    expect(validateOptionValue(option.type, option.domain, value)).toBe(reason);
    expect(validateOptions([{ name: option.name, value }], [option])?.reason ?? null).toBe(reason);
  }
});

test("domain grammar fails closed and server retains duplicate and unavailable checks", () => {
  const option = { name: "size", type: "float" as const, domain: "float: 0 <= x <= 1", value: "0", help: "" };
  for (const [domain, value, reason] of [[option.domain, 1, null], [option.domain, 1.1, "domain"], ["mystery", 0, "domain"], ["json", "{", "domain"]] as const) {
    const type = domain === "json" ? "string" : "float";
    expect(validateOptionValue(type, domain, value)).toBe(reason);
    expect(validateOptions([{ name: "size", value }], [{ ...option, type, domain }])?.reason ?? null).toBe(reason);
  }
  expect(validateOptions([{ name: "missing", value: 1 }], [option])?.reason).toBe("unavailable");
  expect(validateOptions([{ name: "size", value: 1 }, { name: "size", value: 1 }], [option])?.reason).toBe("duplicate");
});
