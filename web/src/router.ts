import { useSyncExternalStore } from "react";

export type Route = "home" | "engines" | "sample" | "settings" | "wizard";

/** The five wizard screens, in order. Each has its own address so the back button and a link from settings work. */
export const WIZARD_STEPS = ["welcome", "check", "engine", "install", "sample"] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

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

export function routeFromHash(hash: string): Route {
  if (wizardStepFromHash(hash) !== null) return "wizard";
  if (hash === "#/settings") return "settings";
  if (hash === "#/sample") return "sample";
  return hash === "#/engines" ? "engines" : "home";
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

export function useRoute(): Route {
  return useSyncExternalStore(
    subscribe,
    () => routeFromHash(window.location.hash),
    () => "home",
  );
}

export function useWizardStep(): WizardStep {
  return useSyncExternalStore(
    subscribe,
    () => wizardStepFromHash(window.location.hash) ?? "welcome",
    () => "welcome",
  );
}
