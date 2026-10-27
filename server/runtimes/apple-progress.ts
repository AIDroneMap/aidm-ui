/**
 * One progress line of Apple's container tool, read field by field. The
 * format is the tool's own at 1.6.1 (TerminalProgress/ProgressBar.swift):
 *
 *   [1/2] Fetching image 36% (3 of 9 blobs, 215,4/593,9 MB, 1,0 MB/s) [9m 29s]
 *
 * Sizes and speeds come from ByteCountFormatter with the binary count style,
 * so "MB" is 1024 × 1024 bytes, and they follow the Mac's locale: a decimal
 * comma on an Italian Mac, a point on an English one. The item counts are
 * grouped by the locale (1.234 or 1,234). A line may lack any of the parts.
 */
export interface AppleProgress {
  /** "[1/2]": the task under way and how many there are. */
  task: number | null;
  tasks: number | null;
  /** The words between the task and the percentage, e.g. "Fetching image". */
  description: string;
  percent: number | null;
  items: { done: number; total: number | null; name: string } | null;
  /** In bytes. */
  bytes: { done: number; total: number | null } | null;
  /** Bytes per second. */
  speed: number | null;
  elapsedSeconds: number | null;
}

const UNITS: Record<string, number> = {
  byte: 1,
  bytes: 1,
  b: 1,
  kb: 1024,
  mb: 1024 ** 2,
  gb: 1024 ** 3,
  tb: 1024 ** 4,
};

/** A size number has at most one separator, and it is the decimal one: the formatter never groups a value below 1024. */
function sizeNumber(text: string): number | null {
  const normal = text.replace(/[\s  ]/g, "").replace(",", ".");
  return /^\d+(\.\d+)?$/.test(normal) ? Number(normal) : null;
}

/** A count is a whole number, grouped by the locale with points, commas or spaces. */
function countNumber(text: string): number | null {
  const digits = text.replace(/[.,\s  ']/g, "");
  return /^\d+$/.test(digits) ? Number(digits) : null;
}

/** "593,9 MB", "512 bytes" or "Zero KB" in bytes. */
function bytesOf(number: string, unit: string): number | null {
  const scale = UNITS[unit.toLowerCase()];
  if (scale === undefined) return null;
  if (/^zero$/i.test(number)) return 0;
  const value = sizeNumber(number);
  return value === null ? null : Math.round(value * scale);
}

const SIZE = String.raw`(Zero|[\d.,\s  ]+?)\s*(bytes?|[KMGT]?B)`;

function elapsedOf(text: string): number | null {
  const parts = [...text.matchAll(/(\d+)\s*([dhms])/g)];
  if (parts.length === 0 || parts.map((part) => part[0]).join(" ") !== text.trim().replace(/\s+/g, " ")) return null;
  const factor: Record<string, number> = { d: 86_400, h: 3600, m: 60, s: 1 };
  return parts.reduce((sum, part) => sum + Number(part[1]) * (factor[part[2] ?? "s"] ?? 1), 0);
}

/** The fields of one line, or null for a line that is not a progress line. */
export function parseAppleProgress(line: string): AppleProgress | null {
  // The tool colours its line on a terminal; plain output has no escapes, but strip them anyway.
  let rest = line.replace(/\u001b\[[0-9;]*m/g, "").trim();
  const result: AppleProgress = {
    task: null,
    tasks: null,
    description: "",
    percent: null,
    items: null,
    bytes: null,
    speed: null,
    elapsedSeconds: null,
  };

  const tasks = /^\[(\d+)\/(\d+)\]\s*/.exec(rest);
  if (tasks !== null) {
    result.task = Number(tasks[1]);
    result.tasks = Number(tasks[2]);
    rest = rest.slice(tasks[0].length);
  }
  const elapsed = /\s*\[([^\]]+)\]$/.exec(rest);
  if (elapsed !== null) {
    result.elapsedSeconds = elapsedOf(elapsed[1] ?? "");
    if (result.elapsedSeconds !== null) rest = rest.slice(0, elapsed.index);
  }
  const details = /\s*\(([^)]*)\)$/.exec(rest);
  if (details !== null) {
    rest = rest.slice(0, details.index);
    for (const part of (details[1] ?? "").split(/,\s+(?=\d|Zero)/)) {
      const items = /^([\d.,\s  ']+?)(?:\s+of\s+([\d.,\s  ']+?))?\s+([a-z]+)$/i.exec(part.trim());
      const speed = new RegExp(`^${SIZE}/s$`, "i").exec(part.trim());
      const size = new RegExp(`^${SIZE}(?:/${SIZE})?$`, "i").exec(part.trim());
      const combined = new RegExp(String.raw`^([\d.,\s  ]+?)/([\d.,\s  ]+?)\s*(bytes?|[KMGT]?B)$`, "i").exec(part.trim());
      if (speed !== null) {
        result.speed = bytesOf(speed[1] ?? "", speed[2] ?? "");
      } else if (combined !== null) {
        const unit = combined[3] ?? "";
        const done = bytesOf(combined[1] ?? "", unit);
        if (done !== null) result.bytes = { done, total: bytesOf(combined[2] ?? "", unit) };
      } else if (size !== null) {
        const done = bytesOf(size[1] ?? "", size[2] ?? "");
        if (done !== null) result.bytes = { done, total: size[3] === undefined ? null : bytesOf(size[3], size[4] ?? "") };
      } else if (items !== null && UNITS[(items[3] ?? "").toLowerCase()] === undefined) {
        const done = countNumber(items[1] ?? "");
        if (done !== null) result.items = { done, total: items[2] === undefined ? null : countNumber(items[2]), name: items[3] ?? "" };
      }
    }
  }
  const percent = /\s*(\d{1,3})%$/.exec(rest);
  if (percent !== null) {
    result.percent = Number(percent[1]);
    rest = rest.slice(0, percent.index);
  }
  result.description = rest.trim();
  const said = result.task !== null || result.percent !== null || result.items !== null || result.bytes !== null;
  return said ? result : null;
}
