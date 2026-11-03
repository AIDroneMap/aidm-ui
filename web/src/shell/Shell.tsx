import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import type { ProjectView } from "../../../shared/api-types.ts";
import { IconButton } from "../controls/IconButton.tsx";
import { NavItem, NavSection, Sidebar } from "../controls/Sidebar.tsx";
import {
  IconClipboardCheck,
  IconCpu,
  IconFolder,
  IconImages,
  IconInfo,
  IconLoaderCircle,
  IconMap,
  IconMenu,
  IconPlay,
  IconSettings,
  IconSlidersHorizontal,
  IconX,
} from "../icons/icons.tsx";
import { t } from "../i18n/translate.ts";
import { projectName } from "../pages/ProjectsPage.tsx";
import { sectionHash, type Route, type Section } from "../router.ts";
import { PAGE_VERSION } from "../version.ts";
import { useEngineDot, type EngineDot } from "./engine-dot.ts";
import { runActive } from "./useWorkspaceProject.ts";
import "./shell.css";

/** The section the sidebar marks as current. A run belongs to its project's Runs section. */
function currentSection(route: Route): Section | null {
  if (route.screen === "project") return route.section;
  return route.screen === "run" ? "runs" : null;
}

function ProjectItems({ project, route }: { project: ProjectView; route: Route }) {
  const current = currentSection(route);
  const item = (section: Section, icon: ReactElement, extra: { badge?: ReactNode; badgeLabel?: string } = {}) => (
    <NavItem key={section} href={sectionHash(project.id, section)} icon={icon} label={t(`nav.${section}`)} current={current === section} {...extra} />
  );
  const photos = project.photoCount ?? 0;
  const results = project.resultArchives?.length ?? 0;
  return (
    <>
      <NavSection title={projectName(project)}>
        {item("photos", <IconImages />, photos > 0 ? { badge: photos, badgeLabel: t("nav.photos_badge", { count: photos }) } : {})}
        {item("settings", <IconSlidersHorizontal />)}
        {item("review", <IconClipboardCheck />)}
        {item("runs", <IconPlay />, runActive(project) ? { badge: <IconLoaderCircle className="shell-spinner" />, badgeLabel: t("nav.runs_active") } : {})}
        {item("results", <IconMap />, results > 0 ? { badge: results, badgeLabel: t("nav.results_badge", { count: results }) } : {})}
      </NavSection>
      <NavSection>{item("details", <IconInfo />)}</NavSection>
    </>
  );
}

type Props = {
  route: Route;
  /** The open project, once it has loaded. The sidebar shows its sections only then. */
  project: ProjectView | null;
  /** The viewers take the whole width; every other screen keeps a readable line length. */
  wide?: boolean;
  /** The dot beside Engines, for a test; null hides it. Left out, the dot follows the server's engine list. */
  engineDot?: EngineDot | null;
  children: ReactNode;
};

/**
 * The application around every screen but the wizard and the login: the
 * sidebar and the content. Below 64 rem the sidebar keeps its icons; on a
 * tablet held upright it hides behind a menu button and slides over the
 * content, so nothing scrolls sideways.
 */
export function Shell({ route, project, wide, engineDot: given, children }: Props) {
  const live = useEngineDot();
  const engineDot = given === undefined ? live : given;
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLButtonElement>(null);
  const nav = useRef<HTMLDivElement>(null);
  const address = JSON.stringify(route);

  // Following a link closes the menu.
  useEffect(() => setOpen(false), [address]);

  useEffect(() => {
    if (!open) return;
    nav.current?.querySelector<HTMLElement>("a")?.focus();
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      menu.current?.focus();
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [open]);

  return (
    <div className="shell" data-menu={open ? "open" : "closed"}>
      <div className="shell-bar">
        <IconButton
          ref={menu}
          label={t(open ? "nav.close" : "nav.open")}
          icon={open ? <IconX /> : <IconMenu />}
          aria-expanded={open}
          aria-controls="shell-nav"
          onClick={() => setOpen(!open)}
        />
        <span className="shell-bar-name">{t("app.name")}</span>
      </div>
      <div className="shell-nav" id="shell-nav" ref={nav}>
        <Sidebar label={t("nav.label")} expanded={open} header={<span title={t("nav.version", { version: PAGE_VERSION })}>{t("app.name")}</span>}>
          <NavSection>
            <NavItem href="#/" icon={<IconFolder />} label={t("nav.projects")} current={route.screen === "projects"} />
            <NavItem
              href="#/engines"
              icon={<IconCpu />}
              label={t("nav.engines")}
              current={route.screen === "engines"}
              {...(engineDot === null ? {} : { badge: <span className={`shell-engine-dot shell-engine-dot-${engineDot}`} />, badgeLabel: t(`nav.engines_${engineDot}`) })}
            />
            <NavItem href="#/preferences" icon={<IconSettings />} label={t("nav.preferences")} current={route.screen === "preferences"} />
          </NavSection>
          {project && <ProjectItems project={project} route={route} />}
        </Sidebar>
      </div>
      {open && <div className="shell-backdrop" onClick={() => setOpen(false)} />}
      <main className={wide ? "shell-main shell-main-wide" : "shell-main"}>{children}</main>
    </div>
  );
}
