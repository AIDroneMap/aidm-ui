import { Button } from "../controls/Button.tsx";
import { EmptyState } from "../controls/EmptyState.tsx";
import { Notice } from "../controls/Notice.tsx";
import { TextField } from "../controls/TextField.tsx";
import { ENGINE_STATE_TONES, StatusPill } from "../controls/StatusPill.tsx";
import { IconCpu, IconPlus } from "../icons/icons.tsx";
import { useEffect, useRef, useState, type FormEvent, type ReactNode, type Ref } from "react";
import { api, asApiFailure, type ApiFailure } from "../api.ts";
import { ConnectionHelp } from "../components/ConnectionHelp.tsx";
import { EngineLog } from "../components/EngineLog.tsx";
import { ErrorMessage } from "../components/ErrorMessage.tsx";
import { LocalAdvanced } from "../components/LocalAdvanced.tsx";
import { LocalSwitch } from "../components/LocalSwitch.tsx";
import { formatCount, formatMemory, parseEngineList, sameAddress, stateChanges } from "../engines.ts";
import { t } from "../i18n/translate.ts";
import { useEngineLog, useLocalEngine } from "../localEngine.ts";
import { ScreenLoading } from "./ScreenLoading.tsx";
import "./engines.css";
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
function EngineSaid({ error }: { error: { code: string; data: Record<string, unknown> } }) {
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

/** The question before a removal. Focus goes to its first button, because the button that opened it is gone. */
function RemoveAsk(props: {
  engine: EngineView;
  onConfirm: (engine: EngineView) => void;
  onKeep: (engine: EngineView) => void;
}) {
  const { engine } = props;
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => first.current?.focus(), []);
  return (
    <div role="group" aria-label={t("engines.remove_ask", { name: engine.name })} className="actions">
      <p>{t("engines.remove_ask", { name: engine.name })}</p>
      <Button
        ref={first}
        type="button"
        variant="danger"
        aria-label={t("engines.remove_confirm_named", { name: engine.name })}
        onClick={() => props.onConfirm(engine)}
      >
        {t("engines.remove_confirm")}
      </Button>
      <Button
        type="button"
        className="secondary"
        aria-label={t("engines.remove_keep_named", { name: engine.name })}
        onClick={() => props.onKeep(engine)}
      >
        {t("engines.remove_keep")}
      </Button>
    </div>
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
  /** The engine log of the local engine, when the page has it. */
  log?: { open: boolean; lines: string[]; onToggle: () => void };
  /** The switch of the local engine, when the page has it. */
  localSwitch?: ReactNode;
  /** Why the local engine runs and cannot be reached, when the checks on a Mac found it. */
  localConnection?: ReactNode;
  /** True while that diagnosis is shown: the general "no engine answered" note would only contradict it. */
  localDiagnosed?: boolean;
  /** How the local engine is installed, when the page has it. */
  localKind?: "container" | "native" | null;
  /** The one action of the empty list: adding an engine. */
  emptyAction?: ReactNode;
}

const LOG_ID = "engine-log";

/** The local engine has no name of its own to show: it is this computer. */
function displayName(engine: EngineView): string {
  return engine.kind === "local" ? t("engines.local_name") : engine.name;
}

export function EngineList(props: EngineListProps) {
  if (props.engines.length === 0) {
    return (
      <EmptyState icon={<IconCpu />} action={props.emptyAction}>
        {t("engines.empty")}
      </EmptyState>
    );
  }
  return (
    <ul className="engine-list" aria-label={t("engines.list_label")}>
      {props.engines.map((engine) => (
        <li key={engine.id} className="engine">
          <div className="engine-head">
            <h2>{displayName(engine)}</h2>
            {/* A remote engine that is switched off shows the last state it had, so its colour says nothing about now. */}
            <StatusPill tone={engine.enabled || engine.kind === "local" ? ENGINE_STATE_TONES[engine.state] : "neutral"}>
              <span className="state">
                {t(engine.enabled || engine.kind === "local" ? "engines.state" : "engines.state_last_known", {
                  state: t(`engine.state.${engine.state}`),
                })}
              </span>
            </StatusPill>
            {!engine.enabled && engine.kind === "remote" && <span className="badge">{t("engines.disabled")}</span>}
          </div>
          <p className="engine-address">
            {engine.kind === "local" && engine.address.startsWith("unix:") ? t("engines.address_socket") : <code>{engine.address}</code>}
          </p>
          {engine.info && <EngineInfo info={engine.info} supported={engine.supported} />}
          {/* An engine that does not answer is offline, a warning; any other problem is a failure. */}
          {engine.problem && !(engine.kind === "local" && props.localDiagnosed === true) && (
            <EngineNote error={engine.problem} kind={engine.state === "unreachable" ? "warning" : "problem"} />
          )}
          {engine.warning && <EngineNote error={engine.warning} kind="warning" />}
          {engine.kind === "local" && props.localKind === "native" && <p>{t("local.package.native")}</p>}
          {engine.kind === "local" ? (
            <>
              {/* The local engine is turned on and off by its own switch, not by enabling it like a remote one. */}
              {props.localSwitch}
              {props.localConnection}
              <div className="actions">
                {props.log && (
                  <Button type="button" className="secondary" aria-controls={LOG_ID} onClick={props.log.onToggle}>
                    {t(props.log.open ? "engines.log.hide" : "engines.log.show")}
                  </Button>
                )}
              </div>
              {props.log?.open && <EngineLog id={LOG_ID} lines={props.log.lines} />}
            </>
          ) : props.askingToRemove === engine.id ? (
            <RemoveAsk engine={engine} onConfirm={props.onConfirmRemove} onKeep={props.onKeep} />
          ) : (
            <div className="actions">
              <Button
                type="button"
                className="secondary"
                aria-label={t("engines.edit_named", { name: engine.name })}
                onClick={() => props.onEdit(engine)}
              >
                {t("engines.edit")}
              </Button>
              <Button
                type="button"
                className="secondary"
                aria-label={t(engine.enabled ? "engines.disable_named" : "engines.enable_named", { name: engine.name })}
                onClick={() => props.onSetEnabled(engine, !engine.enabled)}
              >
                {t(engine.enabled ? "engines.disable" : "engines.enable")}
              </Button>
              <Button
                type="button"
                className="secondary"
                aria-label={t("engines.remove_named", { name: engine.name })}
                onClick={() => props.onAskRemove(engine)}
              >
                {t("engines.remove")}
              </Button>
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
  /** The address the engine has now, in edit mode. A different address needs the token typed again. */
  savedAddress?: string;
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
  /** The name field, which takes the focus when the form opens. */
  nameRef?: Ref<HTMLInputElement>;
}

const ADDRESS_CODES: readonly string[] = ["engine.address_invalid", "engine.https_required"];

export function EngineForm(props: EngineFormProps) {
  const addressInvalid = props.failure !== null && ADDRESS_CODES.includes(props.failure.code);
  const busy = props.testing || props.saving;
  // In edit mode the stored token is not known here, so a test needs the token typed again.
  const cannotTest = props.mode === "edit" && props.token === "";
  const tokenRequired =
    props.mode === "edit" && props.savedAddress !== undefined && !sameAddress(props.address, props.savedAddress);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    props.onSave();
  };
  return (
    <form onSubmit={submit} aria-labelledby="engine-form-title" className="engine-form">
      <h2 id="engine-form-title">{t(props.mode === "add" ? "engine.form.add_title" : "engine.form.edit_title")}</h2>
      <TextField
        ref={props.nameRef}
        id="engine-name"
        label={t("engine.form.name")}
        autoComplete="off"
        value={props.name}
        onChange={(event) => props.onNameChange(event.target.value)}
      />
      <TextField
        id="engine-address"
        label={t("engine.form.address")}
        hint={t("engine.form.address_hint")}
        inputMode="url"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        aria-invalid={addressInvalid ? "true" : undefined}
        aria-describedby={addressInvalid ? "engine-form-error" : undefined}
        value={props.address}
        onChange={(event) => props.onAddressChange(event.target.value)}
      />
      <TextField
        id="engine-token"
        type="password"
        label={t("engine.form.token")}
        hint={
          tokenRequired
            ? t("engine.token_required")
            : t(props.mode === "add" ? "engine.form.token_hint_add" : "engine.form.token_hint_edit")
        }
        autoComplete="off"
        required={tokenRequired}
        value={props.token}
        onChange={(event) => props.onTokenChange(event.target.value)}
      />

      {props.failure && (
        <>
          <ErrorMessage failure={props.failure} id="engine-form-error" />
          <EngineSaid error={props.failure} />
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
        <Button type="button" className="secondary" disabled={busy || cannotTest} onClick={props.onTest}>
          {props.testing ? t("engine.form.testing") : t("engine.form.test")}
        </Button>
        <Button type="submit" disabled={busy}>
          {props.saving ? t("common.saving") : t("engine.form.save")}
        </Button>
        <Button type="button" className="secondary" onClick={props.onCancel}>
          {t("engine.form.cancel")}
        </Button>
      </div>
    </form>
  );
}

interface FormState {
  /** The engine being edited, or null when adding. */
  id: number | null;
  name: string;
  address: string;
  /** The address the engine had when the form opened. */
  savedAddress: string;
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
  savedAddress: "",
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
  const [announcement, setAnnouncement] = useState("");
  const [logOpen, setLogOpen] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const previous = useRef<EngineView[] | null>(null);
  // The latest callback, so the long-lived effects below never call a stale one.
  const authRequired = useRef(onAuthRequired);
  authRequired.current = onAuthRequired;

  const fail = (error: unknown): ApiFailure => {
    const result = asApiFailure(error);
    if (result.code === "auth.passphrase_required") authRequired.current();
    return result;
  };

  const local = useLocalEngine(true, () => authRequired.current());
  const logLines = useEngineLog(logOpen);

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

  // Screen reader users do not see a state move, so say it. The first list is not news.
  useEffect(() => {
    if (engines === null) return;
    if (previous.current) {
      const changes = stateChanges(previous.current, engines);
      if (changes.length > 0) {
        setAnnouncement(
          changes
            .map((engine) => t("engines.state_changed", { name: displayName(engine), state: t(`engine.state.${engine.state}`) }))
            .join(". "),
        );
      }
    }
    previous.current = engines;
  }, [engines]);

  // The form opens above the list, away from the button that opened it, so the focus goes to its first field.
  const formFor = form === null ? null : (form.id ?? "new");
  useEffect(() => {
    if (formFor !== null) nameField.current?.focus();
  }, [formFor]);

  const openForm = (next: FormState) => {
    setAskingToRemove(null);
    setForm(next);
  };

  const closeForm = () => {
    setForm(null);
    heading.current?.focus();
  };

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
      heading.current?.focus();
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
      heading.current?.focus();
    } catch (error) {
      setFailure(fail(error));
    }
  };

  const addButton = (
    <Button type="button" onClick={() => openForm({ ...EMPTY_FORM })}>
      <IconPlus />
      {t("engines.add")}
    </Button>
  );
  const empty = engines !== null && engines.length === 0;

  return (
    <div className="engines">
      <header className="page-header">
        <div className="page-header-text">
          <h1 ref={heading} tabIndex={-1}>
            {t("engines.title")}
          </h1>
          <p className="page-header-subtitle">{t("engines.subtitle")}</p>
        </div>
        {/* The empty list holds the one way to add an engine; no second button says the same. */}
        {form === null && !empty && <div className="page-header-actions">{addButton}</div>}
      </header>
      <p role="status" className="visually-hidden">
        {announcement}
      </p>
      {!live && <Notice tone="warn">{t("engines.live_paused")}</Notice>}
      {failure && <ErrorMessage failure={failure} />}
      {form && (
        <section aria-label={t(form.id === null ? "engines.add" : "engine.form.edit_title")}>
          <EngineForm
            mode={form.id === null ? "add" : "edit"}
            name={form.name}
            address={form.address}
            token={form.token}
            savedAddress={form.id === null ? undefined : form.savedAddress}
            onNameChange={(name) => edit({ name })}
            onAddressChange={(address) => edit({ address })}
            onTokenChange={(token) => edit({ token })}
            test={form.test}
            failure={form.failure}
            testing={form.testing}
            saving={form.saving}
            onTest={() => void test()}
            onSave={() => void save()}
            onCancel={closeForm}
            nameRef={nameField}
          />
        </section>
      )}
      {engines === null ? (
        !failure && <ScreenLoading text={t("engines.loading")} />
      ) : (
        <EngineList
          engines={engines}
          askingToRemove={askingToRemove}
          onEdit={(engine) => openForm({ ...EMPTY_FORM, id: engine.id, name: engine.name, address: engine.address, savedAddress: engine.address })}
          onSetEnabled={(engine, enabled) => void setEnabled(engine, enabled)}
          onAskRemove={(engine) => setAskingToRemove(engine.id)}
          onConfirmRemove={(engine) => void remove(engine)}
          onKeep={() => setAskingToRemove(null)}
          log={{ open: logOpen, lines: logLines, onToggle: () => setLogOpen((open) => !open) }}
          localKind={local.view?.installed?.kind ?? null}
          localSwitch={
            local.view?.installed ? (
              <LocalSwitch view={local.view} onView={local.setView} onAuthRequired={() => authRequired.current()} />
            ) : undefined
          }
          localConnection={
            local.view ? <ConnectionHelp view={local.view} onView={local.setView} onAuthRequired={() => authRequired.current()} /> : undefined
          }
          localDiagnosed={local.view?.connection?.problem != null}
          emptyAction={form === null ? addButton : undefined}
        />
      )}
      {local.view && (local.view.installed !== null || local.view.runtime.available.length > 0) && (
        <LocalAdvanced view={local.view} onView={local.setView} onAuthRequired={onAuthRequired} />
      )}
    </div>
  );
}
