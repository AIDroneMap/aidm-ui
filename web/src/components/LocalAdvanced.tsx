import { useEffect, useState, type FormEvent } from "react";
import { api, asApiFailure, type ApiFailure } from "../api.ts";
import { formatBytes } from "../format.ts";
import { t } from "../i18n/translate.ts";
import { capsRequest, gibDraft, memoryInputMax } from "../localEngine.ts";
import { messageParams } from "../machine.ts";
import { BusyButton } from "./BusyButton.tsx";
import type { LocalEngineView, RuntimeChoiceRequest, RuntimeId } from "../../../shared/api-types.ts";

/** The words for a refusal. The server sends memory limits in bytes; the operator reads GiB. */
export function failureText(failure: ApiFailure): string {
  if (failure.code === "caps.memory_invalid") {
    const { min, max } = failure.data;
    if (typeof min === "number" && typeof max === "number") {
      return t(failure.code, { min: formatBytes(min), max: formatBytes(max) });
    }
  }
  return t(failure.code, messageParams(failure));
}

function Applied({ view }: { view: LocalEngineView }) {
  const { applied } = view.caps;
  if (!applied) return <p>{t("local.advanced.not_running")}</p>;
  return (
    <p>
      {t("local.advanced.applied", {
        memory: applied.memoryBytes === null ? t("local.advanced.no_limit") : formatBytes(applied.memoryBytes),
        cpus: applied.cpus === null ? t("local.advanced.no_limit") : applied.cpus,
      })}
    </p>
  );
}

export interface AdvancedFormProps {
  view: LocalEngineView;
  /** The memory in GiB and the cores as typed. */
  memoryDraft: string;
  cpusDraft: string;
  onMemoryDraftChange: (value: string) => void;
  onCpusDraftChange: (value: string) => void;
  saving: boolean;
  /** True just after the limits were saved. */
  saved: boolean;
  failure: ApiFailure | null;
  onSave: () => void;
  runtimeSaving: boolean;
  runtimeSaved: boolean;
  runtimeFailure: ApiFailure | null;
  onRuntimeChange: (runtime: RuntimeId | null) => void;
}

const MIN_MEMORY_GIB = 1;

export function AdvancedForm(props: AdvancedFormProps) {
  const { view } = props;
  const { caps } = view;
  const memoryInvalid = props.failure?.code === "caps.memory_invalid";
  const cpusInvalid = props.failure?.code === "caps.cpus_invalid";
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!props.saving) props.onSave();
  };
  const choices = view.runtime.available;
  return (
    <section id="local-advanced" aria-labelledby="local-advanced-title">
      <h2 id="local-advanced-title">{t("local.advanced.title")}</h2>
      <p>{t("local.advanced.intro")}</p>

      {/* The browser's own number check is off: the answer to a wrong number is a sentence with the limits. */}
      <form onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor="local-memory">{t("local.advanced.memory")}</label>
          <input
            id="local-memory"
            type="number"
            inputMode="decimal"
            step={0.5}
            min={MIN_MEMORY_GIB}
            max={memoryInputMax(caps.maxMemoryBytes)}
            aria-invalid={memoryInvalid ? "true" : undefined}
            aria-describedby={memoryInvalid ? "local-memory-hint local-caps-error" : "local-memory-hint"}
            value={props.memoryDraft}
            onChange={(event) => props.onMemoryDraftChange(event.target.value)}
          />
          <p id="local-memory-hint" className="hint">
            {t("local.advanced.memory_hint", { max: formatBytes(caps.maxMemoryBytes) })}
          </p>
        </div>
        <div className="field">
          <label htmlFor="local-cpus">{t("local.advanced.cpus")}</label>
          <input
            id="local-cpus"
            type="number"
            inputMode="numeric"
            step={1}
            min={1}
            max={caps.maxCpus}
            aria-invalid={cpusInvalid ? "true" : undefined}
            aria-describedby={cpusInvalid ? "local-cpus-hint local-caps-error" : "local-cpus-hint"}
            value={props.cpusDraft}
            onChange={(event) => props.onCpusDraftChange(event.target.value)}
          />
          <p id="local-cpus-hint" className="hint">
            {t("local.advanced.cpus_hint", { max: caps.maxCpus })}
          </p>
        </div>
        <Applied view={view} />
        <p>{t("local.advanced.next_start")}</p>
        {props.failure && (
          <p id="local-caps-error" role="alert" className="error">
            {failureText(props.failure)}
          </p>
        )}
        <div className="actions">
          <BusyButton busy={props.saving} onClick={props.onSave}>
            {props.saving ? t("common.saving") : t("local.advanced.save")}
          </BusyButton>
        </div>
        <p role="status">{props.saved ? t("local.advanced.saved") : ""}</p>
      </form>

      {choices.length > 1 && (
        <fieldset aria-describedby="local-runtime-hint">
          <legend>{t("local.runtime.legend")}</legend>
          {([null, ...choices] as (RuntimeId | null)[]).map((choice) => {
            const id = `local-runtime-${choice ?? "auto"}`;
            return (
              <div className="check" key={id}>
                <input
                  id={id}
                  type="radio"
                  name="local-runtime"
                  value={choice ?? "auto"}
                  checked={view.runtime.preferred === choice}
                  aria-disabled={props.runtimeSaving ? "true" : undefined}
                  onChange={() => {
                    if (!props.runtimeSaving) props.onRuntimeChange(choice);
                  }}
                />
                <label htmlFor={id}>{t(choice === null ? "local.runtime.auto" : `local.runtime.${choice}`)}</label>
              </div>
            );
          })}
          <p id="local-runtime-hint" className="hint">
            {t("local.runtime.hint")}
          </p>
          {props.runtimeFailure && (
            <p role="alert" className="error">
              {failureText(props.runtimeFailure)}
            </p>
          )}
          <p role="status">{props.runtimeSaved ? t("local.runtime.saved") : ""}</p>
        </fieldset>
      )}
    </section>
  );
}

/** The advanced options with their state: the drafts, the saving and the answers. */
export function LocalAdvanced(props: {
  view: LocalEngineView;
  onView: (view: LocalEngineView) => void;
  onAuthRequired: () => void;
}) {
  const { view } = props;
  const [memoryDraft, setMemoryDraft] = useState(gibDraft(view.caps.memoryBytes));
  const [cpusDraft, setCpusDraft] = useState(String(view.caps.cpus));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [runtimeSaving, setRuntimeSaving] = useState(false);
  const [runtimeSaved, setRuntimeSaved] = useState(false);
  const [runtimeFailure, setRuntimeFailure] = useState<ApiFailure | null>(null);

  // What the server holds is the truth: a saved change, or one made elsewhere, replaces the drafts.
  useEffect(() => {
    setMemoryDraft(gibDraft(view.caps.memoryBytes));
    setCpusDraft(String(view.caps.cpus));
  }, [view.caps.memoryBytes, view.caps.cpus]);

  const fail = (error: unknown): ApiFailure => {
    const result = asApiFailure(error);
    if (result.code === "auth.passphrase_required") props.onAuthRequired();
    return result;
  };

  const save = async () => {
    setSaved(false);
    const checked = capsRequest(memoryDraft, cpusDraft, view.caps);
    if ("failure" in checked) {
      setFailure(checked.failure);
      return;
    }
    setSaving(true);
    setFailure(null);
    try {
      props.onView(await api<LocalEngineView>("PUT", "/api/local-engine/caps", checked.request));
      setSaved(true);
    } catch (error) {
      setFailure(fail(error));
    } finally {
      setSaving(false);
    }
  };

  const chooseRuntime = async (runtime: RuntimeId | null) => {
    setRuntimeSaving(true);
    setRuntimeSaved(false);
    setRuntimeFailure(null);
    try {
      const body: RuntimeChoiceRequest = { runtime };
      await api<unknown>("PUT", "/api/settings/runtime", body);
      props.onView({ ...view, runtime: { ...view.runtime, preferred: runtime } });
      setRuntimeSaved(true);
    } catch (error) {
      setRuntimeFailure(fail(error));
    } finally {
      setRuntimeSaving(false);
    }
  };

  return (
    <AdvancedForm
      view={view}
      memoryDraft={memoryDraft}
      cpusDraft={cpusDraft}
      onMemoryDraftChange={(value) => {
        setMemoryDraft(value);
        setSaved(false);
        setFailure(null);
      }}
      onCpusDraftChange={(value) => {
        setCpusDraft(value);
        setSaved(false);
        setFailure(null);
      }}
      saving={saving}
      saved={saved}
      failure={failure}
      onSave={() => void save()}
      runtimeSaving={runtimeSaving}
      runtimeSaved={runtimeSaved}
      runtimeFailure={runtimeFailure}
      onRuntimeChange={(runtime) => void chooseRuntime(runtime)}
    />
  );
}
