import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ApiError } from "../shared/api-error.ts";
import { localName, type ImageDownloadOptions, type ImageDownloadOutcome, type PinnedImage } from "../server/images/image-download.ts";
import type { ImageSource } from "../server/packages/container-package.ts";

/** The bytes a fake download says it took, when the test sets none. */
const FAKE_SIZE = 3 * 1024 * 1024;

/**
 * Stands in for the image downloader in tests of the engine manager, which
 * have no registry. A download sends some progress, leaves one file in its
 * folder (so a test can see it go) and gives an image that a FakeRuntime can load.
 */
export class FakeImages implements ImageSource {
  /** Every image asked for, in order. */
  readonly downloads: PinnedImage[] = [];
  private failures: ApiError[] = [];
  /** While set, a download waits for this to resolve or for its signal to fire. */
  private hold: Promise<void> | undefined;

  /** The next downloads fail with these causes, one each. */
  failNext(...causes: ApiError[]): void {
    this.failures.push(...causes);
  }

  /** Makes the next downloads wait. The returned function lets them go on. */
  holdDownloads(): () => void {
    let release = () => {};
    this.hold = new Promise<void>((resolve) => {
      release = () => {
        this.hold = undefined;
        resolve();
      };
    });
    return release;
  }

  async download(pinned: PinnedImage, folder: string, options: ImageDownloadOptions): Promise<ImageDownloadOutcome> {
    this.downloads.push(pinned);
    const total = FAKE_SIZE;
    const progress = (received: number, blobsDone: number) =>
      options.onProgress?.({ received, total, bytesPerSecond: received === 0 ? null : 1_000_000, blobsDone, blobsTotal: 2, retries: 0, lastRetry: null });
    progress(0, 0);
    if (this.hold !== undefined) {
      const aborted = new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve(), { once: true }));
      await Promise.race([this.hold, aborted]);
    }
    if (options.signal?.aborted) return { ok: false, error: { code: "download.cancelled", data: {} } };
    const failure = this.failures.shift();
    if (failure !== undefined) return { ok: false, error: failure };
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "index.json"), "{}\n");
    progress(total / 2, 1);
    progress(total, 2);
    const config = `sha256:${new Bun.CryptoHasher("sha256").update(`config of ${pinned.digest}`).digest("hex")}`;
    return {
      ok: true,
      image: {
        pinned,
        folder,
        name: localName(pinned),
        manifest: { digest: pinned.digest, size: 2, mediaType: "application/vnd.oci.image.manifest.v1+json" },
        config: { digest: config, size: 2 },
        layers: [{ digest: pinned.digest, size: total - 2 }],
      },
    };
  }
}
