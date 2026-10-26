import { lookup } from "node:dns/promises";
import { isIPv4, isIPv6 } from "node:net";
import type { ApiError } from "../../shared/api-error.ts";

export type AddressCheck =
  | { ok: true; address: string; warning: ApiError | null }
  | { ok: false; error: ApiError };

export type Resolve = (host: string) => Promise<string[]>;

export const PLAIN_HTTP_WARNING: ApiError = { code: "engine.plain_http_local", data: {} };

async function resolveWithSystem(host: string): Promise<string[]> {
  const found = await lookup(host, { all: true });
  return found.map((entry) => entry.address);
}

function ipv4Octets(address: string): number[] {
  return address.split(".").map(Number);
}

function isLocalIpv4(address: string): boolean {
  const [a, b] = ipv4Octets(address) as [number, number, number, number];
  return (
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

/** The eight 16-bit groups of an IPv6 address. */
function ipv6Groups(address: string): number[] {
  let text = address.toLowerCase();
  // A dotted IPv4 tail such as ::ffff:10.0.0.1 is two groups.
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail) {
    const [a, b, c, d] = ipv4Octets(tail[1] as string) as [number, number, number, number];
    text = text.slice(0, tail.index) + ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16);
  }
  const [head = "", rest] = text.split("::");
  const front = head === "" ? [] : head.split(":");
  const back = rest === undefined || rest === "" ? [] : rest.split(":");
  const missing = rest === undefined ? 0 : 8 - front.length - back.length;
  return [...front, ...Array<string>(missing).fill("0"), ...back].map((group) => parseInt(group, 16));
}

function isLocalIpv6(address: string): boolean {
  const groups = ipv6Groups(address);
  const first = groups[0] as number;
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true; // ::1
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10
  // ::ffff:a.b.c.d is an IPv4 address in IPv6 clothes.
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const high = groups[6] as number;
    const low = groups[7] as number;
    return isLocalIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  return false;
}

/** Loopback, private or link-local. Anything that is not an IP address is not local. */
export function isLocalIpAddress(address: string): boolean {
  if (isIPv4(address)) return isLocalIpv4(address);
  if (isIPv6(address)) return isLocalIpv6(address);
  return false;
}

/** The host part of a URL as an IP address if it is one (IPv6 loses its brackets). */
function literalAddress(hostname: string): string | null {
  const bare = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  return isIPv4(bare) || isIPv6(bare) ? bare : null;
}

/**
 * Checks the address the operator typed and returns it in one form. Plain
 * http is only for engines on this computer or the local network, because
 * the token travels in the query string and anyone on the way could read it.
 */
export async function checkEngineAddress(input: string, resolve: Resolve = resolveWithSystem): Promise<AddressCheck> {
  const invalid: AddressCheck = { ok: false, error: { code: "engine.address_invalid", data: {} } };
  const text = input.trim();
  if (/[?#]/.test(text)) return invalid;

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return invalid;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return invalid;
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return invalid;
  if (url.hostname === "") return invalid;

  const address = `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
  if (url.protocol === "https:") return { ok: true, address, warning: null };

  const host = url.hostname.toLowerCase();
  if (host === "localhost") return { ok: true, address, warning: PLAIN_HTTP_WARNING };

  const literal = literalAddress(host);
  if (literal !== null) {
    return isLocalIpAddress(literal)
      ? { ok: true, address, warning: PLAIN_HTTP_WARNING }
      : { ok: false, error: { code: "engine.https_required", data: {} } };
  }

  let resolved: string[];
  try {
    resolved = await resolve(host);
  } catch {
    return { ok: false, error: { code: "engine.unreachable", data: {} } };
  }
  if (resolved.length === 0) return { ok: false, error: { code: "engine.unreachable", data: {} } };
  return resolved.every(isLocalIpAddress)
    ? { ok: true, address, warning: PLAIN_HTTP_WARNING }
    : { ok: false, error: { code: "engine.https_required", data: {} } };
}
