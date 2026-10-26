import { errorResponse } from "../../shared/api-error.ts";
import type { Sessions } from "./sessions.ts";

export interface ClientInfo {
  /** The remote IP address as Bun reports it. */
  address: string;
}

export interface AuthHook {
  /** Null means the request may go on; otherwise the coded refusal to send. */
  authorize(req: Request, client: ClientInfo): Response | null | Promise<Response | null>;
}

/** 127.0.0.0/8, ::1 and the same two written as IPv4-mapped IPv6. */
export function isLoopbackAddress(address: string): boolean {
  const lower = address.toLowerCase();
  const plain = lower.startsWith("::ffff:") ? lower.slice("::ffff:".length) : lower;
  return plain === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(plain);
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** The host name of a Host header, port removed. */
function hostName(host: string): string {
  const lower = host.toLowerCase();
  if (lower.startsWith("[")) return lower.slice(0, lower.indexOf("]") + 1);
  const colon = lower.lastIndexOf(":");
  return colon === -1 ? lower : lower.slice(0, colon);
}

/** The two checks every implementation makes first. */
function browserChecks(req: Request, client: ClientInfo): Response | null {
  const host = req.headers.get("host");
  // A web page on another site can make the operator's browser send a request to
  // 127.0.0.1 under a name the page controls (DNS rebinding). The Host header gives it away.
  if (isLoopbackAddress(client.address) && (host === null || !LOOPBACK_HOSTS.has(hostName(host)))) {
    return errorResponse(403, "auth.host_not_allowed");
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    const origin = req.headers.get("origin");
    // Other web sites can make a browser post here. Only our own pages may.
    if (origin !== null && origin !== `http://${host}`) return errorResponse(403, "auth.origin_not_allowed");
  }
  return null;
}

/** The server listens on loopback only, or refuses everyone else. No login. */
export function loopbackAuth(): AuthHook {
  return {
    authorize(req, client) {
      const refusal = browserChecks(req, client);
      if (refusal) return refusal;
      return isLoopbackAddress(client.address) ? null : errorResponse(403, "auth.lan_disabled");
    },
  };
}

/** What a computer on the network may do before it has signed in. */
function isOpenToVisitors(req: Request): boolean {
  const { pathname } = new URL(req.url);
  if (!pathname.startsWith("/api/")) return true;
  if (req.method === "GET") return pathname === "/api/health" || pathname === "/api/auth/session";
  return req.method === "POST" && pathname === "/api/auth/login";
}

/** The operator's own computer needs no login. Every other computer needs a session. */
export function passphraseAuth(sessions: Sessions): AuthHook {
  return {
    authorize(req, client) {
      const refusal = browserChecks(req, client);
      if (refusal) return refusal;
      if (isLoopbackAddress(client.address)) return null;
      if (sessions.isValid(sessions.fromRequest(req))) return null;
      return isOpenToVisitors(req) ? null : errorResponse(401, "auth.passphrase_required");
    },
  };
}
