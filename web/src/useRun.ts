import { useEffect, useRef, useState } from "react";
import { api, asApiFailure, type ApiFailure } from "./api.ts";
import { EMPTY_LOG, isFinished, isRunView, mergeLog, parseLogEvent, parseRunEvent, type LogLines } from "./runs.ts";
import type { RunLogView, RunView } from "../../shared/api-types.ts";

export function useRun(onAuthRequired: () => void) {
  const [run, setRun] = useState<RunView | null>(null);
  const [log, setLog] = useState<LogLines>(EMPTY_LOG);
  const [restartedAtLine, setRestartedAtLine] = useState<number | null>(null);
  const [connectionLost, setConnectionLost] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  // The latest callback, so the long-lived effects below never call a stale one.
  const authRequired = useRef(onAuthRequired);
  authRequired.current = onAuthRequired;
  // Lines held so far, readable from event handlers without a stale value.
  const logCount = useRef(0);
  logCount.current = log.count;

  const fail = (error: unknown): ApiFailure => {
    const result = asApiFailure(error);
    if (result.code === "auth.passphrase_required") authRequired.current();
    return result;
  };

  const runId = run?.id ?? null;
  useEffect(() => {
    if (runId === null) return;
    let current = true;
    setLog(EMPTY_LOG);
    setRestartedAtLine(null);
    logCount.current = 0;
    let seenRestartedAtLine: number | null = null;
    const catchUp = (start?: number) => {
      const from = start ?? logCount.current;
      api<RunLogView>("GET", `/api/runs/${runId}/log?from=${from}`).then(
        (view) => {
          if (!current) return;
          setRestartedAtLine(view.restartedAtLine ?? null);
          setLog((existing) => mergeLog(existing, from, view.lines));
          // The server sends at most one page of lines, so ask again from where it ended.
          if (view.next > from) catchUp(view.next);
        },
        () => {
          // The live connection will bring the lines; nothing to show for a failed catch-up.
        },
      );
    };
    catchUp();
    const source = new EventSource(`/api/runs/${runId}/events`);
    source.onopen = () => setConnectionLost(false);
    source.onerror = () => setConnectionLost(true);
    source.addEventListener("run", (event) => {
      const view = parseRunEvent((event as MessageEvent<string>).data);
      if (!view || !current) return;
      setRun(view);
      setConnectionLost(false);
      // Only the log route has the lines the separator sits between, so ask again whenever the engine restarts, also a second time.
      const restartedAt = view.restartedAtLine ?? null;
      if (restartedAt !== seenRestartedAtLine) catchUp();
      seenRestartedAtLine = restartedAt;
      if (isFinished(view)) {
        catchUp();
        source.close();
      }
    });
    source.addEventListener("log", (event) => {
      const block = parseLogEvent((event as MessageEvent<string>).data);
      if (!block || !current) return;
      if (block.from > logCount.current) {
        catchUp();
        return;
      }
      setLog((existing) => mergeLog(existing, block.from, block.lines));
    });
    return () => {
      current = false;
      source.close();
    };
  }, [runId]);

  const cancel = async () => {
    if (run === null) return;
    setCancelling(true);
    setFailure(null);
    try {
      const answer = await api<unknown>("POST", `/api/runs/${run.id}/cancel`);
      if (isRunView(answer)) setRun(answer);
    } catch (error) {
      setFailure(fail(error));
    } finally {
      setCancelling(false);
    }
  };

  return { run, setRun, log, restartedAtLine, connectionLost, cancelling, failure, setFailure, fail, cancel };
}
