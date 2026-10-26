import { expect, test } from "bun:test";
import { recordedText } from "../../test-support/scripted-runner.ts";
import { missingCpuFeatures } from "./cpu.ts";

test("x86-64 needs avx2 and fma on the flags line", () => {
  expect(missingCpuFeatures("x64", recordedText("cpuinfo", "x86-64-avx2"))).toEqual([]);
  expect(missingCpuFeatures("x64", recordedText("cpuinfo", "x86-64-no-avx2"))).toEqual(["avx2", "fma"]);
});

test("arm64 needs atomics, asimdrdm and crc32 on the Features line", () => {
  expect(missingCpuFeatures("arm64", recordedText("cpuinfo", "arm64-v8-2"))).toEqual([]);
  expect(missingCpuFeatures("arm64", recordedText("cpuinfo", "arm64-v8-0"))).toEqual(["atomics", "asimdrdm"]);
});

test("a feature counts only as a whole word", () => {
  expect(missingCpuFeatures("x64", "flags\t: avx2_vnni fma4\n")).toEqual(["avx2", "fma"]);
});

test("the line is found by its name before the colon, not by position", () => {
  expect(missingCpuFeatures("x64", "model name : a flags : avx2 fma\nflags   : avx2 fma\n")).toEqual([]);
  expect(missingCpuFeatures("x64", recordedText("cpuinfo", "arm64-v8-2"))).toBeNull();
});

test("an architecture the engine is not built for, or no such line, is unknown", () => {
  expect(missingCpuFeatures("ia32", "flags : avx2 fma\n")).toBeNull();
  expect(missingCpuFeatures("x64", "")).toBeNull();
});
