import { useEffect, useRef, useState } from "react";
import { Button } from "../controls/Button.tsx";
import { Disclosure } from "../controls/Disclosure.tsx";
import { formatCount } from "../engines.ts";
import { t } from "../i18n/translate.ts";
import { copyText, saveText, wholeLog } from "./log-file.ts";

/** How far from the end, in pixels, the log still counts as scrolled to the end. */
const AT_END = 24;

type Note = "copied" | "copy_failed" | "save_failed";

/**
 * The engine log, folded behind its line count. Open, it follows new lines
 * unless the operator scrolled up to read, and Copy and Save as file take
 * the whole log from the server, not only the lines the page keeps.
 */
export function RunLog({ runId, lines, count, open, onToggle }: { runId: number; lines: string[]; count: number; open: boolean; onToggle: (open: boolean) => void }) {
  const box = useRef<HTMLPreElement>(null);
  const following = useRef(true);
  const [working, setWorking] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  useEffect(() => {
    const element = box.current;
    if (open && element && following.current) element.scrollTop = element.scrollHeight;
  }, [lines, open]);
  const act = async (action: "copy" | "save") => {
    setWorking(true);
    setNote(null);
    try {
      const text = `${(await wholeLog(runId)).join("\n")}\n`;
      if (action === "copy") setNote((await copyText(text)) ? "copied" : "copy_failed");
      else saveText(text, t("run.screen.log.file_name", { id: runId }));
    } catch {
      setNote(action === "copy" ? "copy_failed" : "save_failed");
    } finally {
      setWorking(false);
    }
  };
  return (
    <Disclosure
      id="run-log"
      className="run-band run-log-band"
      open={open}
      onToggle={(event) => onToggle(event.currentTarget.open)}
      label={t(count === 1 ? "run.screen.log.summary_one" : "run.screen.log.summary_other", { count: formatCount(count) })}
    >
      {open && (
        <>
          <div className="run-log-tools">
            <Button variant="secondary" disabled={working} onClick={() => void act("copy")}>{t("run.screen.log.copy")}</Button>
            <Button variant="secondary" disabled={working} onClick={() => void act("save")}>{t("run.screen.log.save")}</Button>
            <span role="status">{note && t(`run.screen.log.${note}`)}</span>
          </div>
          <pre
            ref={box}
            className="run-log"
            role="region"
            aria-label={t("run.screen.log.region")}
            tabIndex={0}
            onScroll={(event) => {
              const element = event.currentTarget;
              following.current = element.scrollHeight - element.scrollTop - element.clientHeight < AT_END;
            }}
          >
            {lines.length === 0 ? t("run.log_empty") : lines.join("\n")}
          </pre>
        </>
      )}
    </Disclosure>
  );
}
