import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "./Button.tsx";

test("a button exposes its label and native button behavior", () => {
  expect(renderToStaticMarkup(<Button>Save</Button>)).toContain('<button type="button">Save</button>');
});

test("a button variant is a class the existing screens already use", () => {
  expect(renderToStaticMarkup(<Button variant="secondary">Open</Button>)).toBe('<button type="button" class="secondary">Open</button>');
  expect(renderToStaticMarkup(<Button variant="quiet" className="wide">More</Button>)).toBe('<button type="button" class="quiet wide">More</button>');
  expect(renderToStaticMarkup(<Button variant="danger" type="submit">Delete</Button>)).toBe('<button type="submit" class="danger">Delete</button>');
});

test("an icon button is named by its label and hides its icon", async () => {
  const { IconButton } = await import("./IconButton.tsx");
  const { IconX } = await import("../icons/icons.tsx");
  const html = renderToStaticMarkup(<IconButton label="Close" icon={<IconX />} />);
  expect(html).toStartWith('<button type="button" class="icon-button" aria-label="Close" title="Close"><svg');
  expect(html).toContain('aria-hidden="true"');
});

test("an icon stands alone only with a label", async () => {
  const { IconLock } = await import("../icons/icons.tsx");
  expect(renderToStaticMarkup(<IconLock />)).toContain('aria-hidden="true"');
  const named = renderToStaticMarkup(<IconLock label="Locked" />);
  expect(named).toContain('role="img" aria-label="Locked"');
  expect(named).not.toContain("aria-hidden");
});

test("a text field associates its label with the input", async () => {
  const { TextField } = await import("./TextField.tsx");
  expect(renderToStaticMarkup(<TextField id="name" label="Name" />)).toContain('<label for="name">Name</label><input id="name" type="text"');
});

test("a text field points at its hint and its error and is marked invalid", async () => {
  const { TextField } = await import("./TextField.tsx");
  const html = renderToStaticMarkup(<TextField id="name" label="Name" hint="As the pilot calls it" error="Name is empty" />);
  expect(html).toContain('aria-describedby="name-hint name-error" aria-invalid="true"');
  expect(html).toContain('<p id="name-hint" class="field-hint">As the pilot calls it</p><p id="name-error" class="field-error">Name is empty</p>');
  expect(renderToStaticMarkup(<TextField id="name" label="Name" />)).not.toContain("aria-describedby");
});

test("a number field has a label and native number input", async () => {
  const { NumberField } = await import("./NumberField.tsx");
  expect(renderToStaticMarkup(<NumberField id="count" label="Count" />)).toContain('<label for="count">Count</label><input id="count" type="number"');
});

test("a select associates its label with its choices", async () => {
  const { Select } = await import("./Select.tsx");
  expect(renderToStaticMarkup(<Select id="choice" label="Choice"><option value="a">A</option></Select>)).toContain('<label for="choice">Choice</label><select id="choice"><option value="a">A</option></select>');
});

test("a toggle is a labelled checkbox announced as a switch", async () => {
  const { Toggle } = await import("./Toggle.tsx");
  expect(renderToStaticMarkup(<Toggle id="enabled" label="Enabled" />)).toContain('<input id="enabled" type="checkbox" role="switch"/><label for="enabled">Enabled</label>');
  expect(renderToStaticMarkup(<Toggle id="enabled" label="Enabled" hint="Turns it on" />)).toContain('aria-describedby="enabled-hint"/><label for="enabled">Enabled</label><p id="enabled-hint" class="field-hint">Turns it on</p>');
});

test("a disclosure has a native labelled summary", async () => {
  const { Disclosure } = await import("./Disclosure.tsx");
  expect(renderToStaticMarkup(<Disclosure label="More">Details</Disclosure>)).toBe('<details><summary>More</summary>Details</details>');
});

test("a table has a caption", async () => {
  const { Table } = await import("./Table.tsx");
  expect(renderToStaticMarkup(<Table label="Runs"><tbody><tr><td>One</td></tr></tbody></Table>)).toContain('<table><caption>Runs</caption>');
  expect(renderToStaticMarkup(<Table label="Runs" dense><tbody /></Table>)).toContain('<table class="table-dense"><caption>Runs</caption>');
});

test("a dialog has an accessible name", async () => {
  const { Dialog } = await import("./Dialog.tsx");
  expect(renderToStaticMarkup(<Dialog label="Confirm">Content</Dialog>)).toContain('<dialog aria-label="Confirm">Content</dialog>');
});

test("a notice announces its content in its tone, with the icon hidden from screen readers", async () => {
  const { Notice } = await import("./Notice.tsx");
  const html = renderToStaticMarkup(<Notice>Saved</Notice>);
  expect(html).toStartWith('<div role="status" class="notice notice-info"><svg');
  expect(html).toContain('aria-hidden="true"');
  expect(html).toEndWith('<div class="notice-body">Saved</div></div>');
  expect(renderToStaticMarkup(<Notice tone="danger" role="alert">Failed</Notice>)).toStartWith('<div role="alert" class="notice notice-danger">');
});

test("progress associates its label with its value", async () => {
  const { Progress } = await import("./Progress.tsx");
  expect(renderToStaticMarkup(<Progress id="progress" label="Progress" value={2} max={5} />)).toContain('<label for="progress">Progress</label><progress id="progress" value="2" max="5">');
});
