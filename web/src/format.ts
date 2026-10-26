const KIB = 1024;
const MIB = KIB ** 2;
const GIB = KIB ** 3;

const countFormat = new Intl.NumberFormat("en");
const gibFormat = new Intl.NumberFormat("en", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const wholeFormat = new Intl.NumberFormat("en", { maximumFractionDigits: 0 });

/** A size in bytes as the operator reads it: MiB with no decimals under 1 GiB, GiB with one decimal from there. */
export function formatBytes(bytes: number): string {
  if (bytes >= GIB) return `${gibFormat.format(bytes / GIB)} GiB`;
  if (bytes >= MIB) return `${wholeFormat.format(bytes / MIB)} MiB`;
  if (bytes >= KIB) return `${wholeFormat.format(bytes / KIB)} KiB`;
  return `${countFormat.format(bytes)} B`;
}

/** A measured number of seconds as minutes and seconds, for example "22 min 46 s". */
export function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return minutes === 0 ? `${rest} s` : `${countFormat.format(minutes)} min ${rest} s`;
}
