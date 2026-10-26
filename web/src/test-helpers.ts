import en from "./i18n/en.json";

const entities: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#x27;": "'",
};

function decode(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#x27);/g, (whole) => entities[whole] ?? whole);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A translation with its {placeholders} turned into a pattern that matches any value.
function pattern(template: string): RegExp {
  const source = template
    .split(/\{\w+\}/)
    .map(escapeRegExp)
    .join(".+?");
  return new RegExp(`^${source}$`);
}

const patterns = Object.values(en).map(pattern);

export function textNodes(html: string): string[] {
  return [...html.matchAll(/>([^<]+)</g)]
    .map((match) => decode(match[1] ?? "").trim())
    .filter(Boolean);
}

/** Text nodes that are neither a translation nor one of the data strings the test passed in. */
export function untranslatedText(html: string, data: string[] = []): string[] {
  return textNodes(html).filter(
    (text) => !data.includes(text) && !patterns.some((regex) => regex.test(text)),
  );
}

/** Ids of inputs that no label points at with for="id". */
export function unlabelledInputs(html: string): string[] {
  const missing: string[] = [];
  for (const match of html.matchAll(/<input\b[^>]*>/g)) {
    const id = /\bid="([^"]*)"/.exec(match[0])?.[1];
    if (!id || !html.includes(`for="${id}"`)) missing.push(id ?? match[0]);
  }
  return missing;
}
