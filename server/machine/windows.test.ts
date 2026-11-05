import { expect, test } from "bun:test";
import {
  IMAGE_FILE_MACHINE_AMD64,
  IMAGE_FILE_MACHINE_ARM64,
  PF_AVX2_INSTRUCTIONS_AVAILABLE,
  windowsHasAvx2,
  windowsNativeArch,
  type FeatureCall,
  type MachineCall,
} from "./windows.ts";

/** A stand-in for IsProcessorFeaturePresent that answers `present` for AVX2 and records what it was asked. */
function featureCall(present: number | (() => number)) {
  const seen = { asked: [] as number[], closed: 0 };
  const call: FeatureCall = {
    isProcessorFeaturePresent(feature) {
      seen.asked.push(feature);
      return typeof present === "function" ? present() : present;
    },
    close: () => {
      seen.closed += 1;
    },
  };
  return { open: () => call, seen };
}

/** A stand-in for IsWow64Process2 that writes the two machines and returns `ok`. */
function machineCall(processMachine: number, nativeMachine: number, ok = 1) {
  const seen = { closed: 0 };
  const call: MachineCall = {
    isWow64Process2(machines) {
      machines[0] = processMachine;
      machines[1] = nativeMachine;
      return ok;
    },
    close: () => {
      seen.closed += 1;
    },
  };
  return { open: () => call, seen };
}

test("the AVX2 answer asks for feature 40, the AVX2 flag of winnt.h, and closes kernel32", () => {
  expect(PF_AVX2_INSTRUCTIONS_AVAILABLE).toBe(40);
  const present = featureCall(1);
  expect(windowsHasAvx2(present.open)).toBe(true);
  expect(present.seen).toEqual({ asked: [40], closed: 1 });
});

test("a processor without AVX2 is false, and any non-zero BOOL is true", () => {
  expect(windowsHasAvx2(featureCall(0).open)).toBe(false);
  expect(windowsHasAvx2(featureCall(-1).open)).toBe(true);
});

test("AVX2 is unknown when kernel32 cannot be opened or the call fails, and kernel32 is still closed", () => {
  expect(
    windowsHasAvx2(() => {
      throw new Error("no kernel32");
    }),
  ).toBeNull();
  const failing = featureCall(() => {
    throw new Error("call failed");
  });
  expect(windowsHasAvx2(failing.open)).toBeNull();
  expect(failing.seen.closed).toBe(1);
});

test("the native machine is the second value IsWow64Process2 writes, not the process's own", () => {
  expect(IMAGE_FILE_MACHINE_AMD64).toBe(0x8664);
  expect(IMAGE_FILE_MACHINE_ARM64).toBe(0xaa64);
  // x86-64 on x86-64: Windows writes IMAGE_FILE_MACHINE_UNKNOWN (0) for a process that is not under WOW64.
  const x64 = machineCall(0, IMAGE_FILE_MACHINE_AMD64);
  expect(windowsNativeArch(x64.open)).toBe("x64");
  expect(x64.seen.closed).toBe(1);
  // The x86-64 build under emulation on Windows on ARM.
  expect(windowsNativeArch(machineCall(IMAGE_FILE_MACHINE_AMD64, IMAGE_FILE_MACHINE_ARM64).open)).toBe("arm64");
});

test("the native machine is unknown when the call fails, names another machine, or cannot be made", () => {
  const failed = machineCall(0, IMAGE_FILE_MACHINE_AMD64, 0);
  expect(windowsNativeArch(failed.open)).toBeNull();
  expect(failed.seen.closed).toBe(1);
  // IMAGE_FILE_MACHINE_I386: no engine is built for it, and process.arch is kept.
  expect(windowsNativeArch(machineCall(0, 0x014c).open)).toBeNull();
  expect(
    windowsNativeArch(() => {
      throw new Error("no IsWow64Process2");
    }),
  ).toBeNull();
});

test.skipIf(process.platform === "win32")("off Windows the real calls cannot be made, so both answers are unknown", () => {
  expect(windowsHasAvx2()).toBeNull();
  expect(windowsNativeArch()).toBeNull();
});

test.if(process.platform === "win32")("on Windows the real calls answer", () => {
  expect(typeof windowsHasAvx2()).toBe("boolean");
  expect(["x64", "arm64"]).toContain(windowsNativeArch()!);
});
