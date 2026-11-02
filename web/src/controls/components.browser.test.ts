import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import texts from "../i18n/en.json";
import { openBrowserSession, type BrowserSession } from "./browser-session.ts";
import { installAudits } from "./page-audits.ts";

const TOKENS = [...readFileSync(new URL("../tokens.css", import.meta.url), "utf8").matchAll(/--([\w-]+):\s*light-dark\(/g)].map((match) => match[1]!);
const NAMED_ROLES = new Set(["button", "link", "textbox", "searchbox", "combobox", "checkbox", "switch", "radio", "tab", "tablist", "tabpanel", "spinbutton", "progressbar", "toolbar", "dialog", "navigation", "radiogroup", "group"]);

type Focus = { key: number; where: string; ring: boolean } | null;

async function audit(page: BrowserSession, root = "document.body") {
  return {
    text: await page.evaluate<string[]>(`audits.textContrast(${root})`),
    edges: await page.evaluate<string[]>(`audits.edgeContrast(${root})`),
    colours: await page.evaluate<string[]>(`audits.strayColours(${JSON.stringify(TOKENS)}, ${root})`),
    native: await page.evaluate<string[]>(`audits.nativeLooks(${root})`),
  };
}

const clean = { text: [], edges: [], colours: [], native: [] };

/** Accessible names from the browser's own accessibility tree: every control, region and dialog must have one. */
async function unnamed(page: BrowserSession): Promise<string[]> {
  const { nodes } = await page.send("Accessibility.getFullAXTree");
  return nodes
    .filter((node: any) => !node.ignored && NAMED_ROLES.has(node.role?.value) && !String(node.name?.value ?? "").trim())
    .filter((node: any) => !(node.role.value === "group" && node.properties?.every((property: any) => property.name !== "focusable")))
    .map((node: any) => `${node.role.value} ${node.backendDOMNodeId}`);
}

async function focusOn(page: BrowserSession, selector: string) {
  await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
}

async function active(page: BrowserSession, expression: string): Promise<boolean> {
  return page.evaluate<boolean>(`(() => { const element = document.activeElement; return ${expression}; })()`);
}

async function journey(page: BrowserSession, theme: "light" | "dark") {
  // The theme switch is a segmented control: the arrow keys move its choice.
  await focusOn(page, "#gallery-theme input:checked");
  await page.press("ArrowRight");
  expect(await page.evaluate(`document.documentElement.dataset.theme`)).toBe(theme);
  const surface = await page.evaluate<string>("getComputedStyle(document.documentElement).backgroundColor");
  expect(surface).toBe(theme === "light" ? "rgb(255, 255, 255)" : "rgb(20, 22, 20)");

  expect(await audit(page)).toEqual(clean);
  expect(await unnamed(page)).toEqual([]);
  expect(await page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth")).toBe(true);

  // Tab reaches every control once, and every one shows the accent focus ring.
  // The walk starts from a mark at the top of the page that Tab itself never stops on.
  await page.evaluate("(() => { const start = document.createElement('span'); start.id = 'walk-start'; start.tabIndex = -1; document.body.prepend(start); start.focus(); })()");
  const expected = await page.evaluate<number[]>("audits.tabbable()");
  const walked: Focus[] = [];
  for (let step = 0; step < expected.length + 3; step++) {
    await page.press("Tab");
    const now = await page.evaluate<Focus>("audits.focused()");
    // The walk ends where focus leaves the page or comes round to the start again.
    if ((now === null && walked.length > 0) || (now && walked.some((item) => item!.key === now.key))) break;
    if (now) walked.push(now);
  }
  await page.evaluate("document.getElementById('walk-start').remove()");
  expect(walked.filter((item) => !item!.ring).map((item) => item!.where)).toEqual([]);
  expect(walked.map((item) => item!.key).sort((a, b) => a - b)).toEqual([...expected].sort((a, b) => a - b));

  // Text field and search: typing, the match count, Escape clears.
  await focusOn(page, "#gallery-search-field input[type=search]");
  await page.type("dji");
  expect(await page.evaluate<string>("document.querySelector('#gallery-search-field .field-hint').textContent")).toMatch(/^\d+ match(es)?$/);
  await page.press("Escape");
  expect(await page.evaluate("document.querySelector('#gallery-search-field input').value")).toBe("");

  // Select: the arrow keys change the choice.
  await focusOn(page, "#gallery-select select:not(:disabled)");
  const before = await page.evaluate<number>("document.activeElement.selectedIndex");
  const last = before === await page.evaluate<number>("document.activeElement.options.length - 1");
  await page.press(last ? "ArrowUp" : "ArrowDown");
  expect(await page.evaluate<number>("document.activeElement.selectedIndex")).toBe(last ? before - 1 : before + 1);

  // Switch and checkbox: Space flips them; the switch is announced as one.
  for (const selector of ["#gallery-toggle input[role=switch]:not(:disabled)", "#gallery-checkbox input[type=checkbox]:not(:disabled)"]) {
    await focusOn(page, selector);
    const was = await page.evaluate<boolean>("document.activeElement.checked");
    await page.press(" ");
    expect(await page.evaluate<boolean>("document.activeElement.checked")).toBe(!was);
  }

  // Radio group: the arrow keys move the choice.
  await focusOn(page, "#gallery-radio-group input:checked");
  const radio = await page.evaluate<string>("document.activeElement.id");
  await page.press("ArrowDown");
  expect(await active(page, `element.checked && element.id !== ${JSON.stringify(radio)}`)).toBe(true);

  // Disclosure: Space opens and closes.
  await focusOn(page, "#gallery-disclosure details:not([open]) summary");
  await page.press(" ");
  expect(await active(page, "element.parentElement.open")).toBe(true);
  await page.press(" ");
  expect(await active(page, "!element.parentElement.open")).toBe(true);

  // Tabs: the arrows, Home and End move the selection and the focus together.
  await focusOn(page, "#gallery-tabs [role=tab][aria-selected=true]");
  const tabs = await page.evaluate<number>("document.querySelectorAll('#gallery-tabs [role=tab]').length");
  await page.press("ArrowRight");
  expect(await active(page, "element.getAttribute('aria-selected') === 'true' && element === document.querySelectorAll('#gallery-tabs [role=tab]')[1] && !document.getElementById(element.getAttribute('aria-controls')).hidden")).toBe(true);
  await page.press("End");
  expect(await active(page, `element === document.querySelectorAll('#gallery-tabs [role=tab]')[${tabs - 1}] && element.getAttribute('aria-selected') === 'true'`)).toBe(true);
  await page.press("Home");
  expect(await active(page, "element === document.querySelector('#gallery-tabs [role=tab]') && element.tabIndex === 0")).toBe(true);

  // Sidebar: a navigation landmark of links, one marked as the current page.
  expect(await page.evaluate("document.querySelectorAll('#gallery-sidebar nav a[aria-current=page]').length")).toBe(1);

  // Popover: Enter opens it, Escape closes it and gives the focus back.
  await focusOn(page, "#gallery-popover .popover-trigger");
  await page.press("Enter");
  expect(await page.evaluate("document.querySelector('#gallery-popover .popover').matches(':popover-open')")).toBe(true);
  expect(await audit(page, "document.querySelector('#gallery-popover .popover')")).toEqual(clean);
  await page.press("Escape");
  expect(await page.evaluate("!document.querySelector('#gallery-popover .popover').matches(':popover-open')")).toBe(true);
  expect(await active(page, "element.matches('.popover-trigger')")).toBe(true);

  // Plain dialog: Enter opens it with the focus inside; Escape closes it.
  await focusOn(page, "#gallery-dialog button");
  await page.press("Enter");
  expect(await active(page, "element.closest('dialog[open]') !== null")).toBe(true);
  expect(await audit(page, "document.querySelector('#gallery-dialog dialog')")).toEqual(clean);
  await page.press("Escape");
  expect(await page.evaluate("document.querySelector('#gallery-dialog dialog').open")).toBe(false);

  // Confirm dialog, danger variant: Keep has the focus; Escape keeps; Tab then Enter confirms.
  const dangerOpener = "[...document.querySelectorAll('#gallery-confirm-dialog .gallery-state-item > button')].at(-1)";
  await page.evaluate(`${dangerOpener}.focus()`);
  await page.press("Enter");
  expect(await active(page, `element.closest('dialog.confirm-danger[open]') !== null && element.textContent === ${JSON.stringify(texts["ui.confirm.keep"])}`)).toBe(true);
  expect(await audit(page, "document.querySelector('dialog.confirm-danger')")).toEqual(clean);
  expect(await page.evaluate("document.querySelectorAll('dialog[open] button.danger').length")).toBe(1);
  expect(await page.evaluate(`${dangerOpener}.matches('.danger')`)).toBe(false);
  await page.press("Escape");
  expect(await page.evaluate("document.querySelector('dialog.confirm-danger').open")).toBe(false);
  expect(await page.evaluate<string>("document.querySelector('#gallery-confirm-result').textContent")).toBe(texts["ui.gallery.confirm.kept" as keyof typeof texts]);
  await page.evaluate(`${dangerOpener}.focus()`);
  await page.press("Enter");
  await page.press("Tab");
  expect(await active(page, "element.matches('dialog.confirm-danger button.danger')")).toBe(true);
  await page.press("Enter");
  expect(await page.evaluate<string>("document.querySelector('#gallery-confirm-result').textContent")).toBe(texts["ui.gallery.confirm.confirmed" as keyof typeof texts]);

  // Drop zone: dropped files reach the screen; the button is the keyboard's way in.
  await page.evaluate(`(() => {
    const data = new DataTransfer();
    data.items.add(new File(["a"], "DJI_0001.JPG"));
    data.items.add(new File(["b"], "DJI_0002.JPG"));
    const zone = document.querySelector('#gallery-drop-zone .drop-zone:not([aria-disabled])');
    zone.dispatchEvent(new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true }));
    zone.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
  })()`);
  expect(await page.evaluate<string>("document.querySelector('#gallery-drop-result').textContent")).toContain("2");

  // Toolbar: Tab enters on one control, the arrows move inside, Tab leaves.
  await focusOn(page, "#gallery-toolbar [role=toolbar] [tabindex='0']");
  const first = await page.evaluate<number>("[...document.querySelectorAll('#gallery-toolbar [role=toolbar] button')].indexOf(document.activeElement)");
  const count = await page.evaluate<number>("document.querySelectorAll('#gallery-toolbar [role=toolbar] button').length");
  await page.press("ArrowRight");
  expect(await page.evaluate<number>("[...document.querySelectorAll('#gallery-toolbar [role=toolbar] button')].indexOf(document.activeElement)")).toBe((first + 1) % count);
  await page.press("End");
  expect(await active(page, "element === [...document.querySelectorAll('#gallery-toolbar [role=toolbar] button')].at(-1)")).toBe(true);
  expect(await page.evaluate("document.querySelectorAll('#gallery-toolbar [role=toolbar] [tabindex=\"0\"]').length")).toBe(1);
  await page.press("Tab");
  expect(await active(page, "element.closest('[role=toolbar]') === null")).toBe(true);

  // Thumbnail grid: Enter opens a tile.
  await focusOn(page, "#gallery-thumbnail-grid .thumbnail-button");
  await page.press("Enter");
  expect(await page.evaluate<string>("document.querySelector('#gallery-thumbnail-result').textContent")).not.toBe("");

  // Timeline: the flight's switch flips with Space.
  await focusOn(page, "#gallery-timeline input[role=switch]");
  const included = await page.evaluate<boolean>("document.activeElement.checked");
  await page.press(" ");
  expect(await page.evaluate<boolean>("document.activeElement.checked")).toBe(!included);

  // Compare panel: Enter on a reset button takes its row away.
  const rows = await page.evaluate<number>("document.querySelectorAll('#gallery-diff-panel tbody tr').length");
  await focusOn(page, "#gallery-diff-panel tbody button");
  await page.press("Enter");
  expect(await page.evaluate<number>("document.querySelectorAll('#gallery-diff-panel tbody tr').length")).toBe(rows - 1);

  // Stage list: every stage says its state in words, the running one is the current step.
  expect(await page.evaluate("[...document.querySelectorAll('#gallery-stage-list .stage')].every((stage) => stage.querySelector('.stage-state').textContent.trim() !== '')")).toBe(true);
  expect(await page.evaluate("document.querySelectorAll('#gallery-stage-list [aria-current=step]').length")).toBe(1);

  // Text-only components take no focus: chips, pills, skeletons, key and value lists.
  expect(await page.evaluate("[...document.querySelectorAll('.chip, .status-pill, .skeleton, .key-value, .empty-state-icon')].every((element) => element.querySelector('a, button, input, [tabindex]') === null && !element.hasAttribute('tabindex'))")).toBe(true);
  expect(await page.evaluate<string>("document.querySelector('.skeleton[role=status]').textContent")).toBe(texts["ui.loading"]);
}

test("every component works by keyboard, is named and meets contrast in the light and the dark theme", async () => {
  const page = await openBrowserSession(new URL("./gallery/main.tsx", import.meta.url).pathname);
  try {
    await page.send("Accessibility.enable");
    await page.evaluate(`(${installAudits.toString()})()`);
    const motion = "(() => { const probe = document.body.appendChild(document.createElement('span')); probe.style.transitionDuration = 'var(--motion-state)'; const value = getComputedStyle(probe).transitionDuration; probe.remove(); return value; })()";
    expect(await page.evaluate(motion)).toBe("0.12s");
    // Colours are judged at rest: with reduced motion nothing is half way through a transition.
    await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    expect(await page.evaluate(motion)).toBe("0s");
    await journey(page, "light");
    await journey(page, "dark");

    // Below 64 rem the sidebar keeps only its icons; a link shows its words on focus and keeps its name.
    await page.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 900, deviceScaleFactor: 1, mobile: false });
    const label = "document.querySelector('#gallery-sidebar .nav-item .nav-label')";
    expect(await page.evaluate(`getComputedStyle(${label}).clipPath`)).not.toBe("none");
    await focusOn(page, "#gallery-sidebar .nav-item");
    await page.press("Tab", true);
    await page.press("Tab");
    expect(await active(page, "element.matches('#gallery-sidebar .nav-item')")).toBe(true);
    expect(await page.evaluate(`getComputedStyle(${label}).clipPath`)).toBe("none");
    expect(await unnamed(page)).toEqual([]);
  } finally {
    await page.close();
  }
}, 120000);

test("the page audits fail a low contrast, a stray colour, a native control and a missing ring", async () => {
  const page = await openBrowserSession(new URL("./gallery/main.tsx", import.meta.url).pathname);
  try {
    await page.evaluate(`(${installAudits.toString()})()`);
    await page.evaluate(`(() => {
      const box = document.createElement('div');
      box.id = 'broken';
      box.innerHTML = '<p style="color:#bbbbbb">Faint</p><a href="#x" style="color:#0000ee">Link</a><input type="checkbox" style="appearance:auto" id="native"><button id="ringless" style="outline:none">Go</button>';
      document.querySelector('main').prepend(box);
    })()`);
    const root = "document.getElementById('broken')";
    expect((await page.evaluate<string[]>(`audits.textContrast(${root})`)).join()).toContain("Faint");
    expect((await page.evaluate<string[]>(`audits.strayColours(${JSON.stringify(TOKENS)}, ${root})`)).join()).toContain("rgb(0, 0, 238)");
    expect((await page.evaluate<string[]>(`audits.nativeLooks(${root})`)).length).toBe(1);
    await focusOn(page, "#ringless");
    await page.press("Tab", true);
    await page.press("Tab");
    expect(await page.evaluate("audits.focused().ring")).toBe(false);
  } finally {
    await page.close();
  }
}, 60000);
