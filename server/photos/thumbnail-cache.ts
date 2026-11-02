/**
 * Keeps the previews read most recently. A preview belongs to the checksum of the
 * photo it came from, so it never goes stale; the caller checks that the photo is
 * still the right file before it asks. Null is a photo known to have no preview.
 */
export class ThumbnailCache {
  private readonly entries = new Map<string, Buffer | null>();
  private total = 0;
  constructor(private readonly maxBytes = 16 * 1024 * 1024, private readonly maxEntries = 4096) {}

  get bytes(): number { return this.total; }
  get size(): number { return this.entries.size; }

  get(key: string): Buffer | null | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, value: Buffer | null): void {
    this.delete(key);
    const length = value?.length ?? 0;
    if (length > this.maxBytes) return;
    this.entries.set(key, value);
    this.total += length;
    for (const oldest of this.entries.keys()) {
      if (this.total <= this.maxBytes && this.entries.size <= this.maxEntries) break;
      this.delete(oldest);
    }
  }

  private delete(key: string): void {
    const old = this.entries.get(key);
    if (old === undefined) return;
    this.total -= old?.length ?? 0;
    this.entries.delete(key);
  }
}
