import type { RunLogView } from "../../../shared/api-types.ts";
import { api } from "../api.ts";

/** Every line of a run's log, read page by page from the server, which holds more than the page keeps. */
export async function wholeLog(runId: number): Promise<string[]> {
  const lines: string[] = [];
  let from = 0;
  for (;;) {
    const page = await api<RunLogView>("GET", `/api/runs/${runId}/log?from=${from}`);
    lines.push(...page.lines);
    if (page.lines.length === 0 || page.next <= from) return lines;
    from = page.next;
  }
}

/**
 * Puts text on the clipboard. The clipboard API exists only on a secure
 * page, and AIDM UI is often opened by a plain address on the local network,
 * so a selected text area is copied there instead. Focus goes back where it was.
 */
export async function copyText(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Refused, for instance without a user gesture: try the selection below.
    }
  }
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const area = document.createElement("textarea");
  area.value = text;
  area.readOnly = true;
  area.className = "visually-hidden";
  document.body.append(area);
  area.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
    active?.focus();
  }
}

/** Offers text as a file to save, under the given name. */
export function saveText(text: string, fileName: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  // The browser reads the file after the click returns, so the address stays valid a little longer.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
