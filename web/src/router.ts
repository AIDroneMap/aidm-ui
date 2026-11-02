import { useSyncExternalStore } from "react";

/** The six screens of a project's workspace, in the order the sidebar lists them. */
export const SECTIONS = ["photos", "settings", "review", "runs", "results", "details"] as const;
export type Section = (typeof SECTIONS)[number];

/** The five wizard screens, in order. Each has its own address so the back button and a link from Preferences work. */
export const WIZARD_STEPS = ["welcome", "check", "engine", "install", "sample"] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

export type Viewer = "map" | "model";

export type Route =
  | { screen: "projects" }
  | { screen: "project"; projectId: number; section: Section; runId?: number; viewer?: Viewer }
  | { screen: "run"; runId: number }
  | { screen: "engines" }
  | { screen: "preferences" }
  | { screen: "wizard"; step: WizardStep };

export type Screen = Route["screen"];

const WIZARD_HASH: Record<WizardStep, string> = {
  welcome: "#/wizard",
  check: "#/wizard/check",
  engine: "#/wizard/engine",
  install: "#/wizard/install",
  sample: "#/wizard/sample",
};

export function wizardHash(step: WizardStep): string {
  return WIZARD_HASH[step];
}

/** The wizard screen an address points at, or null when it is not a wizard address. */
export function wizardStepFromHash(hash: string): WizardStep | null {
  return WIZARD_STEPS.find((step) => WIZARD_HASH[step] === hash) ?? null;
}

export function sectionHash(projectId: number, section: Section): string {
  return `#/projects/${projectId}/${section}`;
}

export function resultsHash(projectId: number, runId: number, viewer?: Viewer): string {
  return `#/projects/${projectId}/results/${runId}${viewer ? `/${viewer}` : ""}`;
}

/**
 * Every address of the route map in docs/proposals/0001-desktop-class-interface.md,
 * section 3, with the screen it opens. The router test and the sidebar journey
 * both walk this list, so an address cannot be added or lost unnoticed.
 */
export const ROUTE_MAP: ReadonlyArray<{ hash: string; route: Route }> = [
  { hash: "#/", route: { screen: "projects" } },
  { hash: "#/projects/7/photos", route: { screen: "project", projectId: 7, section: "photos" } },
  { hash: "#/projects/7/settings", route: { screen: "project", projectId: 7, section: "settings" } },
  { hash: "#/projects/7/review", route: { screen: "project", projectId: 7, section: "review" } },
  { hash: "#/projects/7/runs", route: { screen: "project", projectId: 7, section: "runs" } },
  { hash: "#/runs/9", route: { screen: "run", runId: 9 } },
  { hash: "#/projects/7/results", route: { screen: "project", projectId: 7, section: "results" } },
  { hash: "#/projects/7/results/9", route: { screen: "project", projectId: 7, section: "results", runId: 9 } },
  { hash: "#/projects/7/results/9/map", route: { screen: "project", projectId: 7, section: "results", runId: 9, viewer: "map" } },
  { hash: "#/projects/7/results/9/model", route: { screen: "project", projectId: 7, section: "results", runId: 9, viewer: "model" } },
  { hash: "#/projects/7/details", route: { screen: "project", projectId: 7, section: "details" } },
  { hash: "#/engines", route: { screen: "engines" } },
  { hash: "#/preferences", route: { screen: "preferences" } },
  ...WIZARD_STEPS.map((step) => ({ hash: WIZARD_HASH[step], route: { screen: "wizard", step } as Route })),
];

const ID = "([1-9]\\d{0,14})";
const PROJECT = new RegExp(`^#/projects/${ID}/(${SECTIONS.join("|")})$`);
const RESULTS = new RegExp(`^#/projects/${ID}/results/${ID}(?:/(map|model))?$`);
const RUN = new RegExp(`^#/runs/${ID}$`);

export function routeFromHash(hash: string): Route {
  const step = wizardStepFromHash(hash);
  if (step !== null) return { screen: "wizard", step };
  const project = PROJECT.exec(hash);
  if (project) return { screen: "project", projectId: Number(project[1]), section: project[2] as Section };
  const results = RESULTS.exec(hash);
  if (results) {
    const route: Route = { screen: "project", projectId: Number(results[1]), section: "results", runId: Number(results[2]) };
    return results[3] ? { ...route, viewer: results[3] as Viewer } : route;
  }
  const run = RUN.exec(hash);
  if (run) return { screen: "run", runId: Number(run[1]) };
  if (hash === "#/engines") return { screen: "engines" };
  if (hash === "#/preferences") return { screen: "preferences" };
  return { screen: "projects" };
}

/**
 * The new address for an address that earlier versions used, so saved links
 * keep working. Null when the address is current. `#/sample` is not here:
 * where it goes depends on the server, so the shell resolves it.
 */
export function redirectFromHash(hash: string): string | null {
  const project = new RegExp(`^#/projects/${ID}$`).exec(hash);
  if (project) return sectionHash(Number(project[1]), "photos");
  if (hash === "#/projects/new") return "#/";
  if (hash === "#/settings") return "#/preferences";
  return null;
}

export const SAMPLE_HASH = "#/sample";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

function currentHash(): string {
  return window.location.hash;
}

/** The address after the hash sign. The route is derived from it, so a re-render never sees a new object for the same address. */
export function useHash(): string {
  return useSyncExternalStore(subscribe, currentHash, () => "#/");
}

export function useRoute(): Route {
  const hash = useHash();
  return routeFromHash(hash);
}

export function useWizardStep(): WizardStep {
  return useSyncExternalStore(
    subscribe,
    () => wizardStepFromHash(window.location.hash) ?? "welcome",
    () => "welcome",
  );
}
