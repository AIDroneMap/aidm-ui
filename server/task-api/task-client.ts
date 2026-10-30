import { validateOptions, type InvalidOptions } from "../options/validate.ts";
import type { EngineInfoView } from "../../shared/api-types.ts";
import type { EngineOption } from "../../shared/engine-options.ts";
import { isReadableVersion } from "../engines/versions.ts";
import type { UnreachableLines } from "./unreachable-lines.ts";

/**
 * The address of an engine reached through a Unix socket instead of a port:
 * "unix:" and the socket's full path. Only the local engine has one (ADR 0006).
 */
export const SOCKET_ADDRESS_PREFIX = "unix:";

/** The socket's path, or null for an address with a host and a port. */
export function socketOf(address: string): string | null {
  return address.startsWith(SOCKET_ADDRESS_PREFIX) ? address.slice(SOCKET_ADDRESS_PREFIX.length) : null;
}

/** Where an engine is and the token it wants. The token never leaves the server. */
export interface EngineEndpoint {
  /** For example "http://192.168.1.5:3000", no trailing slash, or "unix:/path/to/task-api.sock". */
  address: string;
  token: string;
}

export type TaskApiFailure =
  | InvalidOptions
  /** Connection refused, name not found, timeout, TLS. */
  | { kind: "unreachable"; detail: string }
  /** The engine's own text from an {"error": ...} body. */
  | { kind: "engine_error"; message: string }
  /** Not JSON, an HTTP status other than 200, or a shape we cannot use. */
  | { kind: "bad_response"; detail: string };

export type TaskApiResult<T> = { ok: true; value: T } | { ok: false; failure: TaskApiFailure };

/**
 * True when the engine says it has no task with that id. The API answers
 * `{"error": "<uuid> not found"}` (aidm-api index.js, getTaskFromUuid:
 * `${uuid} not found`). The upload and commit routes say "Invalid uuid (not
 * found)" instead, which is a different answer and does not match.
 */
export function isTaskNotFound(failure: TaskApiFailure): boolean {
  return failure.kind === "engine_error" && /^\S+ not found$/.test(failure.message);
}

export type EngineInfo = EngineInfoView;

export interface TaskOption {
  name: string;
  value: unknown;
}

export interface TaskInfo {
  uuid: string;
  /** The raw status code; the run state machine maps it. */
  statusCode: unknown;
  errorMessage: string | null;
  /** 0 to 100. */
  progress: number | null;
  /** Milliseconds; -1 while the task initialises. */
  processingTime: number | null;
  imagesCount: number | null;
}

export interface TaskClientOptions {
  timeoutMs?: number;
  fetch?: typeof fetch;
  log?: (line: string) => void;
  /**
   * For lines that would repeat on every poll. The key names what the line is
   * about, so the receiver can drop a line it already has for that key.
   */
  logOnce?: (key: string, line: string) => void;
  /** Where "Could not reach" goes instead of `log`: shared by every client of an engine, it summarises a long outage. */
  unreachable?: UnreachableLines;
}

export const DEFAULT_TIMEOUT_MS = 10_000;
/** One image can be 20 MB or more, sent over a slow link. */
export const UPLOAD_TIMEOUT_MS = 10 * 60_000;
/** How long the engine may take to start answering a results download. The body then streams without a limit. */
const DOWNLOAD_HEADER_TIMEOUT_MS = 5 * 60_000;
/** Every answer this client reads is small JSON, except a task's output. */
const MAX_BODY_BYTES = 1024 * 1024;
/** A task's output lines can add up to a few megabytes between two polls. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
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
  private readonly unreachable: UnreachableLines | undefined;

  constructor(
    private readonly endpoint: EngineEndpoint,
    options: TaskClientOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchFn = options.fetch ?? fetch;
    this.log = options.log ?? (() => {});
    this.logOnce = options.logOnce ?? ((_key, line) => this.log(line));
    this.unreachable = options.unreachable;
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
        maxImages: raw.maxImages === null ? null : typeof raw.maxImages === "number" && Number.isSafeInteger(raw.maxImages) && raw.maxImages >= 0 ? raw.maxImages : undefined,
      },
    };
  }

  async createTask(name: string, options: TaskOption[], signal?: AbortSignal): Promise<TaskApiResult<{ uuid: string }>> {
    const reported = await this.options(signal);
    if (!reported.ok) return reported;
    const invalid = validateOptions(options, reported.value);
    if (invalid !== null) return { ok: false, failure: invalid };
    const form = new FormData();
    form.append("name", name);
    form.append("options", JSON.stringify(options));
    const body = await this.requestObject("POST", "/task/new/init", { body: form, signal });
    if (!body.ok) return body;
    const uuid = body.value.uuid;
    if (typeof uuid !== "string" || uuid === "") {
      return this.badResponse(`${this.endpoint.address}/task/new/init`, "The answer has no uuid.");
    }
    return { ok: true, value: { uuid } };
  }

  /** The API submits a ZIP URL directly. It downloads the photos after returning the identity. */
  async createLinkedTask(name: string, options: TaskOption[], zipurl: string): Promise<TaskApiResult<{ uuid: string }>> {
    const reported = await this.options();
    if (!reported.ok) return reported;
    const invalid = validateOptions(options, reported.value);
    if (invalid !== null) return { ok: false, failure: invalid };
    const form = new FormData();
    form.append("name", name);
    form.append("options", JSON.stringify(options));
    form.append("zipurl", zipurl);
    const body = await this.requestObject("POST", "/task/new", { body: form });
    if (!body.ok) return body;
    const uuid = body.value.uuid;
    if (typeof uuid !== "string" || uuid === "") return this.badResponse(`${this.endpoint.address}/task/new`, "The answer has no uuid.");
    return { ok: true, value: { uuid } };
  }

  async options(signal?: AbortSignal): Promise<TaskApiResult<EngineOption[]>> {
    const result = await this.request("GET", "/options", { signal });
    if (!result.ok) return result;
    if (!Array.isArray(result.value) || !result.value.every(isEngineOption)) {
      return this.badResponse(`${this.endpoint.address}/options`, "The option list has an unusable shape.");
    }
    const names = new Set<string>();
    for (const option of result.value) {
      if (names.has(option.name)) return this.badResponse(`${this.endpoint.address}/options`, "The option list repeats a name.");
      names.add(option.name);
    }
    return {
      ok: true,
      value: result.value.map((option) => ({
        type: option.type,
        name: this.scrub(option.name),
        value: this.scrub(option.value),
        domain: Array.isArray(option.domain)
          ? option.domain.map((value) => typeof value === "string" ? this.scrub(value) : value)
          : this.scrub(option.domain),
        help: this.scrub(option.help),
      })),
    };
  }

  /** The data should be a file-backed Blob (Bun.file(path).slice(...)) so that the image is not read into memory first. */
  async uploadImage(uuid: string, fileName: string, data: Blob, signal?: AbortSignal): Promise<TaskApiResult<void>> {
    const form = new FormData();
    form.append("images", data, fileName);
    const body = await this.requestObject("POST", `/task/new/upload/${encodeURIComponent(uuid)}`, {
      body: form,
      timeoutMs: UPLOAD_TIMEOUT_MS,
      signal,
    });
    return body.ok ? this.expectSuccess(body.value, `/task/new/upload`) : body;
  }

  async commitTask(uuid: string, signal?: AbortSignal): Promise<TaskApiResult<void>> {
    const body = await this.requestObject("POST", `/task/new/commit/${encodeURIComponent(uuid)}`, { signal });
    return body.ok ? { ok: true, value: undefined } : body;
  }

  async taskInfo(uuid: string): Promise<TaskApiResult<TaskInfo>> {
    const body = await this.requestObject("GET", `/task/${encodeURIComponent(uuid)}/info`, {});
    if (!body.ok) return body;
    const raw = body.value;
    const status = raw.status;
    if (typeof status !== "object" || status === null || Array.isArray(status)) {
      return this.badResponse(`${this.endpoint.address}/task/info`, "The info answer has no status.");
    }
    const { code, errorMessage } = status as { code?: unknown; errorMessage?: unknown };
    return {
      ok: true,
      value: {
        uuid,
        statusCode: code,
        errorMessage: typeof errorMessage === "string" && errorMessage !== "" ? this.scrub(errorMessage) : null,
        progress: this.number(raw, "progress"),
        processingTime: this.number(raw, "processingTime"),
        imagesCount: this.count(raw, "imagesCount"),
      },
    };
  }

  /** The console lines from line number fromLine on. */
  async taskOutput(uuid: string, fromLine: number): Promise<TaskApiResult<string[]>> {
    const body = await this.request("GET", `/task/${encodeURIComponent(uuid)}/output`, {
      query: { line: String(fromLine) },
      maxBodyBytes: MAX_OUTPUT_BYTES,
    });
    if (!body.ok) return body;
    if (!Array.isArray(body.value) || !body.value.every((line) => typeof line === "string")) {
      return this.badResponse(`${this.endpoint.address}/task/output`, "The output is not a list of lines.");
    }
    return { ok: true, value: body.value.map((line: string) => this.scrub(line)) };
  }

  async cancelTask(uuid: string, signal?: AbortSignal): Promise<TaskApiResult<void>> {
    return this.command("/task/cancel", uuid, signal);
  }

  async removeTask(uuid: string, signal?: AbortSignal): Promise<TaskApiResult<void>> {
    return this.command("/task/remove", uuid, signal);
  }

  /**
   * The results archive. A JSON answer is the engine saying no (for example
   * "Asset not ready"); anything else is returned to the caller to stream, so
   * the archive is never held in memory here.
   */
  async downloadResults(uuid: string, options: { headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<TaskApiResult<Response>> {
    const where = `${this.endpoint.address}/task/download`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_HEADER_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.send(`/task/${encodeURIComponent(uuid)}/download/all.zip`, {}, {
        method: "GET",
        redirect: "manual",
        signal: options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal,
        headers: options.headers,
      });
    } catch (error) {
      const detail = this.scrub(describeFailure(error, DOWNLOAD_HEADER_TIMEOUT_MS));
      this.notReached(where, detail);
      return { ok: false, failure: { kind: "unreachable", detail } };
    } finally {
      clearTimeout(timer);
    }

    this.unreachable?.answered(this.endpoint.address);
    const type = response.headers.get("content-type") ?? "";
    if (type.includes("json")) {
      try {
        const text = await readCapped(response, MAX_BODY_BYTES);
        const parsed = this.parse(where, response, text);
        if (!parsed.ok) return parsed;
        return this.badResponse(where, "The answer is JSON where an archive was expected.");
      } catch (error) {
        const detail = this.scrub(describeFailure(error, DOWNLOAD_HEADER_TIMEOUT_MS));
        return { ok: false, failure: { kind: "unreachable", detail } };
      }
    }
    if ((response.status !== 200 && response.status !== 206) || response.body === null) {
      await response.body?.cancel();
      return this.badResponse(where, `HTTP ${response.status}, and no archive.`);
    }
    return { ok: true, value: response };
  }

  private async command(path: string, uuid: string, signal?: AbortSignal): Promise<TaskApiResult<void>> {
    const body = await this.requestObject("POST", path, { body: new URLSearchParams({ uuid }), signal });
    if (!body.ok) return body;
    return this.expectSuccess(body.value, path);
  }

  /** The command routes say {"success": false, "error": ...} for a refusal. */
  private expectSuccess(body: Record<string, unknown>, path: string): TaskApiResult<void> {
    if (body.success === true) return { ok: true, value: undefined };
    return this.badResponse(`${this.endpoint.address}${path}`, "The answer does not say success.");
  }

  private notReached(where: string, detail: string): void {
    if (this.unreachable === undefined) this.log(`Could not reach ${where}: ${detail}`);
    else this.unreachable.failed(this.endpoint.address, where, detail);
  }

  /** One HTTP request, over the engine's socket when it has one: Bun's fetch takes the socket's path as `unix`. */
  private send(path: string, query: Record<string, string>, init: RequestInit): Promise<Response> {
    const socket = socketOf(this.endpoint.address);
    return this.fetchFn(this.urlFor(path, query), socket === null ? init : { ...init, unix: socket });
  }

  private urlFor(path: string, query: Record<string, string> = {}): string {
    const extra = Object.entries(query)
      .map(([key, value]) => `&${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join("");
    // Over a socket the host name is only the request's Host header.
    const base = socketOf(this.endpoint.address) === null ? this.endpoint.address : "http://localhost";
    return `${base}${path}?token=${encodeURIComponent(this.endpoint.token)}${extra}`;
  }

  /** A GET of one path. The path must not contain a query. */
  private getJson(path: string): Promise<TaskApiResult<Record<string, unknown>>> {
    return this.requestObject("GET", path, {});
  }

  private async requestObject(
    method: "GET" | "POST",
    path: string,
    options: RequestOptions,
  ): Promise<TaskApiResult<Record<string, unknown>>> {
    const result = await this.request(method, path, options);
    if (!result.ok) return result;
    if (typeof result.value !== "object" || result.value === null || Array.isArray(result.value)) {
      return this.badResponse(`${this.endpoint.address}${path}`, "The body is JSON but not an object.");
    }
    return { ok: true, value: result.value as Record<string, unknown> };
  }

  /** One call whose answer is small JSON. An {"error": ...} body is the engine's error whatever the HTTP status. */
  private async request(method: "GET" | "POST", path: string, options: RequestOptions): Promise<TaskApiResult<unknown>> {
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const where = `${this.endpoint.address}${path}`;
    let response: Response;
    let text: string;
    try {
      response = await this.send(path, options.query ?? {}, {
        method,
        body: options.body,
        // A redirect would carry the token to wherever it points.
        redirect: "manual",
        signal: options.signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), options.signal]) : AbortSignal.timeout(timeoutMs),
      });
      text = await readCapped(response, options.maxBodyBytes ?? MAX_BODY_BYTES);
    } catch (error) {
      const detail = this.scrub(describeFailure(error, timeoutMs));
      this.notReached(where, detail);
      return { ok: false, failure: { kind: "unreachable", detail } };
    }
    this.unreachable?.answered(this.endpoint.address);
    return this.parse(where, response, text);
  }

  private parse(where: string, response: Response, text: string): TaskApiResult<unknown> {
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
    return { ok: true, value: body };
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

  /** A finite number, or null. */
  private number(raw: Record<string, unknown>, field: string): number | null {
    const value = raw[field];
    if (value === undefined || value === null) return null;
    if (typeof value === "number" && Number.isFinite(value)) return value;
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

function usableDefault(type: EngineOption["type"], value: string): boolean {
  if (type === "bool") return value === "true" || value === "false";
  if (type === "int" || type === "float") {
    if (value.trim() === "") return false;
    const number = Number(value);
    return type === "int" ? Number.isSafeInteger(number) : Number.isFinite(number);
  }
  return true;
}

function isEngineOption(value: unknown): value is EngineOption {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const option = value as Record<string, unknown>;
  return typeof option.name === "string" && option.name !== "" &&
    ["int", "float", "string", "bool", "enum"].includes(option.type as string) &&
    typeof option.value === "string" && usableDefault(option.type as EngineOption["type"], option.value) && typeof option.help === "string" &&
    (typeof option.domain === "string" ||
      (Array.isArray(option.domain) && option.domain.every((choice) =>
        typeof choice === "string" || typeof choice === "boolean" || (typeof choice === "number" && Number.isFinite(choice)))));
}

interface RequestOptions {
  body?: FormData | URLSearchParams;
  query?: Record<string, string>;
  timeoutMs?: number;
  /** Lets the caller stop the call, for example when the operator cancels an upload. */
  signal?: AbortSignal;
  /** The largest answer read, in bytes. */
  maxBodyBytes?: number;
}

function describeFailure(error: unknown, timeoutMs: number): string {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "TimeoutError" || name === "AbortError") return `No answer within ${timeoutMs} ms.`;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string") return code;
  return error instanceof Error ? error.message : String(error);
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error("The answer is larger than expected.");
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
