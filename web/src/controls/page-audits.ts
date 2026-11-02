/**
 * Checks that run inside the page under test. The test sends this function
 * to the browser as source text, so it uses nothing from outside its body.
 * It installs window.audits; every check returns the places that fail, as
 * short lines naming the gallery section, the element and its text.
 */
export function installAudits() {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  type Colour = [number, number, number, number];

  // The canvas reads any colour syntax the browser computes, color-mix() results included.
  function rgba(colour: string): Colour {
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = "#000";
    context.fillStyle = colour;
    context.fillRect(0, 0, 1, 1);
    const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
    return [red!, green!, blue!, alpha! / 255];
  }

  function over(top: Colour, bottom: Colour): Colour {
    const alpha = top[3];
    return [top[0] * alpha + bottom[0] * (1 - alpha), top[1] * alpha + bottom[1] * (1 - alpha), top[2] * alpha + bottom[2] * (1 - alpha), 1];
  }

  function background(element: Element | null): Colour {
    const layers: Colour[] = [];
    for (let node = element; node; node = node.parentElement) {
      const colour = rgba(getComputedStyle(node).backgroundColor);
      if (colour[3] > 0) layers.push(colour);
      if (colour[3] >= 1) break;
    }
    return layers.reverse().reduce<Colour>((below, layer) => over(layer, below), [255, 255, 255, 1]);
  }

  function luminance([red, green, blue]: Colour): number {
    const linear = (value: number) => { const channel = value / 255; return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
  }

  function contrast(first: Colour, second: Colour): number {
    const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a);
    return (light! + 0.05) / (dark! + 0.05);
  }

  function visible(element: Element): boolean {
    const box = element.getBoundingClientRect();
    return element.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && box.width > 1 && box.height > 1;
  }

  function disabled(element: Element): boolean {
    return element.closest(":disabled, [aria-disabled='true']") !== null;
  }

  function where(element: Element): string {
    const section = element.closest(".gallery-section, dialog, [popover]");
    const name = section?.id || section?.localName || "page";
    const classes = typeof element.className === "string" && element.className ? `.${element.className.trim().split(/\s+/).join(".")}` : "";
    return `${name}: ${element.localName}${classes} "${(element.textContent ?? "").trim().slice(0, 40)}"`;
  }

  /** Text below 4.5:1 against what is behind it. Disabled controls are exempt, as WCAG allows. */
  function textContrast(root: Element = document.body): string[] {
    const failures: string[] = [];
    const fields = "input:not([type=checkbox], [type=radio], [type=file], [type=range]), select, textarea";
    for (const element of root.querySelectorAll("*")) {
      if (element instanceof SVGElement) continue;
      const ownText = [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim());
      if (!(ownText || element.matches(fields)) || !visible(element) || disabled(element)) continue;
      const behind = background(element);
      const ratio = contrast(over(rgba(getComputedStyle(element).color), behind), behind);
      if (ratio < 4.5) failures.push(`${where(element)} text ${ratio.toFixed(2)}:1`);
    }
    return failures;
  }

  /** Control edges below 3:1 against what is around them (WCAG 1.4.11): field borders, boxes, rings, switch tracks, progress. */
  function edgeContrast(root: Element = document.body): string[] {
    const failures: string[] = [];
    for (const element of root.querySelectorAll<HTMLElement>("input:not([type=file]), select, textarea, progress, .segmented-track")) {
      if (!visible(element) || disabled(element)) continue;
      const style = getComputedStyle(element);
      const input = element as HTMLInputElement;
      const filled = element.matches("progress, [role=switch]") || ((input.type === "checkbox" || input.type === "radio") && input.checked);
      const edge = element.matches("progress") ? rgba(style.color) : rgba(filled ? style.backgroundColor : style.borderTopColor);
      const around = element.matches("progress") ? rgba(style.backgroundColor) : background(element.parentElement);
      const ratio = contrast(over(edge, around), around);
      if (ratio < 3) failures.push(`${where(element)} edge ${ratio.toFixed(2)}:1`);
    }
    return failures;
  }

  /** Every colour the page paints, compared with the colour tokens of the current theme. A colour that is no token, such as a browser's default blue, fails. */
  function strayColours(tokens: string[], root: Element = document.body): string[] {
    const probe = document.createElement("span");
    root.append(probe);
    const allowed = new Set(["0,0,0,0"]);
    for (const token of tokens) {
      probe.style.color = `var(--${token})`;
      allowed.add(rgba(getComputedStyle(probe).color).join());
    }
    probe.remove();
    const failures: string[] = [];
    for (const element of root.querySelectorAll("*")) {
      if (!visible(element)) continue;
      const style = getComputedStyle(element);
      // Checkboxes and radio buttons draw no text, so their text colour paints nothing.
      const drawsText = !element.matches("input[type=checkbox], input[type=radio], input[type=file]");
      const painted: [string, string][] = drawsText ? [["color", style.color], ["background", style.backgroundColor]] : [["background", style.backgroundColor]];
      for (const side of ["Top", "Right", "Bottom", "Left"] as const) {
        if (style.getPropertyValue(`border-${side.toLowerCase()}-style`) !== "none" && parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`)) > 0) painted.push([`border-${side.toLowerCase()}`, style.getPropertyValue(`border-${side.toLowerCase()}-color`)]);
      }
      if (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0) painted.push(["outline", style.outlineColor]);
      for (const [property, value] of painted) {
        const colour = rgba(value);
        if (colour[3] === 0) continue;
        if (!allowed.has(colour.join())) failures.push(`${where(element)} ${property} ${value}`);
      }
    }
    return [...new Set(failures)];
  }

  /** Checkboxes, radios, selects and progress bars that still draw the browser's own look. */
  function nativeLooks(root: Element = document.body): string[] {
    return [...root.querySelectorAll("input[type=checkbox], input[type=radio], select, progress")]
      .filter((element) => visible(element) && getComputedStyle(element).appearance !== "none")
      .map(where);
  }

  const keys = new WeakMap<Element, number>();
  let counted = 0;
  function key(element: Element): number {
    if (!keys.has(element)) keys.set(element, ++counted);
    return keys.get(element)!;
  }

  /** The elements Tab should reach, in no particular order: one radio per group, nothing disabled or hidden. */
  function tabbable(): number[] {
    const candidates = [...document.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, summary, [tabindex]")];
    return candidates.filter((element) => {
      if (element.tabIndex < 0 || element.matches(":disabled") || !element.checkVisibility()) return false;
      if (element instanceof HTMLInputElement && element.type === "radio") {
        const group = [...document.querySelectorAll<HTMLInputElement>(`input[type=radio][name="${element.name}"]`)].filter((radio) => !radio.disabled);
        return group.some((radio) => radio.checked) ? element.checked : group[0] === element;
      }
      return true;
    }).map(key);
  }

  /** The focused element and whether it shows the focus ring: 2 pixels or more, in the accent colour. */
  function focused(): { key: number; where: string; ring: boolean } | null {
    const element = document.activeElement;
    if (!element || element === document.body) return null;
    const target = element.matches(".segmented-input") ? element.nextElementSibling! : element;
    const style = getComputedStyle(target);
    const probe = document.createElement("span");
    document.body.append(probe);
    probe.style.color = "var(--accent)";
    const accent = rgba(getComputedStyle(probe).color).join();
    probe.remove();
    const ring = element.matches(":focus-visible") && style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 2 && rgba(style.outlineColor).join() === accent;
    return { key: key(element), where: where(element), ring };
  }

  (window as unknown as { audits: object }).audits = { textContrast, edgeContrast, strayColours, nativeLooks, tabbable, focused };
}
