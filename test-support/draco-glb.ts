import { texturedGlb } from "./textured-glb.ts";

// The synthetic triangle was encoded with npm draco3d 1.5.7, published by Google.
export function dracoGlb(): Uint8Array<ArrayBuffer> {
  const original = texturedGlb();
  const view = new DataView(original.buffer);
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(original.subarray(20, 20 + jsonLength)));
  const image = original.subarray(28 + jsonLength + 60, 28 + jsonLength + 60 + json.bufferViews[2].byteLength);
  const compressed = Buffer.from("RFJBQ08CAgEBAAAAAwEBAQAAAQf/AREBAQAC/wAAAAAAAQAJAwAAAAEDCQIAAQAAAIA/AACAvwAAAAAAAAAAAACAPwAAgD8AAIC/AACAvwAAAAAAAIA/AAAAAAAAAD8AAIA/AAAAAAAAAAA=", "base64");
  const imageOffset = (compressed.length + 3) & ~3;
  const binaryLength = (imageOffset + image.length + 3) & ~3;
  json.extensionsUsed = ["KHR_draco_mesh_compression"];
  json.extensionsRequired = ["KHR_draco_mesh_compression"];
  json.meshes[0].primitives[0].extensions = { KHR_draco_mesh_compression: { bufferView: 0, attributes: { POSITION: 0, TEXCOORD_0: 1 } } };
  delete json.accessors[0].bufferView; delete json.accessors[1].bufferView;
  json.bufferViews = [{ buffer: 0, byteLength: compressed.length }, { buffer: 0, byteOffset: imageOffset, byteLength: image.length }];
  json.images[0].bufferView = 1; json.buffers[0].byteLength = binaryLength;
  const encoded = new TextEncoder().encode(JSON.stringify(json));
  const length = (encoded.length + 3) & ~3;
  const result = new Uint8Array(28 + length + binaryLength); const resultView = new DataView(result.buffer);
  resultView.setUint32(0, 0x46546c67, true); resultView.setUint32(4, 2, true); resultView.setUint32(8, result.length, true);
  resultView.setUint32(12, length, true); resultView.setUint32(16, 0x4e4f534a, true); result.fill(32, 20, 20 + length); result.set(encoded, 20);
  resultView.setUint32(20 + length, binaryLength, true); resultView.setUint32(24 + length, 0x004e4942, true);
  result.set(compressed, 28 + length); result.set(image, 28 + length + imageOffset);
  return result;
}
