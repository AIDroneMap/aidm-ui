import type { EngineInfoView } from "../../shared/api-types.ts";
import { isReadableVersion } from "../engines/versions.ts";

/** Where an engine is and the token it wants. The token never leaves the server. */
export interface EngineEndpoint {
  /** For example "http://192.168.1.5:3000", no trailing slash. */
  address: string;
  token: string;
}

export type TaskApiFailure =
  /** Connection refused, name not found, timeout, TLS. */
  | { kind: "unreachable"; detail: string }
  /** The engine's own text from an {"error": ...} body. */
  | { kind: "engine_error"; message: string }
  /** Not JSON, an HTTP status other than 200, or a shape we cannot use. */
  | { kind: "bad_response"; detail: string };

export type TaskApiResult<T> = { ok: true; value: T } | { ok: false; failure: TaskApiFailure };

export type EngineInfo = EngineInfoView;

export interface TaskClientOptions {
  timeoutMs?: number;
  fetch?: typeof fetch;
  log?: (line: string) => void;
  /**
   * For lines that would repeat on every poll. The key names what the line is
   * about, so the receiver can drop a line it already has for that key.
   */
  logOnce?: (key: string, line: string) => void;
}

export const DEFAULT_TIMEOUT_MS = 10_000;
/** Every answer this client reads is small JSON. */
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_LOGGED_VALUE_CHARS = 200;

/**
 * The only code that calls the task API. Every call puts the token in the
 * query string, and no failure, log line or URL it reports contains the token.
 */
export class TaskClient {
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly log: (line: string) => void;
  private readonly logOnce: (key: string, line: string) => void;

  constructor(
    private readonly endpoint: EngineEndpoint,
    options: TaskClientOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchFn = options.fetch ?? fetch;
    this.log = options.log ?? (() => {});
    this.logOnce = options.logOnce ?? ((_key, line) => this.log(line));
  }

  async info(): Promise<TaskApiResult<EngineInfo>> {
    const body = await this.getJson("/info");
    if (!body.ok) return body;
    const raw = body.value;
    if (typeof raw.version !== "string" || raw.version.trim() === "") {
      return { ok: false, failure: { kind: "bad_response", detail: "The info answer has no version." } };
    }
    if (!isReadableVersion(raw.version)) this.unknownValue("version", raw.version);
    return {
      ok: true,
      value: {
        version: raw.version,
        engineVersion: this.text(raw, "engineVersion"),
        cpuCores: this.count(raw, "cpuCores"),
        totalMemory: this.count(raw, "totalMemory"),
        availableMemory: this.count(raw, "availableMemory"),
        queueCount: this.count(raw, "taskQueueCount"),
        maxParallelTasks: this.count(raw, "maxParallelTasks"),
      },
    };
  }

  /** A GET of one path. The path must not contain a query. */
  private async getJson(path: string): Promise<TaskApiResult<Record<string, unknown>>> {
    const url = `${this.endpoint.address}${path}?token=${encodeURIComponent(this.endpoint.token)}`;
    const where = `${this.endpoint.address}${path}`;
    let response: Response;
    let text: string;
    try {
      response = await this.fetchFn(url, {
        method: "GET",
        // A redirect would carry the token to wherever it points.
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      text = await readCapped(response);
    } catch (error) {
      const detail = this.scrub(describeFailure(error, this.timeoutMs));
      this.log(`Could not reach ${where}: ${detail}`);
      return { ok: false, failure: { kind: "unreachable", detail } };
    }

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      // The API answers errors with 200 and JSON, so anything else is another program.
      return this.badResponse(where, `HTTP ${response.status}, and the body is not JSON.`);
    }
    if (typeof body === "object" && body !== null && !Array.isArray(body) && "error" in body) {
      const message = (body as { error: unknown }).error;
      return {
        ok: false,
        failure: { kind: "engine_error", message: this.scrub(typeof message === "string" ? message : JSON.stringify(message)) },
      };
    }
    if (response.status !== 200) return this.badResponse(where, `HTTP ${response.status}.`);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return this.badResponse(where, "The body is JSON but not an object.");
    }
    return { ok: true, value: body as Record<string, unknown> };
  }

  private badResponse(where: string, detail: string): { ok: false; failure: TaskApiFailure } {
    this.log(`Unusable answer from ${where}: ${detail}`);
    return { ok: false, failure: { kind: "bad_response", detail } };
  }

  /** A number that is zero or more and whole, or null. */
  private count(raw: Record<string, unknown>, field: string): number | null {
    const value = raw[field];
    if (value === undefined || value === null) return null;
    if (typeof value === "number" && Number.isFinite(value) && value >= 0 && Number.isInteger(value)) return value;
    this.unknownValue(field, value);
    return null;
  }

  private text(raw: Record<string, unknown>, field: string): string | null {
    const value = raw[field];
    if (value === undefined || value === null) return null;
    if (typeof value === "string") return value;
    this.unknownValue(field, value);
    return null;
  }

  private unknownValue(field: string, value: unknown): void {
    let shown = JSON.stringify(value) ?? String(value);
    if (shown.length > MAX_LOGGED_VALUE_CHARS) shown = `${shown.slice(0, MAX_LOGGED_VALUE_CHARS)}...`;
    this.logOnce(field, this.scrub(`Engine info field ${field} has an unknown value: ${shown}`));
  }

  /** Last line of defence: whatever an error message or a reply says, the token is not in it. */
  private scrub(text: string): string {
    const { token } = this.endpoint;
    if (token === "") return text;
    return text.split(token).join("***").split(encodeURIComponent(token)).join("***");
  }
}

function describeFailure(error: unknown, timeoutMs: number): string {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "TimeoutError" || name === "AbortError") return `No answer within ${timeoutMs} ms.`;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string") return code;
  return error instanceof Error ? error.message : String(error);
}

async function readCapped(response: Response): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error("The answer is larger than expected.");
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
