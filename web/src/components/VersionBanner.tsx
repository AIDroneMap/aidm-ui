import { t } from "../i18n/translate.ts";
import { PAGE_VERSION, pageEntry, pageIsStale, useServerBuild, type BuildStamp } from "../version.ts";

export interface VersionBannerProps {
  page: BuildStamp;
  /** The build the server reports, or null while it is not known. */
  server: BuildStamp | null;
  onReload: () => void;
}

/** Asks for a reload when the server is another build than the page. Nothing otherwise. */
export function VersionBanner({ page, server, onReload }: VersionBannerProps) {
  if (!pageIsStale(page, server)) return null;
  return (
    <div className="version-banner" role="alert">
      <p>{t("app.version_changed")}</p>
      <button type="button" onClick={onReload}>
        {t("app.reload")}
      </button>
    </div>
  );
}

/** The banner with its source: the build this page was loaded as, and the one the server reports. */
export function VersionWatch() {
  const server = useServerBuild();
  return <VersionBanner page={{ version: PAGE_VERSION, entry: pageEntry() }} server={server} onReload={() => window.location.reload()} />;
}
