import { expect, test } from "bun:test";
import { errorResponse } from "./api-error.ts";

test("an error response carries the status and a code", async () => {
  const response = errorResponse(404, "api.not_found");
  expect(response.status).toBe(404);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(await response.json()).toEqual({ error: { code: "api.not_found", data: {} } });
});

test("an error response can carry data next to the code", async () => {
  const response = errorResponse(400, "settings.port_invalid", { min: 1, max: 65535 });
  expect(await response.json()).toEqual({ error: { code: "settings.port_invalid", data: { min: 1, max: 65535 } } });
});
