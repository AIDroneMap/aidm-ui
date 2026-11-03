import { expect, test } from "bun:test";
import { ThumbnailCache } from "./thumbnail-cache.ts";

test("the cache keeps what it was given and tells a missing preview from an unknown photo", () => {
  const cache = new ThumbnailCache(100, 10);
  cache.set("a", Buffer.from("abc"));
  cache.set("b", null);
  expect(cache.get("a")?.toString()).toBe("abc");
  expect(cache.get("b")).toBeNull();
  expect(cache.get("c")).toBeUndefined();
});

test("the cache drops the least recently used previews when the bytes or the count pass the limit", () => {
  const cache = new ThumbnailCache(10, 3);
  cache.set("a", Buffer.alloc(4)); cache.set("b", Buffer.alloc(4));
  cache.get("a");
  cache.set("c", Buffer.alloc(4));
  expect(cache.get("b")).toBeUndefined();
  expect(cache.get("a")).toBeDefined();
  expect(cache.bytes).toBeLessThanOrEqual(10);
  cache.set("d", null); cache.set("e", null); cache.set("f", null);
  expect(cache.size).toBeLessThanOrEqual(3);
  cache.set("big", Buffer.alloc(11));
  expect(cache.get("big")).toBeUndefined();
});
