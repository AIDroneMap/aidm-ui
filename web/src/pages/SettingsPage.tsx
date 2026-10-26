import { useEffect, useState, type FormEvent } from "react";
import { api, ApiFailure } from "../api.ts";
import { ErrorMessage } from "../components/ErrorMessage.tsx";
import { t } from "../i18n/translate.ts";
import {
  DEFAULT_PORT,
  PASSPHRASE_MIN_LENGTH,
  PORT_MAX,
  PORT_MIN,
  type LanSettingRequest,
  type PortSettingRequest,
  type SettingsView as SettingsData,
} from "../../../shared/api-types.ts";

export type Section = "load" | "port" | "lan";

export interface SettingsViewProps {
  /** Null while the settings are loading. */
  settings: SettingsData | null;
  /** The last failure and the section it belongs to, so it shows next to the cause. */
  failure: { section: Section; error: ApiFailure } | null;
  /** The section being saved, or null. */
  saving: "port" | "lan" | null;
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
}

function Failure({ props, section }: { props: SettingsViewProps; section: Section }) {
  return props.failure?.section === section ? <ErrorMessage failure={props.failure.error} /> : null;
}

export function SettingsView(props: SettingsViewProps) {
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
              aria-describedby="settings-port-hint"
              value={props.portDraft}
              onChange={(event) => props.onPortDraftChange(event.target.value)}
            />
            <p id="settings-port-hint" className="hint">
              {t("settings.port.hint", { port: DEFAULT_PORT })}
            </p>
          </div>
          <Failure props={props} section="port" />
          <button type="submit" disabled={props.saving === "port"}>
            {props.saving === "port" ? t("common.saving") : t("settings.port.save")}
          </button>
          {props.saved === "port" && <p role="status">{t("settings.port.saved")}</p>}
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
        {props.saved === "lan-on" && <p role="status">{t("settings.lan.saved_on")}</p>}
        {props.saved === "lan-off" && <p role="status">{t("settings.lan.saved_off")}</p>}
      </section>
    </>
  );
}

export function SettingsPage({ onAuthRequired }: { onAuthRequired: () => void }) {
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [failure, setFailure] = useState<SettingsViewProps["failure"]>(null);
  const [saving, setSaving] = useState<SettingsViewProps["saving"]>(null);
  const [saved, setSaved] = useState<SettingsViewProps["saved"]>(null);
  const [portDraft, setPortDraft] = useState("");
  const [lanWantsOn, setLanWantsOn] = useState(false);
  const [passphrase, setPassphrase] = useState("");

  const fail = (section: Section, error: unknown) => {
    const failure = error instanceof ApiFailure ? error : new ApiFailure(0, "server.internal_error");
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
    return () => {
      current = false;
    };
    // The page loads once; the callbacks it uses are re-created on every render.
  }, []);

  const save = async (
    section: "port" | "lan",
    path: string,
    body: PortSettingRequest | LanSettingRequest,
    done: NonNullable<SettingsViewProps["saved"]>,
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

  return (
    <SettingsView
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
    />
  );
}
