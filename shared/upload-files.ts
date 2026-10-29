// aidm 68c643965349e7e0bb5e2a0595bcbeca645c70fe: modules/context.py and stages/dataset.py.
const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".tif", ".tiff", ".bmp", ".raw", ".dng", ".nef", ".jxl"]);
const videoExtensions = new Set([".mp4", ".mov", ".lrv", ".ts"]);

export type UploadFileKind = "photo" | "mask" | "video" | "ground_control" | "unsupported";

export function classifyUploadFile(relativeName: string): UploadFileKind {
  const name = relativeName.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  const extension = dot < 0 ? "" : name.slice(dot).toLowerCase();
  const stem = dot < 0 ? name : name.slice(0, dot);
  if (extension === ".txt") return "ground_control";
  if (imageExtensions.has(extension)) return stem.endsWith("_mask") ? "mask" : "photo";
  if (videoExtensions.has(extension) && !stem.endsWith("_mask")) return "video";
  return "unsupported";
}
