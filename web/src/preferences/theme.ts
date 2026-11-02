/**
 * The theme override. The interface follows the device's light or dark
 * setting; the operator may fix one instead. The choice belongs to the
 * device, so it is kept in this browser and never sent to the server.
 */
export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

export const THEME_KEY = "aidm-ui.theme";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;
type Root = Pick<Element, "setAttribute" | "removeAttribute">;

function browserStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The kept choice, or "system" when there is none or the browser refuses storage. */
export function storedTheme(storage: Storage | null = browserStorage()): Theme {
  try {
    const value = storage?.getItem(THEME_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

/** Fixes the page to light or dark, or lets it follow the device. tokens.css reads the attribute. */
export function applyTheme(theme: Theme, root: Root = document.documentElement): void {
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

/** Applies a choice and keeps it. The page changes even when the browser cannot keep it. */
export function chooseTheme(theme: Theme, storage: Storage | null = browserStorage(), root: Root = document.documentElement): void {
  applyTheme(theme, root);
  try {
    if (theme === "system") storage?.removeItem(THEME_KEY);
    else storage?.setItem(THEME_KEY, theme);
  } catch {
    // Private windows may refuse storage. The choice then lasts until the page closes.
  }
}
