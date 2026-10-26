/** The server sends message codes with data, never interface text. */
export interface ApiError {
  code: string;
  data?: Record<string, unknown>;
}

export function errorResponse(
  status: number,
  code: string,
  data?: Record<string, unknown>,
): Response {
  const error: ApiError = data === undefined ? { code } : { code, data };
  return Response.json({ error }, { status });
}
