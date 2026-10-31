import { useEffect, useId, useRef, useState } from "react";
import { parseSettingsFile, SETTINGS_FILE_MAX_BYTES, type SavedPreset, type SettingsFile } from "../../../shared/settings-file.ts";
import { api, asApiFailure, type ApiFailure } from "../api.ts";
import { Button } from "../controls/Button.tsx";
import { TextField } from "../controls/TextField.tsx";
import { ErrorMessage } from "../components/ErrorMessage.tsx";
import { t } from "../i18n/translate.ts";
import "./PresetLibrary.css";

type Summary = Pick<SavedPreset, "id" | "preset" | "engineVersion">;
type Page = { presets: Summary[]; nextOffset: number | null };
export function PresetLibrary({ file, selectedId, disabled = false, onChoose, onRename, onDelete, onAuthRequired }: {
  file: SettingsFile | null; selectedId: number | null; disabled?: boolean;
  onChoose(file: SettingsFile, id: number | null): void;
  onRename(id: number, name: string): void; onDelete(id: number): void; onAuthRequired(): void;
}) {
  const id = useId();
  const [name, setName] = useState(file?.preset ?? "");
  const [page, setPage] = useState<Page | null>(null);
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [localFailure, setLocalFailure] = useState<string | null>(null);
  const alive = useRef(true), listSequence = useRef(0), operation = useRef(0);
  const anchor = useRef({ name: file?.preset, id: selectedId });
  const urls = useRef(new Set<string>());
  useEffect(() => { alive.current = true; return () => { alive.current = false; operation.current++; for (const url of urls.current) URL.revokeObjectURL(url); }; }, []);
  useEffect(() => {
    if (file && (anchor.current.name !== file.preset || anchor.current.id !== selectedId)) { anchor.current = { name: file.preset, id: selectedId }; setName(file.preset); }
  }, [file?.preset, selectedId]);
  function fail(error: unknown) { if (!alive.current) return; const value = asApiFailure(error); if (value.code === "auth.passphrase_required") onAuthRequired(); else setFailure(value); }
  async function load(at = 0) {
    const generation = ++listSequence.current;
    try { const value = await api<Page>("GET", `/api/presets?offset=${at}`); if (alive.current && generation === listSequence.current) { setPage(value); setOffset(at); } } catch (error) { fail(error); }
  }
  useEffect(() => { void load(); }, []);
  async function act(action: () => Promise<void>) {
    if (busy || disabled) return;
    setBusy(true); setFailure(null); setLocalFailure(null);
    try { await action(); } catch (error) { fail(error); } finally { if (alive.current) setBusy(false); }
  }
  const named = file ? parseSettingsFile({ options: file.options, preset: name, engineVersion: file.engineVersion }) : null;
  const locked = busy || disabled;
  async function choose(key: number) { await act(async () => { const value = await api<SavedPreset>("GET", `/api/presets/${key}`); if (alive.current) onChoose({ options: value.options, preset: value.preset, engineVersion: value.engineVersion }, value.id); }); }
  async function save() { if (!named) return; await act(async () => { const value = await api<SavedPreset>("POST", "/api/presets", named); if (alive.current) { await load(); if (alive.current) onChoose({ options: value.options, preset: value.preset, engineVersion: value.engineVersion }, value.id); } }); }
  async function rename() { if (selectedId === null || !named) return; await act(async () => { const value = await api<SavedPreset>("PUT", `/api/presets/${selectedId}`, { preset: named.preset }); if (alive.current) { onRename(value.id, value.preset); await load(offset); } }); }
  async function remove() { if (selectedId === null) return; await act(async () => { await api("DELETE", `/api/presets/${selectedId}`); if (alive.current) { onDelete(selectedId); await load(); document.getElementById(`${id}-name`)?.focus(); } }); }
  async function importFile(input: HTMLInputElement) {
    const value = input.files?.[0]; input.value = "";
    if (!value || locked) return;
    const current = ++operation.current;
    await act(async () => {
      if (value.size > SETTINGS_FILE_MAX_BYTES) { setLocalFailure("run_presets.too_large"); return; }
      let parsed: SettingsFile | null;
      try { parsed = parseSettingsFile(JSON.parse(await value.text())); } catch { parsed = null; }
      if (!alive.current || current !== operation.current) return;
      if (!parsed) setLocalFailure("run_presets.invalid_file"); else onChoose(parsed, null);
    });
  }
  function exportFile() {
    if (!named) return;
    const blob = new Blob([JSON.stringify(named, null, 2) + "\n"], { type: "application/json" });
    if (blob.size > SETTINGS_FILE_MAX_BYTES) { setLocalFailure("run_presets.export_too_large"); return; }
    const url = URL.createObjectURL(blob); urls.current.add(url);
    const link = document.createElement("a"); link.href = url; link.download = "aidm-settings.json"; link.click();
    setTimeout(() => { URL.revokeObjectURL(url); urls.current.delete(url); }, 1000);
  }
  return <section aria-label={t("run_presets.title")}>
    <h3>{t("run_presets.title")}</h3>
    {failure && <ErrorMessage failure={failure} />}
    {localFailure && <p role="alert">{t(localFailure)}</p>}
    {page === null ? <p role="status">{t("run_presets.loading")}</p> : page.presets.length === 0 ? <p>{t("run_presets.empty")}</p> : <fieldset disabled={locked}><legend>{t("run_presets.choose")}</legend>
      {page.presets.map(preset => <label key={preset.id} className="preset-choice"><input type="radio" name="preset" checked={selectedId === preset.id} onChange={() => void choose(preset.id)} /> {preset.preset}</label>)}
    </fieldset>}
    {offset > 0 && <Button className="secondary" disabled={locked} onClick={() => void load(Math.max(0, offset - 50))}>{t("upload.previous")}</Button>}
    {page?.nextOffset !== null && page?.nextOffset !== undefined && <Button className="secondary" disabled={locked} onClick={() => void load(page.nextOffset!)}>{t("upload.next")}</Button>}
    <Button className="secondary" disabled={locked} onClick={() => void load(offset)}>{t("run_presets.reload")}</Button>
    <TextField id={`${id}-name`} label={t("run_presets.name")} value={name} maxLength={200} disabled={locked} onChange={event => setName(event.target.value)} />
    <Button disabled={locked || !named} onClick={() => void save()}>{t("run_presets.save")}</Button>{" "}
    <Button className="secondary" disabled={locked || !named} onClick={exportFile}>{t("run_presets.export")}</Button>{" "}
    {selectedId !== null && <><Button className="secondary" disabled={locked || !named} onClick={() => void rename()}>{t("run_presets.rename")}</Button>{" "}<Button className="secondary" disabled={locked} onClick={() => void remove()}>{t("run_presets.delete")}</Button></>}
    <div className="field"><label htmlFor={`${id}-file`}>{t("run_presets.import")}</label><input id={`${id}-file`} type="file" accept="application/json,.json" disabled={locked} onChange={event => void importFile(event.currentTarget)} /></div>
  </section>;
}
