import type { ApiError } from "../../shared/api-error.ts";
import type { EnginePackageOffer, PackagesView, RefreshResult, VariantId } from "../../shared/api-types.ts";
import { base64ToBytes, bytesToBase64 } from "../../shared/base64.ts";
import { compareVersions, isReadableVersion } from "../engines/versions.ts";
import { describeGpu, mayUseGpuPackage, type GpuPrecheck } from "../machine/gpu.ts";
import type { Settings } from "../settings/settings.ts";
import { verifyBuiltinManifest } from "./builtin.ts";
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

/** What decides the package: the computer, and what is known about its graphics card before any download. */
export interface OfferFacts {
  platform: string;
  arch: string;
  /** Checks a and b. Without it the processor package is chosen and the graphics card is not checked. */
  gpu?: GpuPrecheck;
  /** The operator chose the processor only. */
  forceCpu?: boolean;
}

function variantFor(manifest: Manifest, facts: OfferFacts): { id: VariantId; variant: ManifestVariant } | null {
  const pick = (id: VariantId) => {
    const variant = manifest.variants[id];
    return variant === undefined ? null : { id, variant };
  };
  if (facts.platform === "linux" && facts.arch === "x64") {
    // Check c, inside the pulled image, comes after this choice and can still turn it back to the processor package.
    const graphics = mayUseGpuPackage(facts.gpu, facts.forceCpu === true) ? pick("linux-amd64-gpu") : null;
    return graphics ?? pick("linux-amd64-cpu");
  }
  if (facts.platform === "linux" && facts.arch === "arm64") return pick("linux-arm64-cpu");
  if (facts.platform === "darwin" && facts.arch === "arm64") {
    // A native package when the release has one, else the Linux arm64 image through the container tool.
    return pick("darwin-arm64") ?? pick("linux-arm64-cpu");
  }
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
  /** The stored text that was verified, and what came of it. A changed text is verified again. */
  private verifiedStored: { raw: string; held: Promise<HeldManifest | null> } | undefined;
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
  private loadStored(): Promise<HeldManifest | null> {
    const raw = this.deps.settings.getRaw("manifest.held");
    if (raw === null) return Promise.resolve(null);
    if (this.verifiedStored?.raw !== raw) {
      this.verifiedStored = { raw, held: this.verifyStored() };
    }
    return this.verifiedStored.held;
  }

  private async verifyStored(): Promise<HeldManifest | null> {
    const stored = this.deps.settings.get("manifest.held");
    if (stored === null) return null;
    try {
      const result = await verifyManifest(base64ToBytes(stored.bytes), base64ToBytes(stored.signature), this.keys);
      if (result.ok) return { manifest: result.manifest, source: "downloaded", tag: stored.tag };
      this.deps.log(`The stored manifest was ignored: ${result.error.code}.`);
    } catch {
      this.deps.log("The stored manifest was ignored: it could not be read.");
    }
    return null;
  }

  /** The verified manifests, the one with the highest sequence first. */
  private async candidates(): Promise<HeldManifest[]> {
    const builtin = await this.loadBuiltin();
    const stored = await this.loadStored();
    return stored !== null && stored.manifest.sequence > builtin.manifest.sequence ? [stored, builtin] : [builtin];
  }

  /** The newest verified manifest: the stored one if it verifies and is newer than the built-in entry, else the built-in entry. */
  async held(): Promise<HeldManifest> {
    return (await this.candidates())[0] as HeldManifest;
  }

  /**
   * Asks GitHub Releases for the latest manifest. Two calls at once share one
   * run, and the signal of the call that started it cancels every request.
   */
  refresh(signal?: AbortSignal): Promise<RefreshResult> {
    this.running ??= this.runRefresh(signal).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async runRefresh(signal: AbortSignal | undefined): Promise<RefreshResult> {
    let result: RefreshResult;
    try {
      result = await this.download(signal);
    } catch (error) {
      if (error instanceof FetchFailed) {
        result = { ok: false, error: { code: "manifest.fetch_failed", data: error.data } };
      } else {
        this.deps.log(`Looking for a newer manifest failed: ${error instanceof Error ? error.message : String(error)}`);
        result = { ok: false, error: { code: "manifest.fetch_failed", data: {} } };
      }
    }
    // A look that was cancelled did not fail, so it leaves no trace and is made again at the next start.
    if (signal?.aborted) return result;
    const at = new Date(this.deps.now()).toISOString();
    this.deps.settings.set("updates.lastCheck", { at, problem: result.ok ? null : result.error });
    if (result.ok) this.deps.settings.set("updates.lastSuccess", at);
    return result;
  }

  private async get(url: string, step: string, redirect: "manual" | "follow", signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    try {
      return await this.doFetch(url, { redirect, signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]) });
    } catch {
      throw fetchFailed(step);
    }
  }

  private async discoverTag(signal?: AbortSignal): Promise<string> {
    const url = `${this.releasesUrl}/latest/download/manifest.json`;
    const response = await this.get(url, "discover", "manual", signal);
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

  private async fetchAsset(tag: string, name: string, step: string, signal?: AbortSignal): Promise<Uint8Array> {
    const response = await this.get(`${this.releasesUrl}/download/${tag}/${name}`, step, "follow", signal);
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

  private async download(signal?: AbortSignal): Promise<RefreshResult> {
    const tag = await this.discoverTag(signal);
    // The address is built from the tag, so a redirect cannot send us to another host for the first fetch.
    const bytes = await this.fetchAsset(tag, "manifest.json", "manifest", signal);
    const signature = await this.fetchAsset(tag, "manifest.json.sig", "signature", signal);

    const verified = await verifyManifest(bytes, signature, this.keys);
    if (!verified.ok) return verified;
    if (verified.skippedVariants.length > 0) {
      this.deps.log(
        `The manifest of release ${tag} lists variants this version does not know. They are skipped: ${JSON.stringify(verified.skippedVariants)}.`,
      );
    }

    const heldSequence = (await this.held()).manifest.sequence;
    const floor = this.deps.settings.get("manifest.sequenceFloor");
    const offered = verified.manifest.sequence;
    // The floor outlives the stored manifest, so a manifest that was dropped cannot be replaced by an older one.
    const held = Math.max(heldSequence, floor);
    if (offered < held) return { ok: false, error: { code: "manifest.older_sequence", data: { held, offered } } };
    if (offered === heldSequence) return { ok: true, tag, replaced: false };

    this.deps.settings.set("manifest.held", { bytes: bytesToBase64(bytes), signature: bytesToBase64(signature), tag });
    this.deps.settings.set("manifest.sequenceFloor", Math.max(floor, offered));
    return { ok: true, tag, replaced: true };
  }

  /**
   * What this computer may install, and why not when it may not. The offer is
   * the newest manifest this interface can run. When a newer one is waiting
   * for a newer interface, the offer stays and the reason says so.
   */
  async offer(facts: OfferFacts): Promise<PackagesView> {
    return (await this.offerWithVariant(facts)).view;
  }

  /** The offer, and the manifest's own entry for it, which holds the image and its digest. */
  async offerWithVariant(facts: OfferFacts): Promise<{ view: PackagesView; variant: ManifestVariant | null }> {
    const noGpu = describeGpu(undefined, { forceCpu: false, manifestHasGpuPackage: false });
    const base = {
      updateCheck: this.deps.settings.get("updates.check"),
      lastCheck: this.deps.settings.get("updates.lastCheck"),
    };
    // The Windows local engine has no spec yet, so whatever a manifest holds, nothing is offered.
    if (facts.platform === "win32") {
      return {
        view: { ...base, offer: null, gpu: noGpu, reason: { code: "machine.windows_not_yet", data: {} } },
        variant: null,
      };
    }

    const candidates = await this.candidates();
    const newest = candidates[0] as HeldManifest;
    const running = this.deps.uiVersion;
    // An interface whose version cannot be read cannot show that it meets any minimum, so it installs nothing.
    const runnable = (held: HeldManifest) =>
      isReadableVersion(running) && compareVersions(held.manifest.minimumUiVersion, running) <= 0;
    const usable = candidates.find(runnable);
    const waiting: ApiError | null =
      usable === newest
        ? null
        : { code: "manifest.update_interface", data: { minimum: newest.manifest.minimumUiVersion, running } };
    if (usable === undefined) return { view: { ...base, offer: null, gpu: noGpu, reason: waiting }, variant: null };

    const { manifest, source, tag } = usable;
    const chosen = variantFor(manifest, facts);
    if (chosen === null) {
      return {
        view: {
          ...base,
          offer: null,
          gpu: noGpu,
          reason: { code: "manifest.no_variant", data: { platform: facts.platform, arch: facts.arch } },
        },
        variant: null,
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
    const gpu = describeGpu(facts.gpu, {
      forceCpu: facts.forceCpu === true,
      manifestHasGpuPackage: manifest.variants["linux-amd64-gpu"] !== undefined,
    });
    return { view: { ...base, offer, gpu, reason: waiting }, variant: chosen.variant };
  }
}
