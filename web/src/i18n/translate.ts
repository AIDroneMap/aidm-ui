import en from "./en.json";

export type MessageKey = keyof typeof en;

const messages: Record<string, string> = en;

// Returns the operator-visible text for a key, with {name} placeholders
// replaced from params. An unknown key is returned as is, so a missing
// translation shows up on screen instead of failing silently.
export function t(key: MessageKey | string, params: Record<string, string | number> = {}): string {
  const template = messages[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}
