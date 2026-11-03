import { expect, test } from "bun:test";
import { OPTION_CATALOGUE } from "../../../../shared/option-catalogue.ts";
import texts from "../../i18n/en.json";
import { openBrowserSession } from "../../controls/browser-session.ts";

const words = texts as Record<string, string>;
const shown = OPTION_CATALOGUE.flatMap((option) => option.bin === "shown" ? [option] : []);

test("every row shows what section 6.3 lists, the headings stay at the top, and the rail follows the scroll at tablet width", async () => {
  const page = await openBrowserSession(new URL("./groups-browser-fixture.tsx", import.meta.url).pathname, { width: 768, height: 1024 });
  try {
    const { evaluate, press, type } = page;
    const wait = (condition: string) => evaluate(`new Promise((resolve, reject) => { const end = Date.now() + 4000; const check = () => (${condition}) ? resolve(true) : Date.now() > end ? reject(Error(${JSON.stringify(condition)})) : setTimeout(check, 20); check(); })`);
    await wait("document.querySelectorAll('.settings-row').length === 81");

    // One row per option the task API offers, and one for the option the catalogue does not know; none for the ten it does not offer.
    expect(shown).toHaveLength(80);
    const rows = await evaluate<Array<{ name: string; label: string; flag: string; text: string; chips: number; facts: boolean; more: string[]; words: string; reason: string; disabled: boolean }>>(`[...document.querySelectorAll('.settings-row')].map(row => {
      const control = row.querySelector('input, select');
      return { name: row.dataset.option, label: control.labels[0]?.textContent ?? '', flag: row.querySelector('.settings-flag')?.textContent ?? '', text: row.querySelector('.settings-row-text')?.textContent ?? '',
        chips: row.querySelectorAll('.settings-affects .chip').length, facts: Boolean(row.querySelector('.settings-row-facts')?.textContent),
        more: [...row.querySelectorAll('.settings-more dd')].map(el => el.textContent), words: row.querySelector('.settings-engine-words blockquote')?.textContent ?? '',
        reason: row.querySelector('.settings-row-reason')?.textContent ?? '', disabled: control.disabled };
    })`);
    for (const option of shown) {
      const row = rows.find((item) => item.name === option.name)!;
      expect(row, option.name).toBeDefined();
      expect(row.label, option.name).toBe(words[`option.${option.name}.name`]!);
      expect(row.flag, option.name).toBe(option.name);
      expect(row.text, option.name).toBe(words[`option.${option.name}.description`]!);
      expect(row.chips, option.name).toBe(option.affects.length);
      expect(row.facts, option.name).toBe(option.locked === null);
      expect(row.more, option.name).toEqual(["when", "cost", "example"].map((field) => words[`option.${option.name}.${field}`]!));
      expect(row.words, option.name).toBe(`Engine help for ${option.name}. Default: ${option.defaultValue}`);
      if (option.locked !== null) {
        expect(row.disabled, option.name).toBe(true);
        expect(row.reason, option.name).toBe(words[`settings.locked.${option.locked}`]!);
      }
    }
    expect(shown.filter((option) => option.locked !== null).map((option) => option.name).sort()).toEqual(["cog", "gltf", "pc-ept"]);
    for (const option of OPTION_CATALOGUE.filter((entry) => entry.bin === "not-offered")) expect(rows.some((row) => row.name === option.name)).toBe(false);
    expect(rows.find((row) => row.name === "future-option")!.text).toBe("<img src=x onerror=alert(1)> & engine help");
    expect(await evaluate("document.querySelector('img[src=x]') === null")).toBe(true);
    expect(await evaluate("[...document.querySelectorAll('input, select, textarea')].every(el => el.labels?.length || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby'))")).toBe(true);
    expect(await evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth")).toBe(true);

    // The rail jumps to a group by keyboard; its heading stays at the top while its rows scroll, and the rail marks the group being read.
    const railButton = (group: string) => `[...document.querySelectorAll('.settings-rail-group')].find(el => el.textContent.startsWith(${JSON.stringify(words[`settings.group.${group}`])}))`;
    await press("Tab");
    await evaluate(`${railButton("orthophoto")}.focus(); true`);
    expect(await evaluate("document.activeElement.matches(':focus-visible') && getComputedStyle(document.activeElement).outlineStyle !== 'none'")).toBe(true);
    await press("Enter");
    await wait(`document.activeElement?.id === 'settings-group-orthophoto-heading' && ${railButton("orthophoto")}.getAttribute('aria-current') === 'true'`);
    expect(await evaluate("Math.abs(document.querySelector('#settings-group-orthophoto-heading').getBoundingClientRect().top) < 2")).toBe(true);
    expect(await evaluate("getComputedStyle(document.querySelector('#settings-group-orthophoto-heading')).position")).toBe("sticky");
    await evaluate("window.scrollBy(0, 300); true");
    await wait("Math.abs(document.querySelector('#settings-group-orthophoto-heading').getBoundingClientRect().top) < 2");
    await evaluate("document.querySelector('#settings-group-outputs-and-formats').scrollIntoView(); window.scrollBy(0, 50); true");
    await wait(`${railButton("outputs-and-formats")}.getAttribute('aria-current') === 'true' && !${railButton("orthophoto")}.hasAttribute('aria-current')`);

    // Search by keyboard narrows the rows across every group, says how many match and opens the More texts.
    await evaluate("document.querySelector('#settings-search').focus(); true");
    await type("vertices");
    await wait("document.querySelectorAll('.settings-row').length === 1");
    expect(await evaluate("document.querySelector('.settings-row').dataset.option")).toBe("mesh-octree-depth");
    expect(await evaluate("document.querySelector('#settings-search-count').textContent")).toBe("1 match");
    expect(await evaluate("document.querySelector('.settings-row .settings-more').open")).toBe(true);
    await press("Escape");
    await wait("document.querySelectorAll('.settings-row').length === 81");
  } finally {
    await page.close();
  }
}, 60000);
