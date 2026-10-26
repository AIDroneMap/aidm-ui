import { t } from "../i18n/translate.ts";

/**
 * A plain link to the NVIDIA setup guide. Nothing is fetched from it; the
 * operator follows it if they want to. Only an https address is a link.
 */
export function GuideLink({ url }: { url: unknown }) {
  if (typeof url !== "string" || !url.startsWith("https://")) return null;
  return (
    <a href={url} target="_blank" rel="noreferrer noopener">
      {t("wizard.install.gpu.guide")}
    </a>
  );
}
