import { deflateSync } from "node:zlib";

/** A synthetic triangle with four coloured texture pixels, containing no survey data. */
export function texturedGlb(external = false): Uint8Array<ArrayBuffer> {
  const chunk = (type: string, data: Uint8Array) => {
    const bytes = Buffer.alloc(12 + data.length);
    bytes.writeUInt32BE(data.length, 0); bytes.write(type, 4); bytes.set(data, 8);
    bytes.writeUInt32BE(Bun.hash.crc32(bytes.subarray(4, 8 + data.length)), 8 + data.length);
    return bytes;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(2, 0); header.writeUInt32BE(2, 4); header[8] = 8; header[9] = 6;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
    chunk("IDAT", deflateSync(new Uint8Array([0, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 0, 255, 255, 255, 255, 0, 255]))),
    chunk("IEND", new Uint8Array()),
  ]);
  const vertices = new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 1]);
  const uv = new Float32Array([0, 0, 1, 0, .5, 1]);
  const binaryLength = (vertices.byteLength + uv.byteLength + png.length + 3) & ~3;
  const json = JSON.stringify({
    asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: 0 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [-1, -1, 0], max: [1, 1, 1] },
      { bufferView: 1, componentType: 5126, count: 3, type: "VEC2" },
    ],
    bufferViews: [{ buffer: 0, byteLength: vertices.byteLength }, { buffer: 0, byteOffset: vertices.byteLength, byteLength: uv.byteLength }, { buffer: 0, byteOffset: vertices.byteLength + uv.byteLength, byteLength: png.length }],
    buffers: [{ byteLength: binaryLength, ...(external ? { uri: "https://example.invalid/model.bin" } : {}) }],
    materials: [{ doubleSided: true, pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 1 } }],
    textures: [{ source: 0 }], images: [{ bufferView: 2, mimeType: "image/png" }],
  });
  const encoded = new TextEncoder().encode(json); const jsonLength = (encoded.length + 3) & ~3;
  const bytes = new Uint8Array(28 + jsonLength + binaryLength); const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, bytes.length, true);
  view.setUint32(12, jsonLength, true); view.setUint32(16, 0x4e4f534a, true); bytes.fill(32, 20, 20 + jsonLength); bytes.set(encoded, 20);
  view.setUint32(20 + jsonLength, binaryLength, true); view.setUint32(24 + jsonLength, 0x004e4942, true);
  bytes.set(new Uint8Array(vertices.buffer), 28 + jsonLength); bytes.set(new Uint8Array(uv.buffer), 28 + jsonLength + vertices.byteLength); bytes.set(png, 28 + jsonLength + vertices.byteLength + uv.byteLength);
  return bytes;
}
