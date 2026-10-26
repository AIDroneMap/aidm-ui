import type { ApiError } from "../../shared/api-error.ts";
import type { EnginePackageOffer, PackagesView, VariantId } from "../../shared/api-types.ts";
import { compareVersions, isReadableVersion } from "../engines/versions.ts";
import type { Settings } from "../settings/settings.ts";
import { base64Bytes, verifyBuiltinManifest } from "./builtin.ts";
import { ACCEPTED_KEYS, type AcceptedKey } from "./keys.ts";
import type { Manifest, ManifestVariant } from "./schema.ts";
import { verifyManifest } from "./verify.ts";

export const RELEASES_URL = "https://github.com/AIDroneMap/aidm-api/releases";

/** The manifest and its signature are small; anything bigger is not one. */
export const MAX_BODY_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface HeldManifest {
  manifest: Manifest;
  source: "builtin" | "downloaded";
  tag: string | null;
}

export type RefreshResult = { ok: true; tag: string; replaced: boolean } | { ok: false; error: ApiError };

/** What the service needs of fetch; narrower than typeof fetch, so that a test can pass a plain function. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ManifestServiceDeps {
  settings: Settings;
  releasesUrl?: string;
  fetch?: FetchLike;
  /** The version of this aidm-ui. */
  uiVersion: string;
  now: () => number;
  log: (line: string) => void;
  /** The keys a manifest may be signed with. */
  keys?: readonly AcceptedKey[];
}

class FetchFailed extends Error {
  constructor(readonly data: Record<string, unknown>) {
    super("fetch failed");
  }
}

function fetchFailed(step: string, status?: number): FetchFailed {
  return new FetchFailed(status === undefined ? { step } : { step, status });
}

function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

/** Reads a body up to a limit and stops there, so a hostile host cannot make us hold more. */
async function readLimited(response: Response, step: string): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    await response.body?.cancel();
    throw fetchFailed(step);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        throw fetchFailed(step);
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function variantFor(manifest: Manifest, facts: { platform: string; arch: string }): { id: VariantId; variant: ManifestVariant } | null {
  const pick = (id: VariantId) => {
    const variant = manifest.variants[id];
    return variant === undefined ? null : { id, variant };
  };
  if (facts.platform === "linux" && facts.arch === "x64") return pick("linux-amd64-cpu");
  if (facts.platform === "linux" && facts.arch === "arm64") return pick("linux-arm64-cpu");
  if (facts.platform === "darwin" && facts.arch === "arm64") {
    // A native package when the release has one, else the Linux arm64 image through the container tool.
    return pick("darwin-arm64") ?? pick("linux-arm64-cpu");
  }
  if (facts.platform === "win32" && facts.arch === "x64") return pick("windows-x64");
  return null;
}

/**
 * The newest verified manifest, the package it offers for this computer, and
 * the way to ask GitHub Releases for a newer one.
 */
export class ManifestService {
  private readonly releasesUrl: string;
  private readonly doFetch: FetchLike;
  private readonly keys: readonly AcceptedKey[];
  private builtin: Promise<HeldManifest> | undefined;
  private verifiedStored: { key: string; held: HeldManifest | null } | undefined;
  private running: Promise<RefreshResult> | undefined;

  constructor(private readonly deps: ManifestServiceDeps) {
    this.releasesUrl = (deps.releasesUrl ?? RELEASES_URL).replace(/\/+$/, "");
    this.doFetch = deps.fetch ?? fetch;
    this.keys = deps.keys ?? ACCEPTED_KEYS;
  }

  private loadBuiltin(): Promise<HeldManifest> {
    this.builtin ??= verifyBuiltinManifest(this.keys).then((result) => {
      if (!result.ok) {
        // The built-in entry is the floor. If the accepted keys no longer cover it, that is a build mistake.
        throw new Error(`The built-in manifest entry does not verify (${result.error.code}).`);
      }
      return { manifest: result.manifest, source: "builtin" as const, tag: null };
    });
    return this.builtin;
  }

  /** The stored manifest, if it still verifies against the accepted keys. */
  private async loadStored(): Promise<HeldManifest | null> {
    const stored = this.deps.settings.get("manifest.held");
    if (stored === null) return null;
    const key = `${stored.tag}\n${stored.signature}\n${stored.bytes}`;
    if (this.verifiedStored?.key === key) return this.verifiedStored.held;
    let held: HeldManifest | null = null;
    try {
      const result = await verifyManifest(base64Bytes(stored.bytes), base64Bytes(stored.signature), this.keys);
      if (result.ok) held = { manifest: result.manifest, source: "downloaded", tag: stored.tag };
      else this.deps.log(`The stored manifest was ignored: ${result.error.code}.`);
    } catch {
      this.deps.log("The stored manifest was ignored: it could not be read.");
    }
    this.verifiedStored = { key, held };
    return held;
  }

  /** The newest verified manifest: the stored one if it verifies and is not older than the built-in entry, else the built-in entry. */
  async held(): Promise<HeldManifest> {
    const builtin = await this.loadBuiltin();
    const stored = await this.loadStored();
    return stored !== null && stored.manifest.sequence > builtin.manifest.sequence ? stored : builtin;
  }

  /** Asks GitHub Releases for the latest manifest. Two calls at once share one run. */
  refresh(): Promise<RefreshResult> {
    this.running ??= this.runRefresh().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async runRefresh(): Promise<RefreshResult> {
    let result: RefreshResult;
    try {
      result = await this.download();
    } catch (error) {
      if (error instanceof FetchFailed) {
        result = { ok: false, error: { code: "manifest.fetch_failed", data: error.data } };
      } else {
        this.deps.log(`Looking for a newer manifest failed: ${error instanceof Error ? error.message : String(error)}`);
        result = { ok: false, error: { code: "manifest.fetch_failed", data: {} } };
      }
    }
    this.deps.settings.set("updates.lastCheck", {
      at: new Date(this.deps.now()).toISOString(),
      problem: result.ok ? null : result.error,
    });
    return result;
  }

  private async get(url: string, step: string, redirect: "manual" | "follow"): Promise<Response> {
    try {
      return await this.doFetch(url, { redirect, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch {
      throw fetchFailed(step);
    }
  }

  private async discoverTag(): Promise<string> {
    const url = `${this.releasesUrl}/latest/download/manifest.json`;
    const response = await this.get(url, "discover", "manual");
    await response.body?.cancel();
    const location = response.headers.get("location");
    if (response.status < 300 || response.status > 399 || location === null) {
      throw fetchFailed("discover", response.status);
    }
    let pathname: string;
    try {
      pathname = new URL(location, url).pathname;
    } catch {
      throw fetchFailed("discover");
    }
    const tag = /\/download\/([^/]+)\/manifest\.json$/.exec(pathname)?.[1];
    if (tag === undefined || !TAG.test(tag)) throw fetchFailed("discover");
    return tag;
  }

  private async fetchAsset(tag: string, name: string, step: string): Promise<Uint8Array> {
    const response = await this.get(`${this.releasesUrl}/download/${tag}/${name}`, step, "follow");
    if (!response.ok) {
      await response.body?.cancel();
      throw fetchFailed(step, response.status);
    }
    try {
      return await readLimited(response, step);
    } catch (error) {
      throw error instanceof FetchFailed ? error : fetchFailed(step);
    }
  }

  private async download(): Promise<RefreshResult> {
    const tag = await this.discoverTag();
    // The address is built from the tag, so a redirect cannot send us to another host for the first fetch.
    const bytes = await this.fetchAsset(tag, "manifest.json", "manifest");
    const signature = await this.fetchAsset(tag, "manifest.json.sig", "signature");

    const verified = await verifyManifest(bytes, signature, this.keys);
    if (!verified.ok) return verified;

    const held = (await this.held()).manifest.sequence;
    const offered = verified.manifest.sequence;
    if (offered < held) return { ok: false, error: { code: "manifest.older_sequence", data: { held, offered } } };
    if (offered === held) return { ok: true, tag, replaced: false };

    this.deps.settings.set("manifest.held", { bytes: toBase64(bytes), signature: toBase64(signature), tag });
    return { ok: true, tag, replaced: true };
  }

  /** What this computer may install, and why not when it may not. */
  async offer(facts: { platform: string; arch: string }): Promise<PackagesView> {
    const base = {
      updateCheck: this.deps.settings.get("updates.check"),
      lastCheck: this.deps.settings.get("updates.lastCheck"),
    };
    const { manifest, source, tag } = await this.held();

    const running = this.deps.uiVersion;
    if (isReadableVersion(running) && compareVersions(manifest.minimumUiVersion, running) > 0) {
      return {
        ...base,
        offer: null,
        reason: { code: "manifest.update_interface", data: { minimum: manifest.minimumUiVersion, running } },
      };
    }
    const chosen = variantFor(manifest, facts);
    if (chosen === null) {
      return {
        ...base,
        offer: null,
        reason: { code: "manifest.no_variant", data: { platform: facts.platform, arch: facts.arch } },
      };
    }
    const offer: EnginePackageOffer = {
      packageVersion: manifest.packageVersion,
      engineVersion: manifest.engineVersion,
      variant: chosen.id,
      kind: chosen.variant.kind,
      size: chosen.variant.size,
      source,
      tag,
    };
    return { ...base, offer, reason: null };
  }
}
