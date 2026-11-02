import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import texts from "../i18n/en.json";
import { IconFolder, IconImages } from "../icons/icons.tsx";
import { Card } from "./Card.tsx";
import { Checkbox } from "./Checkbox.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { DiffPanel } from "./DiffPanel.tsx";
import { DropZone } from "./DropZone.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { Progress } from "./Progress.tsx";
import { RadioGroup } from "./RadioGroup.tsx";
import { SearchField } from "./SearchField.tsx";
import { SegmentedControl } from "./SegmentedControl.tsx";
import { NavItem, NavSection, Sidebar } from "./Sidebar.tsx";
import { Skeleton } from "./Skeleton.tsx";
import { StageList } from "./StageList.tsx";
import { ENGINE_STATE_TONES, RUN_STATE_TONES, StatusPill } from "./StatusPill.tsx";
import { Tabs } from "./Tabs.tsx";
import { Timeline } from "./Timeline.tsx";
import { Toolbar } from "./Toolbar.tsx";
import { ENGINE_STATES, RUN_STATES } from "../../../shared/api-types.ts";

const noop = () => {};

test("a checkbox is a native labelled checkbox with its hint as description", () => {
  const html = renderToStaticMarkup(<Checkbox id="keep" label="Keep the photos" hint="They stay on this computer" />);
  expect(html).toContain('<input id="keep" type="checkbox" aria-describedby="keep-hint"/><label for="keep">Keep the photos</label><p id="keep-hint" class="field-hint">They stay on this computer</p>');
});

test("a radio group is a fieldset with a legend, one native radio per choice and its hint as description", () => {
  const html = renderToStaticMarkup(<RadioGroup name="mode" legend="How" value="copy" onChange={noop} options={[{ value: "copy", label: "Copy", hint: "Safe" }, { value: "move", label: "Move" }]} />);
  expect(html).toStartWith('<fieldset class="radio-group"><legend>How</legend>');
  expect(html).toContain('<input id="mode-copy" type="radio" aria-describedby="mode-copy-hint" name="mode" checked="" value="copy"/><label for="mode-copy">Copy</label><p id="mode-copy-hint" class="field-hint">Safe</p>');
  expect(html).toContain('<input id="mode-move" type="radio" name="mode" value="move"/><label for="mode-move">Move</label>');
});

test("a segmented control is a radio group whose legend can be for screen readers only", () => {
  const html = renderToStaticMarkup(<SegmentedControl name="theme" legend="Theme" hideLegend value="dark" onChange={noop} options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} />);
  expect(html).toContain('<legend class="visually-hidden">Theme</legend>');
  expect(html).toContain('id="theme-dark" type="radio" name="theme" checked="" value="dark"/><label class="segmented-option" for="theme-dark">Dark</label>');
});

test("a search field says how many things match, and only while there is a search", () => {
  expect(renderToStaticMarkup(<SearchField id="find" label="Find" value="dsm" matches={3} onChange={noop} />)).toContain(`>${texts["ui.search.matches_other"].replace("{count}", "3")}</p>`);
  expect(renderToStaticMarkup(<SearchField id="find" label="Find" value="dsm" matches={1} onChange={noop} />)).toContain(`>${texts["ui.search.matches_one"]}</p>`);
  const empty = renderToStaticMarkup(<SearchField id="find" label="Find" value="" matches={80} onChange={noop} />);
  expect(empty).toContain('<p id="find-count" class="field-hint" aria-live="polite"></p>');
  expect(empty).not.toContain(texts["ui.search.clear"]);
  expect(renderToStaticMarkup(<SearchField id="find" label="Find" value="x" onChange={noop} />)).toContain(`aria-label="${texts["ui.search.clear"]}"`);
});

test("tabs mark the open tab, tie each tab to its panel and keep only the open tab in the Tab order", () => {
  const html = renderToStaticMarkup(<Tabs label="Views" tabs={[{ id: "a", label: "Map", content: "Map view" }, { id: "b", label: "Model", content: "Model view" }]} />);
  expect(html).toContain('role="tablist" aria-label="Views"');
  expect(html).toMatch(/role="tab" id="([^"]+)-tab-a" class="tabs-tab" aria-selected="true" aria-controls="\1-panel-a" tabindex="0">Map/);
  expect(html).toMatch(/role="tab" id="[^"]+-tab-b" class="tabs-tab" aria-selected="false" aria-controls="[^"]+-panel-b" tabindex="-1">Model/);
  expect(html).toMatch(/role="tabpanel" id="[^"]+-panel-b" aria-labelledby="[^"]+-tab-b" class="tabs-panel" tabindex="0" hidden=""><\/div>/);
});

test("the sidebar is a named navigation of links, the current one marked, a badge said in words", () => {
  const html = renderToStaticMarkup(<Sidebar label="Main"><NavSection title="Vineyard"><NavItem href="#/p" icon={<IconImages />} label="Photos" current badge={312} badgeLabel="312 photos" /><NavItem href="#/e" icon={<IconFolder />} label="Engines" /></NavSection></Sidebar>);
  expect(html).toStartWith('<nav class="sidebar" aria-label="Main">');
  expect(html).toMatch(/<p class="nav-section-title" id="([^"]+)">Vineyard<\/p><ul class="nav-list" aria-labelledby="\1">/);
  expect(html).toContain('<a class="nav-item" href="#/p" aria-current="page">');
  expect(html).toContain('<span class="nav-label">Photos</span><span class="nav-badge" aria-hidden="true">312</span><span class="visually-hidden">312 photos</span>');
  expect(html).toContain('<a class="nav-item" href="#/e"><svg');
});

test("a card with a title is a region named by it", () => {
  expect(renderToStaticMarkup(<Card title="Storage">Body</Card>)).toMatch(/^<section class="card" aria-labelledby="([^"]+)"><header class="card-header"><h2 id="\1" class="card-title">Storage<\/h2><\/header>Body<\/section>$/);
  expect(renderToStaticMarkup(<Card>Body</Card>)).toBe('<section class="card">Body</section>');
});

test("every run and engine state has a pill tone, and a pill carries its state in words", () => {
  expect(Object.keys(RUN_STATE_TONES).sort()).toEqual([...RUN_STATES].sort());
  expect(Object.keys(ENGINE_STATE_TONES).sort()).toEqual([...ENGINE_STATES].sort());
  expect(RUN_STATE_TONES.failed).toBe("danger");
  expect(RUN_STATE_TONES.completed).toBe("ok");
  expect(renderToStaticMarkup(<StatusPill tone="running">Running</StatusPill>)).toBe('<span class="status-pill status-running"><span class="status-dot" aria-hidden="true"></span>Running</span>');
});

test("an empty state says what to do next with one action", () => {
  const html = renderToStaticMarkup(<EmptyState icon={<IconImages />} title="No photos yet" action={<button>Add photos</button>}>Drop the photos of a flight.</EmptyState>);
  expect(html).toContain('<h2 class="empty-state-title">No photos yet</h2><p class="empty-state-text">Drop the photos of a flight.</p><div class="empty-state-action"><button>Add photos</button></div>');
});

test("a drop zone's button is the keyboard's way in and is described by the zone's title", () => {
  const html = renderToStaticMarkup(<DropZone title="Drop photos here" chooseLabel="Choose photos" onChoose={noop} onDrop={noop} />);
  expect(html).toMatch(/<p class="drop-zone-title" id="([^"]+)-title">Drop photos here<\/p>/);
  expect(html).toMatch(/<input id="[^"]+" type="file" class="visually-hidden" tabindex="-1" aria-hidden="true" multiple=""\/>/);
  expect(html).toMatch(/<button type="button" class="secondary" aria-describedby="[^"]+-title">Choose photos<\/button>/);
});

test("a stage list names each stage's state in words and marks the running one", () => {
  const html = renderToStaticMarkup(<StageList label="Stages" stages={[{ id: "a", name: "Matching", state: "running", progress: 42, progressLabel: "Matching" }, { id: "b", name: "Mesh", state: "failed" }]} />);
  expect(html).toStartWith('<ol class="stage-list" aria-label="Stages">');
  expect(html).toContain(`<li class="stage stage-running" aria-current="step">`);
  expect(html).toContain(`<span class="stage-state">${texts["ui.stage.running"]}</span>`);
  expect(html).toContain(`<span class="stage-state">${texts["ui.stage.failed"]}</span>`);
  expect(html).toContain(`class="visually-hidden">${texts["ui.stage.progress"].replace("{name}", "Matching")}</label><progress id=`);
});

test("progress can keep its label for screen readers only", () => {
  expect(renderToStaticMarkup(<Progress id="p" label="Upload" hideLabel value={1} max={2} />)).toContain('<label for="p" class="visually-hidden">Upload</label><progress id="p" value="1" max="2">');
});

test("a timeline row says its facts in words and hides the bar from screen readers", () => {
  const html = renderToStaticMarkup(<Timeline label="Flights" start={0} end={100} rows={[{ id: "1", label: "Flight 1", detail: "10:02 to 10:31, 212 photos", start: 0, end: 50, muted: true }]} />);
  expect(html).toContain('<ul class="timeline" aria-label="Flights"><li class="timeline-row timeline-muted">');
  expect(html).toContain('<span class="timeline-detail">10:02 to 10:31, 212 photos</span>');
  expect(html).toContain('<div class="timeline-track" aria-hidden="true">');
});

test("a compare panel names each reset by its row and says when nothing differs", () => {
  const rows = [{ id: "dsm", name: "Surface model", code: "--dsm", from: "Off", to: "On", resetLabel: "Reset Surface model" }];
  const html = renderToStaticMarkup(<DiffPanel label="Changed" columns={{ name: "Option", from: "Default", to: "Yours" }} rows={rows} onReset={noop} empty="Nothing changed" />);
  expect(html).toContain('<table class="table-dense"><caption>Changed</caption>');
  expect(html).toContain(`<button type="button" class="quiet" aria-label="Reset Surface model">${texts["ui.diff.reset"]}</button>`);
  expect(renderToStaticMarkup(<DiffPanel label="Changed" columns={{ name: "Option", from: "Default", to: "Yours" }} rows={[]} empty="Nothing changed" />)).toContain('<p class="diff-empty">Nothing changed</p>');
});

test("a confirmation names itself by its title and offers Keep before the action", () => {
  const html = renderToStaticMarkup(<ConfirmDialog open={false} danger title="Delete the run?" confirmLabel="Delete 4.2 GB" onConfirm={noop} onCancel={noop}>Goes</ConfirmDialog>);
  expect(html).toMatch(/^<dialog class="confirm-dialog confirm-danger" aria-labelledby="([^"]+)"><h2 id="\1" class="dialog-title">Delete the run\?<\/h2>/);
  expect(html).toContain(`<button type="button" class="secondary">${texts["ui.confirm.keep"]}</button><button type="button" class="danger">Delete 4.2 GB</button>`);
});

test("a toolbar is named and a skeleton says it is loading", () => {
  expect(renderToStaticMarkup(<Toolbar label="Map tools"><button>Back</button></Toolbar>)).toBe('<div role="toolbar" aria-label="Map tools" class="toolbar"><button>Back</button></div>');
  expect(renderToStaticMarkup(<Skeleton lines={2} />)).toBe(`<div class="skeleton" role="status" aria-busy="true"><span class="visually-hidden">${texts["ui.loading"]}</span><span class="skeleton-line" aria-hidden="true"></span><span class="skeleton-line" aria-hidden="true"></span></div>`);
});
