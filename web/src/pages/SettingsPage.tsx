import { useEffect, useState, type FormEvent } from "react";
import { api, asApiFailure, type ApiFailure } from "../api.ts";
import { ErrorMessage } from "../components/ErrorMessage.tsx";
import { UpdateCheckQuestion } from "../components/UpdateCheckQuestion.tsx";
import { t } from "../i18n/translate.ts";
import { messageParams } from "../machine.ts";
import {
  DEFAULT_PORT,
  PASSPHRASE_MIN_LENGTH,
  PORT_MAX,
  PORT_MIN,
  type LanSettingRequest,
  type PackagesView,
  type PortSettingRequest,
  type RefreshResult,
  type RefreshView,
  type SettingsView as SettingsData,
  type UpdateCheck,
  type UpdateCheckRequest,
  type WizardUpdateRequest,
  type WizardView,
} from "../../../shared/api-types.ts";

export type Section = "load" | "port" | "lan" | "wizard" | "updates";

export interface SettingsFormProps {
  /** Null while the settings are loading. */
  settings: SettingsData | null;
  /** The last failure and the section it belongs to, so it shows next to the cause. */
  failure: { section: Section; error: ApiFailure } | null;
  /** The section being saved, or null. */
  saving: "port" | "lan" | "wizard" | null;
  /** The section that was just saved, or null. */
  saved: "port" | "lan-on" | "lan-off" | null;
  portDraft: string;
  onPortDraftChange: (value: string) => void;
  onSavePort: () => void;
  /** True when the operator ticked the switch and has not saved yet. */
  lanWantsOn: boolean;
  onLanWantsOnChange: (value: boolean) => void;
  passphrase: string;
  onPassphraseChange: (value: string) => void;
  onSaveLan: () => void;
  onTurnLanOff: () => void;
  /** Opens the setup wizard again, from its first screen. */
  onRunWizard: () => void;
  /** Null while the packages are loading. */
  packages: PackagesView | null;
  updateSaving: boolean;
  /** True just after the answer to the update question was saved. */
  updateSaved: boolean;
  onUpdateCheckChange: (value: UpdateCheck) => void;
  /** True while the operator's look for a newer engine is under way. */
  refreshing: boolean;
  refreshResult: RefreshResult | null;
  onRefresh: () => void;
}

function Failure({ props, section, id }: { props: SettingsFormProps; section: Section; id?: string }) {
  return props.failure?.section === section ? <ErrorMessage failure={props.failure.error} id={id} /> : null;
}

function updatesStatus(props: SettingsFormProps): string {
  const result = props.refreshResult;
  if (props.refreshing) return t("settings.updates.refreshing");
  if (props.updateSaving) return t("updates.saving");
  if (props.updateSaved) return t("updates.saved");
  if (result?.ok) return result.replaced ? t("settings.updates.found", { tag: result.tag }) : t("settings.updates.none");
  return "";
}

export function SettingsForm(props: SettingsFormProps) {
  const { settings } = props;
  if (!settings) {
    return (
      <>
        <h1>{t("settings.title")}</h1>
        {props.failure ? <ErrorMessage failure={props.failure.error} /> : <p>{t("settings.loading")}</p>}
      </>
    );
  }

  const lanOn = settings.lan.enabled;
  const portInvalid = props.failure?.section === "port" && props.failure.error.code === "settings.port_invalid";
  const submitPort = (event: FormEvent) => {
    event.preventDefault();
    props.onSavePort();
  };
  const submitLan = (event: FormEvent) => {
    event.preventDefault();
    props.onSaveLan();
  };

  return (
    <>
      <h1>{t("settings.title")}</h1>

      <section aria-labelledby="settings-port-title">
        <h2 id="settings-port-title">{t("settings.port.title")}</h2>
        <p>{t("settings.port.current", { port: settings.listeningPort })}</p>
        <form onSubmit={submitPort}>
          <div className="field">
            <label htmlFor="settings-port">{t("settings.port.label")}</label>
            <input
              id="settings-port"
              type="number"
              inputMode="numeric"
              min={PORT_MIN}
              max={PORT_MAX}
              placeholder={String(DEFAULT_PORT)}
              aria-invalid={portInvalid ? "true" : undefined}
              aria-describedby={portInvalid ? "settings-port-hint settings-port-error" : "settings-port-hint"}
              value={props.portDraft}
              onChange={(event) => props.onPortDraftChange(event.target.value)}
            />
            <p id="settings-port-hint" className="hint">
              {t("settings.port.hint", { port: DEFAULT_PORT })}
            </p>
          </div>
          <Failure props={props} section="port" id="settings-port-error" />
          <button type="submit" disabled={props.saving === "port"}>
            {props.saving === "port" ? t("common.saving") : t("settings.port.save")}
          </button>
          <p role="status">{props.saved === "port" ? t("settings.port.saved") : ""}</p>
        </form>
      </section>

      <section aria-labelledby="settings-lan-title">
        <h2 id="settings-lan-title">{t("settings.lan.title")}</h2>
        <p>{t("settings.lan.explain")}</p>
        <div className="check">
          <input
            id="settings-lan"
            type="checkbox"
            checked={lanOn || props.lanWantsOn}
            disabled={props.saving === "lan"}
            onChange={(event) => {
              if (lanOn) props.onTurnLanOff();
              else props.onLanWantsOnChange(event.target.checked);
            }}
          />
          <label htmlFor="settings-lan">{t("settings.lan.switch")}</label>
        </div>

        {!lanOn && props.lanWantsOn && (
          <form onSubmit={submitLan}>
            <div className="field">
              <label htmlFor="settings-passphrase">{t("settings.lan.passphrase_label")}</label>
              <input
                id="settings-passphrase"
                type="password"
                autoComplete="new-password"
                minLength={PASSPHRASE_MIN_LENGTH}
                required
                aria-describedby="settings-passphrase-hint"
                value={props.passphrase}
                onChange={(event) => props.onPassphraseChange(event.target.value)}
              />
              <p id="settings-passphrase-hint" className="hint">
                {t("settings.lan.passphrase_hint", { min: PASSPHRASE_MIN_LENGTH })}
              </p>
            </div>
            <Failure props={props} section="lan" />
            <button type="submit" disabled={props.saving === "lan"}>
              {props.saving === "lan" ? t("common.saving") : t("settings.lan.save")}
            </button>
          </form>
        )}

        {lanOn && (
          <>
            {settings.lan.addresses.length > 0 ? (
              <>
                <p>{t("settings.lan.addresses_title")}</p>
                <ul>
                  {settings.lan.addresses.map((address) => (
                    <li key={address}>
                      <code>{`http://${address}:${settings.listeningPort}/`}</code>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p>{t("settings.lan.no_addresses")}</p>
            )}
            <Failure props={props} section="lan" />
            <button type="button" disabled={props.saving === "lan"} onClick={props.onTurnLanOff}>
              {t("settings.lan.turn_off")}
            </button>
          </>
        )}
        <p role="status">
          {props.saved === "lan-on" ? t("settings.lan.saved_on") : props.saved === "lan-off" ? t("settings.lan.saved_off") : ""}
        </p>
      </section>

      <section aria-labelledby="settings-updates-title">
        <h2 id="settings-updates-title">{t("settings.updates.title")}</h2>
        <UpdateCheckQuestion
          idPrefix="settings"
          value={props.packages?.updateCheck ?? null}
          saving={props.updateSaving}
          loading={props.packages === null}
          onChange={props.onUpdateCheckChange}
        />
        <Failure props={props} section="updates" />
        {props.refreshResult && !props.refreshResult.ok && (
          <p role="alert" className="error">
            {t(props.refreshResult.error.code, messageParams(props.refreshResult.error))}
          </p>
        )}
        <div className="actions">
          <button
            type="button"
            aria-disabled={props.refreshing ? "true" : undefined}
            onClick={() => {
              if (!props.refreshing) props.onRefresh();
            }}
          >
            {props.refreshing ? t("settings.updates.refreshing") : t("settings.updates.refresh")}
          </button>
        </div>
        <p role="status">{updatesStatus(props)}</p>
      </section>

      <section aria-labelledby="settings-wizard-title">
        <h2 id="settings-wizard-title">{t("settings.wizard.title")}</h2>
        <p>{t("settings.wizard.explain")}</p>
        <Failure props={props} section="wizard" />
        <div className="actions">
          <button type="button" disabled={props.saving === "wizard"} onClick={props.onRunWizard}>
            {props.saving === "wizard" ? t("settings.wizard.running") : t("settings.wizard.run")}
          </button>
          <a href="#/wizard/check">{t("settings.wizard.check_link")}</a>
        </div>
      </section>
    </>
  );
}

export function SettingsPage({
  onAuthRequired,
  onWizardReopened,
}: {
  onAuthRequired: () => void;
  /** Called once the server has recorded that the wizard is open again. */
  onWizardReopened: () => void;
}) {
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [failure, setFailure] = useState<SettingsFormProps["failure"]>(null);
  const [saving, setSaving] = useState<SettingsFormProps["saving"]>(null);
  const [saved, setSaved] = useState<SettingsFormProps["saved"]>(null);
  const [portDraft, setPortDraft] = useState("");
  const [lanWantsOn, setLanWantsOn] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [packages, setPackages] = useState<PackagesView | null>(null);
  const [updateSaving, setUpdateSaving] = useState(false);
  const [updateSaved, setUpdateSaved] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshResult, setRefreshResult] = useState<RefreshResult | null>(null);

  const fail = (section: Section, error: unknown) => {
    const failure = asApiFailure(error);
    if (failure.code === "auth.passphrase_required") onAuthRequired();
    setFailure({ section, error: failure });
  };

  const receive = (next: SettingsData) => {
    setSettings(next);
    setPortDraft(next.port === null ? "" : String(next.port));
  };

  useEffect(() => {
    let current = true;
    api<SettingsData>("GET", "/api/settings").then(
      (loaded) => {
        if (current) receive(loaded);
      },
      (error: unknown) => {
        if (current) fail("load", error);
      },
    );
    api<PackagesView>("GET", "/api/packages").then(
      (loaded) => {
        if (current) setPackages(loaded);
      },
      (error: unknown) => {
        if (current) fail("updates", error);
      },
    );
    return () => {
      current = false;
    };
    // The page loads once; the callbacks it uses are re-created on every render.
  }, []);

  const save = async (
    section: "port" | "lan",
    path: string,
    body: PortSettingRequest | LanSettingRequest,
    done: NonNullable<SettingsFormProps["saved"]>,
  ) => {
    setSaving(section);
    setFailure(null);
    setSaved(null);
    try {
      receive(await api<SettingsData>("PUT", path, body));
      setSaved(done);
      if (section === "lan") {
        setPassphrase("");
        setLanWantsOn(false);
      }
    } catch (error) {
      fail(section, error);
    } finally {
      setSaving(null);
    }
  };

  const savePort = () => {
    const text = portDraft.trim();
    const port = text === "" ? null : Number(text);
    void save("port", "/api/settings/port", { port }, "port");
  };

  const saveUpdateCheck = async (value: UpdateCheck) => {
    setUpdateSaving(true);
    setUpdateSaved(false);
    setRefreshResult(null);
    setFailure(null);
    try {
      const body: UpdateCheckRequest = { value };
      await api<unknown>("PUT", "/api/settings/update-check", body);
      setPackages((current) => (current ? { ...current, updateCheck: value } : current));
      setUpdateSaved(true);
    } catch (error) {
      fail("updates", error);
    } finally {
      setUpdateSaving(false);
    }
  };

  const refresh = async () => {
    setRefreshing(true);
    setUpdateSaved(false);
    setRefreshResult(null);
    setFailure(null);
    try {
      const answer = await api<RefreshView>("POST", "/api/packages/refresh");
      setPackages(answer.view);
      setRefreshResult(answer.result);
    } catch (error) {
      fail("updates", error);
    } finally {
      setRefreshing(false);
    }
  };

  const runWizard = async () => {
    setSaving("wizard");
    setFailure(null);
    setSaved(null);
    try {
      const body: WizardUpdateRequest = { completed: false };
      await api<WizardView>("PUT", "/api/wizard", body);
      onWizardReopened();
      window.location.hash = "#/wizard";
    } catch (error) {
      fail("wizard", error);
    } finally {
      setSaving(null);
    }
  };

  return (
    <SettingsForm
      settings={settings}
      failure={failure}
      saving={saving}
      saved={saved}
      portDraft={portDraft}
      onPortDraftChange={setPortDraft}
      onSavePort={savePort}
      lanWantsOn={lanWantsOn}
      onLanWantsOnChange={(value) => {
        setLanWantsOn(value);
        setFailure(null);
        if (!value) setPassphrase("");
      }}
      passphrase={passphrase}
      onPassphraseChange={setPassphrase}
      onSaveLan={() => void save("lan", "/api/settings/lan", { enabled: true, passphrase }, "lan-on")}
      onTurnLanOff={() => void save("lan", "/api/settings/lan", { enabled: false }, "lan-off")}
      onRunWizard={() => void runWizard()}
      packages={packages}
      updateSaving={updateSaving}
      updateSaved={updateSaved}
      onUpdateCheckChange={(value) => void saveUpdateCheck(value)}
      refreshing={refreshing}
      refreshResult={refreshResult}
      onRefresh={() => void refresh()}
    />
  );
}
