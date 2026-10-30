import { expect, test } from "bun:test";
import { withSecurityHeaders } from "./security-headers.ts";

test("every response gets the security headers", () => {
  const response = withSecurityHeaders(new Response("ok"));
  const csp = response.headers.get("content-security-policy") ?? "";
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("img-src 'self' data: blob:");
  expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
  expect(csp).toContain("worker-src 'self' blob:");
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

test("only a valid enabled basemap adds its fixed origin", () => {
  const value = { enabled: true, url: "http://tiles.example:8080/{z}/{x}/{y}?token=secret", scheme: "xyz" as const, attribution: "" };
  const policy = (setting: typeof value) => withSecurityHeaders(new Response(), setting).headers.get("content-security-policy") ?? "";
  expect(policy(value)).toContain("connect-src 'self' http://tiles.example:8080");
  expect(policy(value)).toContain("img-src 'self' data: blob: http://tiles.example:8080");
  expect(policy(value)).not.toContain("token=secret");
  expect(policy({ ...value, enabled: false })).not.toContain("tiles.example");
  expect(policy({ ...value, url: "http://*.example/{z}/{x}/{y}" })).not.toContain("*.example");
  expect(policy({ ...value, url: "http://evil%3Bexample/{z}/{x}/{y}" })).not.toContain("evil");
});
