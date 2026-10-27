import type { ApiError } from "../../shared/api-error.ts";
import type { DownloadRequest } from "../downloads/downloader.ts";

/** Where a repository lives: the registry's base address and the repository's path on it. */
export interface RegistryLocation {
  /** e.g. "https://ghcr.io" */
  base: string;
  /** e.g. "aidronemap/aidm-api" */
  name: string;
}

const LOOPBACK_HOST = /^(127\.\d+\.\d+\.\d+|localhost|\[::1\])(:\d+)?$/;

/**
 * Splits "ghcr.io/aidronemap/aidm-api" into the registry and the path. The
 * first part is a registry when it has a dot or a port, or is localhost, as
 * the runtimes read it; otherwise the image is on Docker Hub. A registry on
 * the loopback address is plain HTTP, as every runtime assumes.
 */
export function locate(repository: string): RegistryLocation {
  const slash = repository.indexOf("/");
  const first = slash === -1 ? "" : repository.slice(0, slash);
  if (first !== "" && (first.includes(".") || first.includes(":") || first === "localhost")) {
    const scheme = LOOPBACK_HOST.test(first) ? "http" : "https";
    const host = first === "docker.io" ? "registry-1.docker.io" : first;
    const name = repository.slice(slash + 1);
    return { base: `${scheme}://${host}`, name: host === "registry-1.docker.io" && !name.includes("/") ? `library/${name}` : name };
  }
  return { base: "https://registry-1.docker.io", name: repository.includes("/") ? repository : `library/${repository}` };
}

/** What a manifest request gives: the exact bytes, which the caller checks against the digest. */
export type ManifestAnswer =
  | { ok: true; bytes: Uint8Array; mediaType: string | null }
  | { ok: false; error: ApiError; final: boolean };

const MANIFEST_TYPES = [
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
].join(", ");

/** A signed address can only be followed this many times in one request. */
const MAX_REDIRECTS = 5;

/** The parts of `Bearer realm="...",service="...",scope="..."`. */
function parseChallenge(header: string | null): Record<string, string> | null {
  if (header === null || !/^bearer\s/i.test(header)) return null;
  const parts: Record<string, string> = {};
  for (const match of header.slice(7).matchAll(/(\w+)="([^"]*)"/g)) {
    const [, key = "", value = ""] = match;
    parts[key.toLowerCase()] = value;
  }
  return typeof parts.realm === "string" ? parts : null;
}

/**
 * Talks to one container registry the way the runtimes do: anonymous pull
 * tokens, manifests by digest, and blobs that the registry hands over as a
 * redirect to a short-lived signed address on another host. Every request
 * asks the registry first, so a retry always gets a fresh signed address.
 */
export class RegistryClient {
  private readonly doFetch: typeof fetch;
  /** The token for each repository, by its base and path. */
  private readonly tokens = new Map<string, string>();

  constructor(fetchImpl: typeof fetch = fetch) {
    this.doFetch = fetchImpl;
  }

  /** The manifest or index with this digest, as bytes. A 401 gets a new token once. */
  async manifest(location: RegistryLocation, digest: string, signal?: AbortSignal): Promise<ManifestAnswer> {
    const url = `${location.base}/v2/${location.name}/manifests/${digest}`;
    let response: Response;
    try {
      response = await this.authorized(location, url, { accept: MANIFEST_TYPES }, signal);
    } catch {
      return { ok: false, error: { code: "download.connection_interrupted", data: {} }, final: false };
    }
    if (response.status === 200) {
      try {
        return { ok: true, bytes: new Uint8Array(await response.arrayBuffer()), mediaType: response.headers.get("content-type") };
      } catch {
        return { ok: false, error: { code: "download.connection_interrupted", data: {} }, final: false };
      }
    }
    await response.body?.cancel().catch(() => {});
    if (response.status === 404) return { ok: false, error: { code: "image.not_found", data: {} }, final: true };
    if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
      return { ok: false, error: { code: "image.registry_refused", data: { status: response.status } }, final: true };
    }
    return { ok: false, error: { code: "download.host_busy", data: { status: response.status } }, final: false };
  }

  /**
   * The request of one try of a blob download. It asks the registry, follows
   * the redirect by hand and sends the Range header to the signed address,
   * never the token: the token is for the registry alone, and a storage host
   * refuses a request that carries two credentials. A signed address that is
   * refused before the first byte is asked for anew once, because it may have
   * expired on the way.
   */
  blobRequest(location: RegistryLocation, digest: string): DownloadRequest {
    const url = `${location.base}/v2/${location.name}/blobs/${digest}`;
    return async (headers, signal) => {
      for (let fresh = 0; ; fresh++) {
        let response = await this.authorized(location, url, headers, signal, "manual");
        let at = url;
        let followed = false;
        for (let hops = 0; isRedirect(response.status) && hops < MAX_REDIRECTS; hops++) {
          const target = response.headers.get("location");
          await response.body?.cancel().catch(() => {});
          if (target === null) return new Response(null, { status: 502 });
          at = new URL(target, at).toString();
          followed = true;
          response = await this.doFetch(at, { headers, signal, redirect: "manual" });
        }
        if ((response.status === 401 || response.status === 403) && followed && fresh === 0) {
          await response.body?.cancel().catch(() => {});
          continue;
        }
        return response;
      }
    };
  }

  /** A GET with the repository's token, which is fetched or refreshed when the registry answers 401. */
  private async authorized(
    location: RegistryLocation,
    url: string,
    headers: Record<string, string>,
    signal: AbortSignal | undefined,
    redirect: RequestRedirect = "follow",
  ): Promise<Response> {
    const key = `${location.base}/${location.name}`;
    const withToken = () => {
      const token = this.tokens.get(key);
      return token === undefined ? headers : { ...headers, authorization: `Bearer ${token}` };
    };
    const first = await this.doFetch(url, { headers: withToken(), signal, redirect });
    if (first.status !== 401) return first;
    const challenge = parseChallenge(first.headers.get("www-authenticate"));
    await first.body?.cancel().catch(() => {});
    if (challenge === null) return new Response(null, { status: 401 });
    const token = await this.fetchToken(challenge, location, signal);
    if (token === null) return new Response(null, { status: 401 });
    this.tokens.set(key, token);
    return this.doFetch(url, { headers: withToken(), signal, redirect });
  }

  private async fetchToken(
    challenge: Record<string, string>,
    location: RegistryLocation,
    signal: AbortSignal | undefined,
  ): Promise<string | null> {
    const realm = new URL(challenge.realm ?? "");
    if (challenge.service !== undefined) realm.searchParams.set("service", challenge.service);
    realm.searchParams.set("scope", challenge.scope ?? `repository:${location.name}:pull`);
    const answer = await this.doFetch(realm.toString(), { signal });
    if (answer.status !== 200) {
      await answer.body?.cancel().catch(() => {});
      return null;
    }
    const body = (await answer.json().catch(() => null)) as { token?: unknown; access_token?: unknown } | null;
    const token = body?.token ?? body?.access_token;
    return typeof token === "string" && token !== "" ? token : null;
  }
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}
