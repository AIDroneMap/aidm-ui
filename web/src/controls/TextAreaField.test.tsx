import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TextAreaField } from "./TextAreaField.tsx";

test("a multiline field labels its textarea and connects its hint and error", () => {
  const html = renderToStaticMarkup(<TextAreaField id="notes" label="Notes" hint="Add flight notes" error="Notes are too long" aria-describedby="notes-extra" defaultValue={"First flight\nSecond flight"} rows={4} maxLength={2000} disabled />);
  expect(html).toContain('<div class="field text-area-field"><label for="notes">Notes</label><textarea id="notes"');
  expect(html).toContain('aria-describedby="notes-extra notes-hint notes-error"');
  expect(html).toContain('aria-invalid="true"');
  expect(html).toContain('rows="4"');
  expect(html).toContain('maxLength="2000"');
  expect(html).toContain('disabled=""');
  expect(html).toContain('>First flight\nSecond flight</textarea>');
  expect(html).toContain('<p id="notes-hint" class="field-hint">Add flight notes</p>');
  expect(html).toContain('<p id="notes-error" class="field-error">Notes are too long</p>');
});

test("a multiline field omits absent descriptions and preserves explicit validity", () => {
  const html = renderToStaticMarkup(<TextAreaField id="notes" label="Notes" aria-invalid="false" />);
  expect(html).not.toContain("aria-describedby");
  expect(html).not.toContain("field-hint");
  expect(html).not.toContain("field-error");
  expect(html).toContain('aria-invalid="false"');
});
