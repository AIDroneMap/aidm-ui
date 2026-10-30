export interface BasemapSettings {
  enabled: boolean;
  url: string;
  scheme: "xyz" | "tms";
  attribution: string;
}

export const DEFAULT_BASEMAP: BasemapSettings = {
  enabled: false,
  url: "",
  scheme: "xyz",
  attribution: "",
};

function templateOrigin(url: string): string | null {
  if (url.length > 4096 || !/^https?:\/\//i.test(url) || /[\s\u0000-\u001f\u007f\\#]/u.test(url)) return null;
  if (!["{z}", "{x}", "{y}"].every((token) => url.includes(token))) return null;
  const substituted = url.replace(/\{[zxy]\}/g, "0");
  if (/[{}]/.test(substituted)) return null;
  const authority = url.slice(url.indexOf("//") + 2).split(/[/?]/, 1)[0] ?? "";
  if (authority.includes("@") || /[{}]/.test(authority)) return null;
  try {
    const parsed = new URL(substituted);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      /^[a-z0-9.:[\]-]+$/i.test(parsed.hostname) ? parsed.origin : null;
  } catch {
    return null;
  }
}

export function isBasemapSettings(value: unknown): value is BasemapSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.enabled !== "boolean" || typeof candidate.url !== "string" ||
      (candidate.scheme !== "xyz" && candidate.scheme !== "tms") ||
      typeof candidate.attribution !== "string" || candidate.attribution.length > 512 ||
      /[\u0000-\u001f\u007f\u2028\u2029]/u.test(candidate.attribution)) return false;
  return candidate.url === "" ? !candidate.enabled : templateOrigin(candidate.url) !== null;
}

export function basemapOrigin(value: BasemapSettings): string | null {
  return isBasemapSettings(value) && value.enabled ? templateOrigin(value.url) : null;
}
