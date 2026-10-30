import { basemapOrigin, type BasemapSettings } from "../../shared/basemap.ts";

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "style-src 'self'",
  "script-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

export function withSecurityHeaders(response: Response, basemap?: BasemapSettings): Response {
  const origin = basemap === undefined ? null : basemapOrigin(basemap);
  const policy = origin === null ? CONTENT_SECURITY_POLICY : CONTENT_SECURITY_POLICY
    .replace("img-src 'self' data: blob:", `img-src 'self' data: blob: ${origin}`)
    .replace("connect-src 'self'", `connect-src 'self' ${origin}`);
  response.headers.set("Content-Security-Policy", policy);
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
