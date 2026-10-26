import { MESSAGE_CODES, type MessageCode } from "../../shared/message-codes.ts";

/** "network.unreachable" exists only in the interface: no answer ever came back. */
export type FailureCode = MessageCode | "network.unreachable";

export class ApiFailure extends Error {
  status: number;
  code: FailureCode;
  data: Record<string, unknown>;

  constructor(status: number, code: FailureCode, data: Record<string, unknown> = {}) {
    super(code);
    this.name = "ApiFailure";
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

// Empty in the browser, so every call goes to the page's own origin. Tests
// point it at a local server.
let base = "";

export function setApiBase(url: string): void {
  base = url;
}

function isMessageCode(value: unknown): value is MessageCode {
  return typeof value === "string" && (MESSAGE_CODES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function failureFrom(response: Response): Promise<ApiFailure> {
  try {
    const body: unknown = await response.json();
    const error = isRecord(body) ? body["error"] : undefined;
    if (isRecord(error) && isMessageCode(error["code"])) {
      const data = isRecord(error["data"]) ? error["data"] : {};
      return new ApiFailure(response.status, error["code"], data);
    }
  } catch {
    // Not JSON: fall through to the generic code.
  }
  return new ApiFailure(response.status, "server.internal_error");
}

export async function api<T>(
  method: "GET" | "PUT" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiFailure(0, "network.unreachable");
  }
  if (!response.ok) throw await failureFrom(response);
  if (response.status === 204) return undefined as T;
  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiFailure(response.status, "server.internal_error");
  }
}
