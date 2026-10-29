import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "./Button.tsx";

test("a button exposes its label and native button behavior", () => {
  expect(renderToStaticMarkup(<Button>Save</Button>)).toContain('<button type="button">Save</button>');
});

test("a text field associates its label with the input", async () => {
  const { TextField } = await import("./TextField.tsx");
  expect(renderToStaticMarkup(<TextField id="name" label="Name" />)).toContain('<label for="name">Name</label><input id="name" type="text"');
});

test("a number field has a label and native number input", async () => {
  const { NumberField } = await import("./NumberField.tsx");
  expect(renderToStaticMarkup(<NumberField id="count" label="Count" />)).toContain('<label for="count">Count</label><input id="count" type="number"');
});

test("a select associates its label with its choices", async () => {
  const { Select } = await import("./Select.tsx");
  expect(renderToStaticMarkup(<Select id="choice" label="Choice"><option value="a">A</option></Select>)).toContain('<label for="choice">Choice</label><select id="choice"><option value="a">A</option></select>');
});

test("a toggle is a labelled checkbox", async () => {
  const { Toggle } = await import("./Toggle.tsx");
  expect(renderToStaticMarkup(<Toggle id="enabled" label="Enabled" />)).toContain('<input id="enabled" type="checkbox"/><label for="enabled">Enabled</label>');
});

test("a disclosure has a native labelled summary", async () => {
  const { Disclosure } = await import("./Disclosure.tsx");
  expect(renderToStaticMarkup(<Disclosure label="More">Details</Disclosure>)).toBe('<details><summary>More</summary>Details</details>');
});

test("a table has a caption", async () => {
  const { Table } = await import("./Table.tsx");
  expect(renderToStaticMarkup(<Table label="Runs"><tbody><tr><td>One</td></tr></tbody></Table>)).toContain('<table><caption>Runs</caption>');
});

test("a dialog has an accessible name", async () => {
  const { Dialog } = await import("./Dialog.tsx");
  expect(renderToStaticMarkup(<Dialog label="Confirm">Content</Dialog>)).toContain('<dialog aria-label="Confirm">Content</dialog>');
});

test("a notice announces its content", async () => {
  const { Notice } = await import("./Notice.tsx");
  expect(renderToStaticMarkup(<Notice>Warning</Notice>)).toContain('role="status">Warning');
});

test("progress associates its label with its value", async () => {
  const { Progress } = await import("./Progress.tsx");
  expect(renderToStaticMarkup(<Progress id="progress" label="Progress" value={2} max={5} />)).toContain('<label for="progress">Progress</label><progress id="progress" value="2" max="5">');
});
