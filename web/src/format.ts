import { t } from "./i18n/translate.ts";

const KIB = 1024;
const MIB = KIB ** 2;
const GIB = KIB ** 3;

const countFormat = new Intl.NumberFormat("en");
const gibFormat = new Intl.NumberFormat("en", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const wholeFormat = new Intl.NumberFormat("en", { maximumFractionDigits: 0 });

/** A size in bytes as the operator reads it: MiB with no decimals under 1 GiB, GiB with one decimal from there. */
export function formatBytes(bytes: number): string {
  if (bytes >= GIB) return t("unit.bytes.gib", { value: gibFormat.format(bytes / GIB) });
  if (bytes >= MIB) return t("unit.bytes.mib", { value: wholeFormat.format(bytes / MIB) });
  if (bytes >= KIB) return t("unit.bytes.kib", { value: wholeFormat.format(bytes / KIB) });
  return t("unit.bytes.b", { value: countFormat.format(bytes) });
}

/** A measured number of seconds as minutes and seconds, for example "22 min 46 s". */
export function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return minutes === 0
    ? t("unit.duration.s", { s: rest })
    : t("unit.duration.min_s", { min: countFormat.format(minutes), s: rest });
}

const clockFormat = new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit" });

/** The time of day of an ISO 8601 instant on this computer's clock, for example "02:05 PM". */
export function formatClock(iso: string): string {
  return clockFormat.format(new Date(iso));
}
