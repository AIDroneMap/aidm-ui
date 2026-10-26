import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, asApiFailure, type ApiFailure } from "../api.ts";
import { ErrorMessage } from "../components/ErrorMessage.tsx";
import { formatCount, formatMemory, parseEngineList } from "../engines.ts";
import { t } from "../i18n/translate.ts";
import {
  MIN_TASK_API_VERSION,
  type EngineAddRequest,
  type EngineEditRequest,
  type EngineInfoView,
  type EngineTestRequest,
  type EngineTestView,
  type EngineView,
} from "../../../shared/api-types.ts";
import type { ApiError } from "../../../shared/api-error.ts";

// Server data of any shape; only strings and numbers can fill a placeholder.
function params(data: Record<string, unknown>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === "string" || typeof value === "number") out[key] = value;
  }
  return out;
}

/** What the engine itself said, when it answered with an error. */
function EngineSaid({ error }: { error: ApiError }) {
  const message = error.data["message"];
  if (error.code !== "engine.error" || typeof message !== "string") return null;
  return <p className="engine-said">{t("engine.error_detail", { message })}</p>;
}

/** A problem or a warning from a stored engine. It is not an alert: the list changes on its own. */
function EngineNote({ error, kind }: { error: ApiError; kind: "problem" | "warning" }) {
  return (
    <div className={kind === "problem" ? "error" : "warning"}>
      <p>{t(error.code, params(error.data))}</p>
      <EngineSaid error={error} />
    </div>
  );
}

function EngineInfo({ info, supported }: { info: EngineInfoView; supported: boolean | null }) {
  return (
    <>
      <ul className="engine-facts">
        <li>{t("engine.info.api_version", { version: info.version })}</li>
        {info.engineVersion !== null && <li>{t("engine.info.engine_version", { version: info.engineVersion })}</li>}
        {info.cpuCores !== null && <li>{t("engine.info.cores", { count: formatCount(info.cpuCores) })}</li>}
        {info.totalMemory !== null && <li>{t("engine.info.memory", { size: formatMemory(info.totalMemory) })}</li>}
        {info.queueCount !== null && <li>{t("engine.info.queue", { count: formatCount(info.queueCount) })}</li>}
      </ul>
      {supported === false && (
        <p className="warning">
          <strong>{t("engine.not_supported")}</strong>{" "}
          {t("engine.unsupported_version", { version: info.version, minimum: MIN_TASK_API_VERSION })}
        </p>
      )}
    </>
  );
}

export interface EngineListProps {
  engines: EngineView[];
  /** The engine waiting for the operator to confirm its removal, or null. */
  askingToRemove: number | null;
  onEdit: (engine: EngineView) => void;
  onSetEnabled: (engine: EngineView, enabled: boolean) => void;
  onAskRemove: (engine: EngineView) => void;
  onConfirmRemove: (engine: EngineView) => void;
  onKeep: (engine: EngineView) => void;
}

export function EngineList(props: EngineListProps) {
  if (props.engines.length === 0) return <p>{t("engines.empty")}</p>;
  return (
    <ul className="engine-list" aria-label={t("engines.list_label")}>
      {props.engines.map((engine) => (
        <li key={engine.id} className="engine">
          <h2>{engine.name}</h2>
          <p>
            <code>{engine.address}</code>
            {engine.kind === "local" && <span className="badge">{t("engines.local")}</span>}
          </p>
          <p>
            <span className="state">{t("engines.state", { state: t(`engine.state.${engine.state}`) })}</span>
            {!engine.enabled && <span className="badge">{t("engines.disabled")}</span>}
          </p>
          {engine.info && <EngineInfo info={engine.info} supported={engine.supported} />}
          {engine.problem && <EngineNote error={engine.problem} kind="problem" />}
          {engine.warning && <EngineNote error={engine.warning} kind="warning" />}
          {props.askingToRemove === engine.id ? (
            <div role="group" aria-label={t("engines.remove_ask", { name: engine.name })} className="actions">
              <p>{t("engines.remove_ask", { name: engine.name })}</p>
              <button
                type="button"
                aria-label={t("engines.remove_confirm_named", { name: engine.name })}
                onClick={() => props.onConfirmRemove(engine)}
              >
                {t("engines.remove_confirm")}
              </button>
              <button
                type="button"
                className="secondary"
                aria-label={t("engines.remove_keep_named", { name: engine.name })}
                onClick={() => props.onKeep(engine)}
              >
                {t("engines.remove_keep")}
              </button>
            </div>
          ) : (
            <div className="actions">
              <button
                type="button"
                className="secondary"
                aria-label={t("engines.edit_named", { name: engine.name })}
                onClick={() => props.onEdit(engine)}
              >
                {t("engines.edit")}
              </button>
              <button
                type="button"
                className="secondary"
                aria-label={t(engine.enabled ? "engines.disable_named" : "engines.enable_named", { name: engine.name })}
                onClick={() => props.onSetEnabled(engine, !engine.enabled)}
              >
                {t(engine.enabled ? "engines.disable" : "engines.enable")}
              </button>
              <button
                type="button"
                className="secondary"
                aria-label={t("engines.remove_named", { name: engine.name })}
                onClick={() => props.onAskRemove(engine)}
              >
                {t("engines.remove")}
              </button>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

export interface EngineFormProps {
  mode: "add" | "edit";
  name: string;
  address: string;
  token: string;
  onNameChange: (value: string) => void;
  onAddressChange: (value: string) => void;
  onTokenChange: (value: string) => void;
  /** What the engine reported to the last test, or null. */
  test: EngineTestView | null;
  failure: ApiFailure | null;
  testing: boolean;
  saving: boolean;
  onTest: () => void;
  onSave: () => void;
  onCancel: () => void;
}

const ADDRESS_CODES: readonly string[] = ["engine.address_invalid", "engine.https_required"];

export function EngineForm(props: EngineFormProps) {
  const addressInvalid = props.failure !== null && ADDRESS_CODES.includes(props.failure.code);
  const busy = props.testing || props.saving;
  // In edit mode the stored token is not known here, so a test needs the token typed again.
  const cannotTest = props.mode === "edit" && props.token === "";
  const submit = (event: FormEvent) => {
    event.preventDefault();
    props.onSave();
  };
  return (
    <form onSubmit={submit} aria-labelledby="engine-form-title">
      <h2 id="engine-form-title">{t(props.mode === "add" ? "engine.form.add_title" : "engine.form.edit_title")}</h2>
      <div className="field">
        <label htmlFor="engine-name">{t("engine.form.name")}</label>
        <input
          id="engine-name"
          type="text"
          autoComplete="off"
          value={props.name}
          onChange={(event) => props.onNameChange(event.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="engine-address">{t("engine.form.address")}</label>
        <input
          id="engine-address"
          type="text"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-invalid={addressInvalid ? "true" : undefined}
          aria-describedby={addressInvalid ? "engine-address-hint engine-form-error" : "engine-address-hint"}
          value={props.address}
          onChange={(event) => props.onAddressChange(event.target.value)}
        />
        <p id="engine-address-hint" className="hint">
          {t("engine.form.address_hint")}
        </p>
      </div>
      <div className="field">
        <label htmlFor="engine-token">{t("engine.form.token")}</label>
        <input
          id="engine-token"
          type="password"
          autoComplete="off"
          aria-describedby="engine-token-hint"
          value={props.token}
          onChange={(event) => props.onTokenChange(event.target.value)}
        />
        <p id="engine-token-hint" className="hint">
          {t(props.mode === "add" ? "engine.form.token_hint_add" : "engine.form.token_hint_edit")}
        </p>
      </div>

      {props.failure && (
        <>
          <ErrorMessage failure={props.failure} id="engine-form-error" />
          <EngineSaid error={{ code: props.failure.code as ApiError["code"], data: props.failure.data }} />
        </>
      )}

      <div role="status">
        {props.test && (
          <>
            <p>{t("engine.form.test_ok")}</p>
            <EngineInfo info={props.test.info} supported={props.test.supported} />
            {props.test.warning && <EngineNote error={props.test.warning} kind="warning" />}
          </>
        )}
      </div>

      <div className="actions">
        <button type="button" className="secondary" disabled={busy || cannotTest} onClick={props.onTest}>
          {props.testing ? t("engine.form.testing") : t("engine.form.test")}
        </button>
        <button type="submit" disabled={busy}>
          {props.saving ? t("common.saving") : t("engine.form.save")}
        </button>
        <button type="button" className="secondary" onClick={props.onCancel}>
          {t("engine.form.cancel")}
        </button>
      </div>
    </form>
  );
}

interface FormState {
  /** The engine being edited, or null when adding. */
  id: number | null;
  name: string;
  address: string;
  token: string;
  test: EngineTestView | null;
  failure: ApiFailure | null;
  testing: boolean;
  saving: boolean;
}

const EMPTY_FORM: FormState = {
  id: null,
  name: "",
  address: "",
  token: "",
  test: null,
  failure: null,
  testing: false,
  saving: false,
};

function byId(a: EngineView, b: EngineView): number {
  return a.id - b.id;
}

export function EnginesPage({ onAuthRequired }: { onAuthRequired: () => void }) {
  const [engines, setEngines] = useState<EngineView[] | null>(null);
  const [live, setLive] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [askingToRemove, setAskingToRemove] = useState<number | null>(null);
  // The latest callback, so the long-lived effects below never call a stale one.
  const authRequired = useRef(onAuthRequired);
  authRequired.current = onAuthRequired;

  const fail = (error: unknown): ApiFailure => {
    const result = asApiFailure(error);
    if (result.code === "auth.passphrase_required") authRequired.current();
    return result;
  };

  useEffect(() => {
    let current = true;
    api<EngineView[]>("GET", "/api/engines").then(
      (loaded) => {
        // A live update may have arrived first and is newer.
        if (current) setEngines((existing) => existing ?? [...loaded].sort(byId));
      },
      (error: unknown) => {
        if (current) setFailure(fail(error));
      },
    );
    const source = new EventSource("/api/engines/events");
    source.onopen = () => setLive(true);
    source.onerror = () => setLive(false);
    source.addEventListener("engines", (event) => {
      const list = parseEngineList((event as MessageEvent<string>).data);
      if (list && current) {
        setEngines([...list].sort(byId));
        setLive(true);
      }
    });
    return () => {
      current = false;
      source.close();
    };
  }, []);

  const change = (patch: Partial<FormState>) =>
    setForm((existing) => (existing ? { ...existing, ...patch } : existing));
  // Changing a field makes the last test and failure out of date.
  const edit = (patch: Partial<FormState>) => change({ ...patch, test: null, failure: null });

  const replace = (view: EngineView) =>
    setEngines((existing) => [...(existing ?? []).filter((engine) => engine.id !== view.id), view].sort(byId));

  const test = async () => {
    if (!form) return;
    change({ testing: true, failure: null, test: null });
    const request: EngineTestRequest = { address: form.address.trim(), token: form.token };
    try {
      change({ test: await api<EngineTestView>("POST", "/api/engines/test", request) });
    } catch (error) {
      change({ failure: fail(error) });
    } finally {
      change({ testing: false });
    }
  };

  const save = async () => {
    if (!form) return;
    change({ saving: true, failure: null });
    try {
      if (form.id === null) {
        const request: EngineAddRequest = { name: form.name.trim(), address: form.address.trim(), token: form.token };
        replace(await api<EngineView>("POST", "/api/engines", request));
      } else {
        const request: EngineEditRequest = { name: form.name.trim(), address: form.address.trim() };
        if (form.token !== "") request.token = form.token;
        replace(await api<EngineView>("PUT", `/api/engines/${form.id}`, request));
      }
      setForm(null);
    } catch (error) {
      change({ failure: fail(error), saving: false });
    }
  };

  const setEnabled = async (engine: EngineView, enabled: boolean) => {
    setFailure(null);
    try {
      replace(await api<EngineView>("PUT", `/api/engines/${engine.id}`, { enabled } satisfies EngineEditRequest));
    } catch (error) {
      setFailure(fail(error));
    }
  };

  const remove = async (engine: EngineView) => {
    setFailure(null);
    setAskingToRemove(null);
    try {
      await api<void>("DELETE", `/api/engines/${engine.id}`);
      setEngines((existing) => (existing ?? []).filter((other) => other.id !== engine.id));
      if (form?.id === engine.id) setForm(null);
    } catch (error) {
      setFailure(fail(error));
    }
  };

  return (
    <>
      <h1>{t("engines.title")}</h1>
      {!live && <p role="status" className="hint">{t("engines.live_paused")}</p>}
      {failure && <ErrorMessage failure={failure} />}
      {engines === null ? (
        !failure && <p>{t("engines.loading")}</p>
      ) : (
        <EngineList
          engines={engines}
          askingToRemove={askingToRemove}
          onEdit={(engine) => {
            setAskingToRemove(null);
            setForm({ ...EMPTY_FORM, id: engine.id, name: engine.name, address: engine.address });
          }}
          onSetEnabled={(engine, enabled) => void setEnabled(engine, enabled)}
          onAskRemove={(engine) => setAskingToRemove(engine.id)}
          onConfirmRemove={(engine) => void remove(engine)}
          onKeep={() => setAskingToRemove(null)}
        />
      )}
      <section aria-label={t("engines.add")}>
        {form ? (
          <EngineForm
            mode={form.id === null ? "add" : "edit"}
            name={form.name}
            address={form.address}
            token={form.token}
            onNameChange={(name) => edit({ name })}
            onAddressChange={(address) => edit({ address })}
            onTokenChange={(token) => edit({ token })}
            test={form.test}
            failure={form.failure}
            testing={form.testing}
            saving={form.saving}
            onTest={() => void test()}
            onSave={() => void save()}
            onCancel={() => setForm(null)}
          />
        ) : (
          <button type="button" onClick={() => setForm({ ...EMPTY_FORM })}>
            {t("engines.add")}
          </button>
        )}
      </section>
    </>
  );
}
