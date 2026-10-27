import type { ReactNode } from "react";
import { formatBytes } from "../format.ts";
import { t } from "../i18n/translate.ts";
import { messageParams } from "../machine.ts";
import type { ApiError } from "../../../shared/api-error.ts";

/** "200 MiB of 683 MiB, 3 MiB per second": the same words for every download. */
function ReceivedLine({ received, size, speed }: { received: number; size: number | null; speed: number | null }) {
  if (size === null) return <p>{formatBytes(received)}</p>;
  return (
    <p>
      {speed !== null && speed > 0
        ? t("local.install.received_speed", { received: formatBytes(received), size: formatBytes(size), speed: formatBytes(speed) })
        : t("local.install.received", { received: formatBytes(received), size: formatBytes(size) })}
    </p>
  );
}

/** Why a download's connection last broke and how often, or null when it never did. */
export function interruptionText(retries: number, lastRetry: ApiError | null): string | null {
  if (retries <= 0 || lastRetry === null) return null;
  return `${t(lastRetry.code, messageParams(lastRetry))} ${t("local.install.retries", { count: retries })}`;
}

export interface DownloadBlockProps {
  /** The line that says what is downloading. It is the label of the bar. */
  title: ReactNode;
  /** Bytes received so far, or null when the download does not say. */
  received: number | null;
  /** Bytes in all, or null when they are not known. */
  size: number | null;
  /** Bytes per second, or null when there is nothing to measure yet. */
  speed: number | null;
  /** The line about the last interruption, or null when the connection never broke. */
  interruption: ReactNode | null;
  progressId: string;
  /** A line after the bytes, for example the parts of an image. */
  extra?: ReactNode;
  /** The bar for a download that does not count bytes but knows its parts. Used while no bytes are received. */
  partsBar?: { value: number; max: number } | null;
}

/**
 * The one block every download shows, in this order: what is downloading, the
 * bar, the bytes and the speed, and the last interruption. Only the first
 * line is announced to a screen reader, so each download is heard once; the
 * counts below it change often and stay silent. A test fails when a screen
 * has a progress bar of its own instead of this block.
 */
export function DownloadBlock({ title, received, size, speed, interruption, progressId, extra, partsBar = null }: DownloadBlockProps) {
  return (
    <div className="download-block" data-download-block="">
      <p role="status">
        <label htmlFor={progressId}>{title}</label>
      </p>
      {received !== null && size !== null ? (
        <progress id={progressId} max={size} value={Math.min(received, size)}></progress>
      ) : received === null && partsBar !== null ? (
        <progress id={progressId} max={partsBar.max} value={partsBar.value}></progress>
      ) : (
        <progress id={progressId}></progress>
      )}
      {received !== null && <ReceivedLine received={received} size={size} speed={speed} />}
      {extra}
      {interruption !== null && <p>{interruption}</p>}
    </div>
  );
}
