import { expect, test } from "bun:test";
import { errorResponse } from "./api-error.ts";

test("an error response carries the status and a code", async () => {
  const response = errorResponse(404, "api.not_found");
  expect(response.status).toBe(404);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(await response.json()).toEqual({ error: { code: "api.not_found" } });
});

test("an error response can carry data next to the code", async () => {
  const response = errorResponse(400, "upload.too_large", { limit: 5 });
  expect(await response.json()).toEqual({ error: { code: "upload.too_large", data: { limit: 5 } } });
});
