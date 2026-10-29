import { expect, test } from "bun:test";
import { classifyUploadFile } from "./upload-files.ts";

test("classifies the pinned engine file types and case-sensitive masks", () => {
  for (const extension of ["jpg", "jpeg", "png", "tif", "tiff", "bmp", "raw", "dng", "nef", "jxl"]) {
    expect(classifyUploadFile(`flight/image.${extension.toUpperCase()}`)).toBe("photo");
    expect(classifyUploadFile(`flight/image_mask.${extension}`)).toBe("mask");
    expect(classifyUploadFile(`flight/image_MASK.${extension}`)).toBe("photo");
  }
  for (const extension of ["mp4", "mov", "lrv", "ts"]) {
    expect(classifyUploadFile(`flight/video.${extension.toUpperCase()}`)).toBe("video");
    expect(classifyUploadFile(`flight/video_mask.${extension}`)).toBe("unsupported");
  }
  expect(classifyUploadFile("flight/control.TXT")).toBe("ground_control");
  expect(classifyUploadFile("flight/readme.pdf")).toBe("unsupported");
  expect(classifyUploadFile("flight.jpg/image")).toBe("unsupported");
});
