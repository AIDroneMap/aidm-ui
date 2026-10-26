import { expect, test } from "bun:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BusyButton } from "./BusyButton.tsx";

test("a busy button is marked aria-disabled, is not disabled and keeps its label", () => {
  const html = renderToStaticMarkup(
    <BusyButton busy onClick={() => {}}>
      Check again
    </BusyButton>,
  );
  expect(html).toContain('aria-disabled="true"');
  expect(html).not.toMatch(/(?<!aria-)disabled=/);
  expect(html).toContain(">Check again</button>");
});

test("an idle button has no disabled marking", () => {
  const html = renderToStaticMarkup(
    <BusyButton busy={false} onClick={() => {}} className="secondary">
      Check again
    </BusyButton>,
  );
  expect(html).not.toContain("disabled");
  expect(html).toContain('class="secondary"');
});

test("a click is ignored while busy and passed on when idle", () => {
  let clicks = 0;
  const click = (busy: boolean) => {
    const button = BusyButton({ busy, onClick: () => (clicks += 1), children: "Go" }) as ReactElement<{
      onClick: () => void;
    }>;
    button.props.onClick();
  };
  click(true);
  expect(clicks).toBe(0);
  click(false);
  expect(clicks).toBe(1);
});
