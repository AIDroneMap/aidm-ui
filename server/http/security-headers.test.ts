import { expect, test } from "bun:test";
import { withSecurityHeaders } from "./security-headers.ts";

test("every response gets the security headers", () => {
  const response = withSecurityHeaders(new Response("ok"));
  const csp = response.headers.get("content-security-policy") ?? "";
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("img-src 'self' data: blob:");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("form-action 'self'");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
});

test("the policy never names another origin", () => {
  const csp = withSecurityHeaders(new Response("ok")).headers.get("content-security-policy") ?? "";
  expect(csp).not.toMatch(/https?:/);
  expect(csp).not.toContain("*");
});

test("headers can be set on a response that already has headers", () => {
  const response = withSecurityHeaders(new Response("ok", { headers: { "x-keep": "1" } }));
  expect(response.headers.get("x-keep")).toBe("1");
});
