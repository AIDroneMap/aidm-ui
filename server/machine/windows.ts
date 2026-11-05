// What the machine check asks Windows itself, through kernel32 and Bun's
// foreign function interface, so that no program and no dependency is needed.
// Each answer is null when the call cannot be made, and the check then says it
// could not tell. Nothing here runs on another system.

import { dlopen, FFIType, ptr, type FFIFunction } from "bun:ffi";

/** PF_AVX2_INSTRUCTIONS_AVAILABLE in winnt.h, for IsProcessorFeaturePresent. */
const PF_AVX2_INSTRUCTIONS_AVAILABLE = 40;

/** IMAGE_FILE_MACHINE_* in winnt.h, named as process.arch names them. */
const MACHINES: Record<number, string> = { 0x8664: "x64", 0xaa64: "arm64" };

/** Opens kernel32 with only the functions one answer needs, so that a function an older Windows lacks spoils no other answer. */
function withKernel32<const S extends Record<string, FFIFunction>, T>(
  symbols: S,
  use: (library: ReturnType<typeof dlopen<S>>["symbols"]) => T,
): T | null {
  try {
    const library = dlopen("kernel32.dll", symbols);
    try {
      return use(library.symbols);
    } finally {
      library.close();
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
export function windowsHasAvx2(): boolean | null {
  return withKernel32(
    { IsProcessorFeaturePresent: { args: [FFIType.u32], returns: FFIType.i32 } },
    (kernel32) => kernel32.IsProcessorFeaturePresent(PF_AVX2_INSTRUCTIONS_AVAILABLE) !== 0,
  );
}

/**
 * The computer's own processor architecture. AIDM UI ships one Windows build,
 * for x86-64, which Windows on ARM runs under emulation, and there
 * process.arch says "x64". The native machine says what the computer is.
 */
export function windowsNativeArch(): string | null {
  const arch = withKernel32(
    {
      GetCurrentProcess: { args: [], returns: FFIType.i64_fast },
      IsWow64Process2: { args: [FFIType.i64, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    },
    (kernel32) => {
      const machines = new Uint16Array(2);
      const ok = kernel32.IsWow64Process2(kernel32.GetCurrentProcess(), ptr(machines), ptr(machines, 2));
      return ok === 0 ? null : (MACHINES[machines[1]!] ?? null);
    },
  );
  return arch ?? null;
}
