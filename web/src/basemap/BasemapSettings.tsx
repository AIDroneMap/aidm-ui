import { useEffect, useRef, useState, type FormEvent } from "react";
import { basemapOrigin, type BasemapSettings as BasemapValue } from "../../../shared/basemap.ts";
import { api, asApiFailure, type ApiFailure } from "../api.ts";
import { ErrorMessage } from "../components/ErrorMessage.tsx";
import { Button } from "../controls/Button.tsx";
import { Select } from "../controls/Select.tsx";
import { TextField } from "../controls/TextField.tsx";
import { Toggle } from "../controls/Toggle.tsx";
import { t } from "../i18n/translate.ts";

export function BasemapForm({ value, working, onChange, onSubmit }: {
  value: BasemapValue;
  working: boolean;
  onChange: (value: BasemapValue) => void;
  onSubmit: () => void;
}) {
  function submit(event: FormEvent) { event.preventDefault(); if (!working) onSubmit(); }
  return <form onSubmit={submit}>
    <p id="basemap-help">{t("basemap.help")}</p>
    <fieldset disabled={working}>
      <Toggle id="basemap-enabled" label={t("basemap.enable")} checked={value.enabled} onChange={event => onChange({ ...value, enabled: event.target.checked })} />
      <TextField id="basemap-url" label={t("basemap.url")} value={value.url} onChange={event => onChange({ ...value, url: event.target.value })} required={value.enabled} maxLength={4096} autoComplete="off" spellCheck={false} aria-describedby="basemap-help" />
      <Select id="basemap-scheme" label={t("basemap.scheme")} value={value.scheme} onChange={event => onChange({ ...value, scheme: event.target.value as BasemapValue["scheme"] })}>
        <option value="xyz">{t("basemap.xyz")}</option><option value="tms">{t("basemap.tms")}</option>
      </Select>
      <TextField id="basemap-attribution" label={t("basemap.attribution")} value={value.attribution} onChange={event => onChange({ ...value, attribution: event.target.value })} maxLength={512} />
      <Button type="submit">{t(working ? "common.saving" : "basemap.save")}</Button>
    </fieldset>
  </form>;
}

export function BasemapSettings({ onAuthRequired }: { onAuthRequired: () => void }) {
  const [value, setValue] = useState<BasemapValue | null>(null);
  const saved = useRef<BasemapValue | null>(null);
  const current = useRef(true);
  const [attempt, setAttempt] = useState(0);
  const [working, setWorking] = useState(false);
  const [done, setDone] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  useEffect(() => {
    current.current = true;
    let active = true;
    api<BasemapValue>("GET", "/api/settings/basemap").then(result => {
      if (active) { setValue(result); saved.current = result; setFailure(null); }
    }, error => {
      if (!active) return;
      const failure = asApiFailure(error); setFailure(failure);
      if (failure.code === "auth.passphrase_required") onAuthRequired();
    });
    return () => { active = false; current.current = false; };
  }, [attempt, onAuthRequired]);
  async function save() {
    if (!value || working) return;
    setWorking(true); setFailure(null); setDone(false);
    try {
      const result = await api<BasemapValue>("PUT", "/api/settings/basemap", value);
      if (!current.current) return;
      const changedOrigin = !saved.current || basemapOrigin(saved.current) !== basemapOrigin(result);
      saved.current = result; setValue(result); setDone(true);
      if (changedOrigin) window.location.reload();
    } catch (error) {
      if (!current.current) return;
      const failure = asApiFailure(error); setFailure(failure);
      if (failure.code === "auth.passphrase_required") onAuthRequired();
    } finally { if (current.current) setWorking(false); }
  }
  return <section aria-labelledby="basemap-title">
    <h2 id="basemap-title">{t("basemap.title")}</h2>
    {value ? <BasemapForm value={value} working={working} onChange={next => { setValue(next); setDone(false); }} onSubmit={() => void save()} /> : !failure && <p role="status">{t("basemap.loading")}</p>}
    {failure && <ErrorMessage failure={failure} />}
    {!value && failure && <Button onClick={() => setAttempt(value => value + 1)}>{t("basemap.retry")}</Button>}
    {done && <p role="status">{t("basemap.saved")}</p>}
  </section>;
}
