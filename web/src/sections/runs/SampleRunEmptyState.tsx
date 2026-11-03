import { useEffect, useRef, useState } from "react";
import { type SampleEngineOffer, type SampleStartRequest, type SampleView } from "../../../../shared/api-types.ts";
import { api, asApiFailure, type ApiFailure } from "../../api.ts";
import { ErrorMessage } from "../../components/ErrorMessage.tsx";
import { Button } from "../../controls/Button.tsx";
import { EmptyState } from "../../controls/EmptyState.tsx";
import { Select } from "../../controls/Select.tsx";
import { formatBytes } from "../../format.ts";
import { t } from "../../i18n/translate.ts";
import { IconPlay } from "../../icons/icons.tsx";

function engineLabel(engine: SampleEngineOffer): string {
  return engine.local ? t("engines.local_name") : engine.engineName;
}

export function SampleRunEmptyState({ onAuthRequired }: { onAuthRequired(): void }) {
  const [sample, setSample] = useState<SampleView | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [engineId, setEngineId] = useState<number | null>(null);
  const [starting, setStarting] = useState(false);
  const startPending = useRef(false);

  useEffect(() => {
    let current = true;
    api<SampleView>("GET", "/api/sample").then(
      (loaded) => {
        if (!current) return;
        setSample(loaded);
        setEngineId(loaded.engines.find((e) => e.offered)?.engineId ?? null);
      },
      (error: unknown) => {
        if (!current) return;
        const problem = asApiFailure(error);
        if (problem.code === "auth.passphrase_required") onAuthRequired();
        else setFailure(problem);
      },
    );
    return () => { current = false; };
  }, []);

  async function handleStart() {
    if (engineId === null || startPending.current) return;
    startPending.current = true;
    setStarting(true);
    setFailure(null);
    try {
      const view = await api<{ id: number }>("POST", "/api/sample/start", { engineId } satisfies SampleStartRequest);
      location.hash = `#/runs/${view.id}`;
    } catch (error) {
      const problem = asApiFailure(error);
      if (problem.code === "auth.passphrase_required") onAuthRequired();
      else setFailure(problem);
    } finally {
      startPending.current = false;
      setStarting(false);
    }
  }

  const offered = sample?.engines.filter((e) => e.offered) ?? [];
  const noEngine = sample !== null && offered.length === 0;
  const disabled = engineId === null || starting;

  const description = noEngine
    ? t("runs.sample_no_engine")
    : sample !== null
      ? t("runs.sample_description", { size: formatBytes(sample.dataset.size) })
      : t(failure ? "runs.sample_load_failed" : "runs.loading");

  return (
    <EmptyState
      icon={<IconPlay />}
      title={t("runs.empty_title")}
      action={<>
        {offered.length > 0 && (
          <Select
            id="sample-run-engine"
            label={t("runs.sample_engine_label")}
            value={engineId ?? undefined}
            disabled={starting}
            onChange={(e) => setEngineId(Number(e.target.value))}
          >
            {offered.map((e) => (
              <option key={e.engineId} value={e.engineId}>
                {engineLabel(e)}
              </option>
            ))}
          </Select>
        )}
        {failure && <ErrorMessage failure={failure} />}
        <Button disabled={disabled} onClick={() => void handleStart()}>
          {t("runs.sample_start")}
        </Button>
      </>}
    >
      {description}
    </EmptyState>
  );
}
