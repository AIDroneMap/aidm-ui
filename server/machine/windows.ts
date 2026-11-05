// What the machine check asks Windows itself, through kernel32 and Bun's
// foreign function interface, so that no program and no dependency is needed.
// Each answer is null when the call cannot be made, and the check then says it
// could not tell. Nothing here runs on another system.

import { dlopen, FFIType, ptr } from "bun:ffi";

/** PF_AVX2_INSTRUCTIONS_AVAILABLE in winnt.h, for IsProcessorFeaturePresent. */
export const PF_AVX2_INSTRUCTIONS_AVAILABLE = 40;

/** IMAGE_FILE_MACHINE_* in winnt.h, named as process.arch names them. */
export const IMAGE_FILE_MACHINE_AMD64 = 0x8664;
export const IMAGE_FILE_MACHINE_ARM64 = 0xaa64;
const MACHINES: Record<number, string> = { [IMAGE_FILE_MACHINE_AMD64]: "x64", [IMAGE_FILE_MACHINE_ARM64]: "arm64" };

/** IsProcessorFeaturePresent, opened on its own. Returns the BOOL. */
export interface FeatureCall {
  isProcessorFeaturePresent(feature: number): number;
  close(): void;
}

/** IsWow64Process2 for this process. Fills machines[0] with the process's machine and machines[1] with the computer's; returns the BOOL. */
export interface MachineCall {
  isWow64Process2(machines: Uint16Array): number;
  close(): void;
}

// Each answer opens kernel32 with only the functions it needs, so that a
// function an older Windows lacks spoils no other answer.

function openFeatureCall(): FeatureCall {
  const library = dlopen("kernel32.dll", {
    IsProcessorFeaturePresent: { args: [FFIType.u32], returns: FFIType.i32 },
  });
  return {
    isProcessorFeaturePresent: (feature) => library.symbols.IsProcessorFeaturePresent(feature),
    close: () => library.close(),
  };
}

function openMachineCall(): MachineCall {
  const library = dlopen("kernel32.dll", {
    GetCurrentProcess: { args: [], returns: FFIType.i64_fast },
    IsWow64Process2: { args: [FFIType.i64, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  });
  return {
    // The two USHORTs side by side: the second one starts 2 bytes in.
    isWow64Process2: (machines) =>
      library.symbols.IsWow64Process2(library.symbols.GetCurrentProcess(), ptr(machines), ptr(machines, 2)),
    close: () => library.close(),
  };
}

function ask<C extends { close(): void }, T>(open: () => C, use: (call: C) => T): T | null {
  try {
    const call = open();
    try {
      return use(call);
    } finally {
      call.close();
    }
  } catch {
    return null;
  }
}

/**
 * Whether the processor has AVX2, as Windows reports it. Windows has no such
 * flag for FMA, the other half of x86-64-v3, so FMA is not asked; the engine's
 * own start is the last word.
 */
export function windowsHasAvx2(open: () => FeatureCall = openFeatureCall): boolean | null {
  return ask(open, (call) => call.isProcessorFeaturePresent(PF_AVX2_INSTRUCTIONS_AVAILABLE) !== 0);
}

/**
 * The computer's own processor architecture. AIDM UI ships one Windows build,
 * for x86-64, which Windows on ARM runs under emulation, and there
 * process.arch says "x64". The native machine says what the computer is.
 */
export function windowsNativeArch(open: () => MachineCall = openMachineCall): string | null {
  return ask(open, (call) => {
    const machines = new Uint16Array(2);
    if (call.isWow64Process2(machines) === 0) return null;
    return MACHINES[machines[1]!] ?? null;
  });
}
