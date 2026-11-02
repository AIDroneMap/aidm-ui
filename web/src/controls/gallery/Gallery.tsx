import { useEffect, useRef, useState, type ReactNode } from "react";
import { ENGINE_STATES, RUN_STATES } from "../../../../shared/api-types.ts";
import { t } from "../../i18n/translate.ts";
import {
  IconArrowLeft,
  IconCpu,
  IconDownload,
  IconFolder,
  IconImages,
  IconInfo,
  IconLayers,
  IconLoaderCircle,
  IconClipboardCheck,
  IconBox,
  IconPlay,
  IconPlus,
  IconRotateCcw,
  IconSettings,
  IconSlidersHorizontal,
} from "../../icons/icons.tsx";
import { Button } from "../Button.tsx";
import { Card } from "../Card.tsx";
import { Checkbox } from "../Checkbox.tsx";
import { Chip } from "../Chip.tsx";
import { ConfirmDialog } from "../ConfirmDialog.tsx";
import { Dialog } from "../Dialog.tsx";
import { DiffPanel } from "../DiffPanel.tsx";
import { Disclosure } from "../Disclosure.tsx";
import { DropZone } from "../DropZone.tsx";
import { EmptyState } from "../EmptyState.tsx";
import { IconButton } from "../IconButton.tsx";
import { KeyValueList } from "../KeyValueList.tsx";
import { NumberField } from "../NumberField.tsx";
import { Notice, type NoticeTone } from "../Notice.tsx";
import { PageHeader } from "../PageHeader.tsx";
import { Popover } from "../Popover.tsx";
import { Progress } from "../Progress.tsx";
import { RadioGroup } from "../RadioGroup.tsx";
import { SearchField } from "../SearchField.tsx";
import { SegmentedControl } from "../SegmentedControl.tsx";
import { Select } from "../Select.tsx";
import { NavItem, NavSection, Sidebar } from "../Sidebar.tsx";
import { Skeleton } from "../Skeleton.tsx";
import { StageList } from "../StageList.tsx";
import { ENGINE_STATE_TONES, RUN_STATE_TONES, StatusPill } from "../StatusPill.tsx";
import { Table } from "../Table.tsx";
import { Tabs } from "../Tabs.tsx";
import { TextField } from "../TextField.tsx";
import { ThumbnailGrid } from "../ThumbnailGrid.tsx";
import { Timeline } from "../Timeline.tsx";
import { Toggle } from "../Toggle.tsx";
import { Toolbar } from "../Toolbar.tsx";
import {
  CAMERA,
  DELETE_SIZE,
  DIFF_ROWS,
  FACTS,
  FILE_ROWS,
  FLIGHTS,
  ICONS,
  PHOTO_COUNT,
  PROJECT_NAME,
  RUN_TIME,
  SEARCH_FILES,
  THUMBNAILS,
  TIMELINE_END,
  TIMELINE_START,
} from "./sample-data.ts";
import "./gallery.css";

type ThemeChoice = "system" | "light" | "dark";

/** One component: a heading and every state of it. Section names use underscores; the address uses hyphens. */
function Section({ name, wide, children }: { name: string; wide?: boolean; children: ReactNode }) {
  const slug = name.replaceAll("_", "-");
  return (
    <section className="gallery-section" id={`gallery-${slug}`} aria-labelledby={`gallery-${slug}-title`}>
      <h2 id={`gallery-${slug}-title`}>{t(`ui.gallery.section.${name}`)}</h2>
      <div className={wide ? "gallery-states-wide" : "gallery-states"}>{children}</div>
    </section>
  );
}

/** One state of a component, with its caption. */
function State({ state, children }: { state: string; children: ReactNode }) {
  return (
    <div className="gallery-state-item">
      <p className="gallery-state">{t(`ui.gallery.state.${state}`)}</p>
      {children}
    </div>
  );
}

function FilesTable({ dense }: { dense?: boolean }) {
  return (
    <Table label={t("ui.gallery.table.label")} dense={dense}>
      <thead>
        <tr>
          <th scope="col">{t("ui.gallery.table.file")}</th>
          <th scope="col">{t("ui.gallery.table.size")}</th>
          <th scope="col">{t("ui.gallery.table.taken")}</th>
        </tr>
      </thead>
      <tbody>
        {FILE_ROWS.map((row) => (
          <tr key={row.name}>
            <th scope="row">{row.name}</th>
            <td>{row.size}</td>
            <td>{row.taken}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

const NOTICE_TONES: readonly NoticeTone[] = ["info", "ok", "warn", "danger"];

export function Gallery() {
  const [theme, setTheme] = useState<ThemeChoice>("system");
  const [quality, setQuality] = useState<"fast" | "balanced" | "detailed">("balanced");
  const [view, setView] = useState<"map" | "model" | "photos">("map");
  const [search, setSearch] = useState("");
  const [dropped, setDropped] = useState<number | null>(null);
  const [confirming, setConfirming] = useState<"plain" | "danger" | null>(null);
  const [outcome, setOutcome] = useState<"confirmed" | "kept" | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  const [included, setIncluded] = useState<Record<string, boolean>>({ "1": true, "2": false });
  const [differences, setDifferences] = useState<readonly (typeof DIFF_ROWS)[number][]>(DIFF_ROWS);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    return () => { delete document.documentElement.dataset.theme; };
  }, [theme]);

  const matches = SEARCH_FILES.filter((name) => name.toLowerCase().includes(search.trim().toLowerCase())).length;
  const answer = (value: "confirmed" | "kept") => { setOutcome(value); setConfirming(null); };

  return (
    <main className="gallery">
      <PageHeader
        title={t("ui.gallery.title")}
        subtitle={t("ui.gallery.subtitle")}
        actions={
          <div id="gallery-theme">
            <SegmentedControl
              name="gallery-theme"
              legend={t("ui.gallery.theme.legend")}
              options={[
                { value: "system", label: t("ui.gallery.theme.system") },
                { value: "light", label: t("ui.gallery.theme.light") },
                { value: "dark", label: t("ui.gallery.theme.dark") },
              ]}
              value={theme}
              onChange={setTheme}
            />
          </div>
        }
      />

      <section className="gallery-section" id="gallery-icons" aria-labelledby="gallery-icons-title">
        <h2 id="gallery-icons-title">{t("ui.gallery.section.icons")}</h2>
        <ul className="gallery-icons">
          {ICONS.map(([name, Icon]) => (
            <li className="gallery-icon" key={name}>
              <Icon />
              <code>{name}</code>
            </li>
          ))}
        </ul>
      </section>

      <Section name="button">
        <State state="primary"><Button>{t("ui.gallery.button.primary")}</Button></State>
        <State state="secondary"><Button variant="secondary">{t("ui.gallery.button.secondary")}</Button></State>
        <State state="quiet"><Button variant="quiet">{t("ui.gallery.button.quiet")}</Button></State>
        <State state="danger"><Button variant="danger">{t("ui.gallery.button.danger")}</Button></State>
        <State state="disabled_primary"><Button disabled>{t("ui.gallery.button.primary")}</Button></State>
        <State state="disabled_secondary"><Button variant="secondary" disabled>{t("ui.gallery.button.secondary")}</Button></State>
        <State state="icon_button"><IconButton label={t("ui.gallery.button.icon_label")} icon={<IconPlus />} /></State>
        <State state="icon_and_text"><Button variant="secondary"><IconDownload />{t("ui.gallery.button.download")}</Button></State>
      </Section>

      <Section name="text_field">
        <State state="empty_with_hint"><TextField id="gallery-text-empty" label={t("ui.gallery.text.label")} hint={t("ui.gallery.text.hint")} /></State>
        <State state="filled"><TextField id="gallery-text-filled" label={t("ui.gallery.text.label")} defaultValue={PROJECT_NAME} /></State>
        <State state="with_error"><TextField id="gallery-text-error" label={t("ui.gallery.text.label")} defaultValue="" error={t("ui.gallery.text.error")} /></State>
        <State state="disabled"><TextField id="gallery-text-disabled" label={t("ui.gallery.text.label")} defaultValue={PROJECT_NAME} disabled /></State>
      </Section>

      <Section name="number_field">
        <State state="default"><NumberField id="gallery-number" label={t("ui.gallery.number.label")} hint={t("ui.gallery.number.hint")} defaultValue={2} min={1} max={20} step={0.5} /></State>
      </Section>

      <Section name="select">
        <State state="default">
          <Select id="gallery-select-default" label={t("ui.gallery.select.label")} defaultValue="balanced">
            <option value="fast">{t("ui.gallery.select.fast")}</option>
            <option value="balanced">{t("ui.gallery.select.balanced")}</option>
            <option value="detailed">{t("ui.gallery.select.detailed")}</option>
          </Select>
        </State>
        <State state="disabled">
          <Select id="gallery-select-disabled" label={t("ui.gallery.select.label")} defaultValue="balanced" disabled>
            <option value="fast">{t("ui.gallery.select.fast")}</option>
            <option value="balanced">{t("ui.gallery.select.balanced")}</option>
            <option value="detailed">{t("ui.gallery.select.detailed")}</option>
          </Select>
        </State>
      </Section>

      <Section name="toggle">
        <State state="off"><Toggle id="gallery-toggle-off" label={t("ui.gallery.toggle.label")} hint={t("ui.gallery.toggle.hint")} /></State>
        <State state="on"><Toggle id="gallery-toggle-on" label={t("ui.gallery.toggle.label")} defaultChecked /></State>
        <State state="disabled"><Toggle id="gallery-toggle-disabled" label={t("ui.gallery.toggle.label")} disabled /></State>
      </Section>

      <Section name="checkbox">
        <State state="unchecked"><Checkbox id="gallery-checkbox-off" label={t("ui.gallery.checkbox.label")} hint={t("ui.gallery.checkbox.hint")} /></State>
        <State state="checked"><Checkbox id="gallery-checkbox-on" label={t("ui.gallery.checkbox.label")} defaultChecked /></State>
        <State state="disabled"><Checkbox id="gallery-checkbox-disabled" label={t("ui.gallery.checkbox.label")} disabled /></State>
      </Section>

      <Section name="radio_group">
        <State state="one_chosen">
          <RadioGroup
            name="gallery-radio"
            legend={t("ui.gallery.radio.legend")}
            options={[
              { value: "fast", label: t("ui.gallery.radio.fast"), hint: t("ui.gallery.radio.fast_hint") },
              { value: "balanced", label: t("ui.gallery.radio.balanced"), hint: t("ui.gallery.radio.balanced_hint") },
              { value: "detailed", label: t("ui.gallery.radio.detailed"), hint: t("ui.gallery.radio.detailed_hint") },
            ]}
            value={quality}
            onChange={setQuality}
          />
        </State>
      </Section>

      <Section name="segmented_control">
        <State state="three_options">
          <SegmentedControl
            name="gallery-segmented"
            legend={t("ui.gallery.segmented.legend")}
            options={[
              { value: "map", label: t("ui.gallery.segmented.map") },
              { value: "model", label: t("ui.gallery.segmented.model") },
              { value: "photos", label: t("ui.gallery.segmented.photos") },
            ]}
            value={view}
            onChange={setView}
          />
        </State>
      </Section>

      <Section name="search_field">
        <State state="interactive">
          <SearchField id="gallery-search" label={t("ui.gallery.search.label")} placeholder={t("ui.gallery.search.placeholder")} value={search} onChange={setSearch} matches={matches} />
        </State>
      </Section>

      <Section name="disclosure">
        <State state="closed"><Disclosure label={t("ui.gallery.disclosure.label")}><p>{t("ui.gallery.disclosure.text")}</p></Disclosure></State>
        <State state="open"><Disclosure label={t("ui.gallery.disclosure.label")} open><p>{t("ui.gallery.disclosure.text")}</p></Disclosure></State>
      </Section>

      <Section name="table" wide>
        <State state="default"><FilesTable /></State>
        <State state="dense"><FilesTable dense /></State>
      </Section>

      <Section name="dialog">
        <State state="closed">
          <Button variant="secondary" onClick={() => dialog.current?.showModal()}>{t("ui.gallery.dialog.open")}</Button>
          <Dialog ref={dialog} label={t("ui.gallery.dialog.title")}>
            <h2 className="dialog-title">{t("ui.gallery.dialog.title")}</h2>
            <p>{t("ui.gallery.dialog.text")}</p>
            <div className="dialog-actions">
              <Button onClick={() => dialog.current?.close()}>{t("ui.gallery.dialog.close")}</Button>
            </div>
          </Dialog>
        </State>
      </Section>

      <Section name="notice" wide>
        {NOTICE_TONES.map((tone) => (
          <State state={tone} key={tone}><Notice tone={tone}>{t(`ui.gallery.notice.${tone}`)}</Notice></State>
        ))}
      </Section>

      <Section name="progress" wide>
        <State state="with_value"><Progress id="gallery-progress-value" label={t("ui.gallery.progress.label")} value={42} max={100} /></State>
        <State state="indeterminate"><Progress id="gallery-progress-unknown" label={t("ui.gallery.progress.waiting")} /></State>
      </Section>

      <Section name="tabs" wide>
        <State state="three_tabs">
          <Tabs
            label={t("ui.gallery.tabs.label")}
            tabs={[
              { id: "photos", label: t("ui.gallery.tabs.photos"), content: <p>{t("ui.gallery.tabs.photos_text")}</p> },
              { id: "settings", label: t("ui.gallery.tabs.settings"), content: <p>{t("ui.gallery.tabs.settings_text")}</p> },
              { id: "results", label: t("ui.gallery.tabs.results"), content: <p>{t("ui.gallery.tabs.results_text")}</p> },
            ]}
          />
        </State>
      </Section>

      <Section name="sidebar">
        <State state="project_open">
          <div className="gallery-sidebar-frame">
            <Sidebar label={t("ui.gallery.sidebar.label")} header={t("app.name")}>
              <NavSection>
                <NavItem href="#gallery-sidebar" icon={<IconFolder />} label={t("ui.gallery.sidebar.projects")} current />
                <NavItem href="#gallery-sidebar" icon={<IconCpu />} label={t("ui.gallery.sidebar.engines")} />
                <NavItem href="#gallery-sidebar" icon={<IconSettings />} label={t("ui.gallery.sidebar.preferences")} />
              </NavSection>
              <NavSection title={PROJECT_NAME}>
                <NavItem href="#gallery-sidebar" icon={<IconImages />} label={t("ui.gallery.sidebar.photos")} badge={PHOTO_COUNT} badgeLabel={t("ui.gallery.sidebar.photos_badge", { count: PHOTO_COUNT })} />
                <NavItem href="#gallery-sidebar" icon={<IconSlidersHorizontal />} label={t("ui.gallery.sidebar.settings")} />
                <NavItem href="#gallery-sidebar" icon={<IconClipboardCheck />} label={t("ui.gallery.sidebar.review")} />
                <NavItem href="#gallery-sidebar" icon={<IconPlay />} label={t("ui.gallery.sidebar.runs")} badge={<IconLoaderCircle />} badgeLabel={t("ui.gallery.sidebar.run_active")} />
                <NavItem href="#gallery-sidebar" icon={<IconBox />} label={t("ui.gallery.sidebar.results")} badge={2} badgeLabel={t("ui.gallery.sidebar.results_badge", { count: 2 })} />
                <NavItem href="#gallery-sidebar" icon={<IconInfo />} label={t("ui.gallery.sidebar.details")} />
              </NavSection>
            </Sidebar>
          </div>
        </State>
      </Section>

      <Section name="page_header" wide>
        <State state="subtitle_and_actions">
          <PageHeader
            title={PROJECT_NAME}
            subtitle={t("ui.gallery.page_header.subtitle", { count: PHOTO_COUNT, camera: CAMERA })}
            actions={
              <>
                <Button variant="secondary">{t("ui.gallery.page_header.rename")}</Button>
                <Button>{t("ui.gallery.page_header.start")}</Button>
              </>
            }
          />
        </State>
      </Section>

      <Section name="card" wide>
        <State state="title_and_actions">
          <Card level={3} title={t("ui.gallery.card.title")} actions={<Button variant="quiet">{t("ui.gallery.card.action")}</Button>}>
            <p>{t("ui.gallery.card.text")}</p>
          </Card>
        </State>
        <State state="no_title">
          <Card><p>{t("ui.gallery.card.text")}</p></Card>
        </State>
      </Section>

      <Section name="status_pill">
        <State state="run_states">
          <div className="gallery-states">
            {RUN_STATES.map((state) => <StatusPill key={state} tone={RUN_STATE_TONES[state]}>{t(`run.state.${state}`)}</StatusPill>)}
          </div>
        </State>
        <State state="engine_states">
          <div className="gallery-states">
            {ENGINE_STATES.map((state) => <StatusPill key={state} tone={ENGINE_STATE_TONES[state]}>{t(`engine.state.${state}`)}</StatusPill>)}
          </div>
        </State>
      </Section>

      <Section name="chip">
        <State state="five_chips">
          <div className="gallery-states">
            <Chip>{t("ui.gallery.chip.quality")}</Chip>
            <Chip>{t("ui.gallery.chip.time")}</Chip>
            <Chip>{t("ui.gallery.chip.memory")}</Chip>
            <Chip>{t("ui.gallery.chip.disk")}</Chip>
            <Chip>{t("ui.gallery.chip.outputs")}</Chip>
          </div>
        </State>
      </Section>

      <Section name="empty_state" wide>
        <State state="title_and_action">
          <EmptyState icon={<IconImages />} title={t("ui.gallery.empty.title")} action={<Button>{t("ui.gallery.empty.action")}</Button>}>
            {t("ui.gallery.empty.text")}
          </EmptyState>
        </State>
      </Section>

      <Section name="drop_zone" wide>
        <State state="default">
          <DropZone
            title={t("ui.gallery.drop.title")}
            hint={t("ui.gallery.drop.hint")}
            chooseLabel={t("ui.gallery.drop.choose")}
            onChoose={(files) => setDropped(files.length)}
            onDrop={(data) => setDropped(data.files.length)}
          />
        </State>
        <State state="disabled">
          <DropZone
            title={t("ui.gallery.drop.title")}
            hint={t("ui.gallery.drop.hint")}
            chooseLabel={t("ui.gallery.drop.choose")}
            disabled
            onChoose={(files) => setDropped(files.length)}
            onDrop={(data) => setDropped(data.files.length)}
          />
        </State>
        <p id="gallery-drop-result" className="gallery-result" aria-live="polite">
          {dropped === null ? null : t("ui.gallery.drop.result", { count: dropped })}
        </p>
      </Section>

      <Section name="popover">
        <State state="closed">
          <Popover trigger={t("ui.gallery.popover.trigger")} label={t("ui.gallery.popover.label")}>
            <p>{t("ui.gallery.popover.first")}</p>
            <p>{t("ui.gallery.popover.second")}</p>
          </Popover>
        </State>
      </Section>

      <Section name="confirm_dialog">
        <State state="plain">
          <Button variant="secondary" onClick={() => setConfirming("plain")}>{t("ui.gallery.confirm.open_plain")}</Button>
        </State>
        <State state="danger">
          <Button variant="secondary" onClick={() => setConfirming("danger")}>{t("ui.gallery.confirm.open_danger")}</Button>
        </State>
        <ConfirmDialog
          open={confirming === "plain"}
          title={t("ui.gallery.confirm.plain_title")}
          confirmLabel={t("ui.gallery.confirm.plain_confirm")}
          onConfirm={() => answer("confirmed")}
          onCancel={() => answer("kept")}
        >
          <p>{t("ui.gallery.confirm.plain_text")}</p>
        </ConfirmDialog>
        <ConfirmDialog
          open={confirming === "danger"}
          danger
          title={t("ui.gallery.confirm.danger_title")}
          confirmLabel={t("ui.gallery.confirm.danger_confirm", { size: DELETE_SIZE })}
          onConfirm={() => answer("confirmed")}
          onCancel={() => answer("kept")}
        >
          <p>{t("ui.gallery.confirm.goes")}</p>
          <ul>
            <li>{t("ui.gallery.confirm.goes_orthophoto")}</li>
            <li>{t("ui.gallery.confirm.goes_model")}</li>
          </ul>
          <p>{t("ui.gallery.confirm.stays")}</p>
          <ul>
            <li>{t("ui.gallery.confirm.stays_photos")}</li>
            <li>{t("ui.gallery.confirm.stays_settings")}</li>
          </ul>
        </ConfirmDialog>
        <p id="gallery-confirm-result" className="gallery-result" aria-live="polite">
          {outcome === null ? null : t(`ui.gallery.confirm.${outcome}`)}
        </p>
      </Section>

      <Section name="stage_list" wide>
        <State state="every_state">
          <StageList
            label={t("ui.gallery.stages.label")}
            stages={[
              { id: "read", name: t("ui.gallery.stages.read"), state: "done", time: RUN_TIME },
              { id: "match", name: t("ui.gallery.stages.match"), state: "running", description: t("ui.gallery.stages.match_text"), progress: 42, progressLabel: t("ui.gallery.stages.match") },
              { id: "model", name: t("ui.gallery.stages.model"), state: "waiting" },
              { id: "report", name: t("ui.gallery.stages.report"), state: "skipped" },
              { id: "ortho", name: t("ui.gallery.stages.ortho"), state: "failed", description: t("ui.gallery.stages.ortho_text") },
            ]}
          />
        </State>
      </Section>

      <Section name="key_value_list" wide>
        <State state="five_facts">
          <KeyValueList
            items={[
              { id: "camera", key: t("ui.gallery.facts.camera"), value: FACTS.camera },
              { id: "photos", key: t("ui.gallery.facts.photos"), value: FACTS.photos },
              { id: "taken", key: t("ui.gallery.facts.taken"), value: FACTS.taken },
              { id: "height", key: t("ui.gallery.facts.height"), value: FACTS.height },
              { id: "size", key: t("ui.gallery.facts.size"), value: FACTS.size },
            ]}
          />
        </State>
      </Section>

      <Section name="thumbnail_grid" wide>
        <State state="six_tiles">
          <ThumbnailGrid
            label={t("ui.gallery.thumbnails.label")}
            items={THUMBNAILS.map((tile) => ({ id: tile.id, name: tile.id, src: tile.src, detail: CAMERA }))}
            onOpen={setOpened}
          />
          <p id="gallery-thumbnail-result" className="gallery-result" aria-live="polite">
            {opened === null ? null : t("ui.gallery.thumbnails.result", { name: opened })}
          </p>
        </State>
      </Section>

      <Section name="timeline" wide>
        <State state="two_flights">
          <Timeline
            label={t("ui.gallery.timeline.label")}
            start={TIMELINE_START}
            end={TIMELINE_END}
            rows={FLIGHTS.map((flight) => ({
              id: flight.id,
              label: t("ui.gallery.timeline.flight", { number: flight.id }),
              detail: t("ui.gallery.timeline.detail", { day: flight.day, first: flight.first, last: flight.last, count: flight.count }),
              start: flight.start,
              end: flight.end,
              muted: !included[flight.id],
              control: (
                <Toggle
                  id={`gallery-flight-${flight.id}`}
                  label={t("ui.gallery.timeline.include")}
                  checked={included[flight.id] ?? false}
                  onChange={(event) => setIncluded({ ...included, [flight.id]: event.target.checked })}
                />
              ),
              ...(flight.id === "1" ? { moreLabel: t("ui.gallery.timeline.more"), more: <p>{t("ui.gallery.timeline.more_text")}</p> } : {}),
            }))}
          />
        </State>
      </Section>

      <Section name="diff_panel" wide>
        <State state="three_rows">
          <DiffPanel
            label={t("ui.gallery.diff.label")}
            columns={{ name: t("ui.gallery.diff.setting"), from: t("ui.gallery.diff.default"), to: t("ui.gallery.diff.now") }}
            rows={differences.map((row) => {
              const name = t(`ui.gallery.diff.${row.id}`);
              return { id: row.id, name, code: row.code, from: row.from, to: row.to, resetLabel: t("ui.gallery.diff.reset_label", { name }) };
            })}
            onReset={(id) => setDifferences(differences.filter((row) => row.id !== id))}
            empty={t("ui.gallery.diff.empty")}
          />
        </State>
        <State state="nothing_differs">
          <DiffPanel
            label={t("ui.gallery.diff.label")}
            columns={{ name: t("ui.gallery.diff.setting"), from: t("ui.gallery.diff.default"), to: t("ui.gallery.diff.now") }}
            rows={[]}
            empty={t("ui.gallery.diff.empty")}
          />
        </State>
      </Section>

      <Section name="toolbar" wide>
        <State state="four_buttons">
          <Toolbar label={t("ui.gallery.toolbar.label")}>
            <Button variant="quiet"><IconArrowLeft />{t("ui.gallery.toolbar.back")}</Button>
            <span className="toolbar-separator" aria-hidden="true" />
            <Button variant="quiet"><IconLayers />{t("ui.gallery.toolbar.layers")}</Button>
            <Button variant="quiet"><IconRotateCcw />{t("ui.gallery.toolbar.reset")}</Button>
            <span className="toolbar-spacer" aria-hidden="true" />
            <Button variant="quiet"><IconDownload />{t("ui.gallery.toolbar.download")}</Button>
          </Toolbar>
        </State>
      </Section>

      <Section name="skeleton" wide>
        <State state="three_lines"><Skeleton lines={3} /></State>
      </Section>
    </main>
  );
}
