import { expect, test } from "bun:test";
import { hashBlob } from "./hash.ts";

test("hashes known vectors and block boundaries", async () => {
  for (const [input, expected] of [
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    ["abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq", "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"],
    ["a".repeat(1000000), "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"],
  ] as const) expect(await hashBlob(new Blob([input]))).toBe(expected);
  for (const length of [55, 56, 63, 64, 65, 4097, 256 * 1024 - 1, 256 * 1024, 256 * 1024 + 1]) {
    const bytes = Uint8Array.from({ length }, (_, index) => index % 251);
    expect(await hashBlob(new Blob([bytes]))).toBe(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"));
  }
});

test("reads bounded slices", async () => {
  const blob = new Blob([new Uint8Array(800000)]);
  const sizes: number[] = [];
  const original = blob.slice.bind(blob);
  blob.slice = (start, end, contentType) => {
    const slice = original(start, end, contentType);
    sizes.push(slice.size);
    return slice;
  };
  await hashBlob(blob);
  expect(Math.max(...sizes)).toBeLessThanOrEqual(256 * 1024);
  expect(sizes.length).toBeGreaterThan(1);
});
