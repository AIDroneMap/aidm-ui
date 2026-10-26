import { MIN_TASK_API_VERSION } from "../../shared/api-types.ts";

interface ParsedVersion {
  numbers: number[];
  /** The part after the first dash, such as "rc1"; empty for a release. */
  preRelease: string[];
}

function parseVersion(version: string): ParsedVersion | null {
  const match = /^(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?$/.exec(version.trim());
  if (!match) return null;
  return {
    numbers: (match[1] as string).split(".").map(Number),
    preRelease: match[2] === undefined ? [] : match[2].split("."),
  };
}

function compareIdentifier(a: string, b: string): number {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) return Math.sign(Number(a) - Number(b));
  // A number sorts before a word, as in semantic versioning.
  if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Negative when a is older than b, zero when equal, positive when newer.
 * Dotted numbers, with an optional dash suffix that sorts before the release.
 * Throws RangeError for text that is not a version.
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) throw new RangeError(`Not a version: ${left ? b : a}`);

  const length = Math.max(left.numbers.length, right.numbers.length);
  for (let i = 0; i < length; i++) {
    const difference = (left.numbers[i] ?? 0) - (right.numbers[i] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  if (left.preRelease.length === 0 && right.preRelease.length === 0) return 0;
  if (left.preRelease.length === 0) return 1;
  if (right.preRelease.length === 0) return -1;
  const shared = Math.min(left.preRelease.length, right.preRelease.length);
  for (let i = 0; i < shared; i++) {
    const result = compareIdentifier(left.preRelease[i] as string, right.preRelease[i] as string);
    if (result !== 0) return result;
  }
  return Math.sign(left.preRelease.length - right.preRelease.length);
}

/** True when the text is a version this code can compare. */
export function isReadableVersion(version: string): boolean {
  return parseVersion(version) !== null;
}

/** True for a version at or above the oldest task API the interface works with. A version we cannot read is not supported. */
export function isSupportedVersion(version: string): boolean {
  if (!isReadableVersion(version)) return false;
  return compareVersions(version, MIN_TASK_API_VERSION) >= 0;
}
