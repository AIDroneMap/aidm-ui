// The engine's own rule, mirrored here so that the wizard refuses a computer
// before the engine would refuse to start: modules/cpu.py in the aidm
// repository (branch build/modern-cpu-target, commit f681f88e), requirements
// at lines 16-31, cpu_features and missing_features at lines 44-66. It reads
// the first line of /proc/cpuinfo whose name before the colon, trimmed, equals
// the field, and splits its value on white space.

const REQUIRED: Record<string, { field: string; features: string[] }> = {
  // x86-64-v3: AVX2 and FMA, from 2013.
  x64: { field: "flags", features: ["avx2", "fma"] },
  // armv8.2-a, which Linux lists as atomics, asimdrdm and crc32.
  arm64: { field: "Features", features: ["atomics", "asimdrdm", "crc32"] },
};

/**
 * The features the engine needs and this CPU lacks, or null when we cannot
 * tell: an architecture the engine does not build for, or no such line. The
 * engine itself treats a missing line as fine and starts; the wizard says
 * "unknown" instead of "ok", which is the more honest answer.
 */
export function missingCpuFeatures(arch: string, cpuInfo: string): string[] | null {
  const rule = REQUIRED[arch];
  if (rule === undefined) return null;
  for (const line of cpuInfo.split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0 || line.slice(0, colon).trim() !== rule.field) continue;
    const present = new Set(line.slice(colon + 1).split(/\s+/).filter((feature) => feature !== ""));
    return rule.features.filter((feature) => !present.has(feature));
  }
  return null;
}
