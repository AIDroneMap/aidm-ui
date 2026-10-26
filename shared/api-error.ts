import type { MessageCode } from "./message-codes.ts";

/** The server sends message codes with data, never interface text. */
export interface ApiError {
  code: MessageCode;
  data: Record<string, unknown>;
}

export function errorResponse(
  status: number,
  code: MessageCode,
  data: Record<string, unknown> = {},
): Response {
  const error: ApiError = { code, data };
  return Response.json({ error }, { status });
}
